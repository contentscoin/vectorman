/**
 * Container verification.
 *
 * A successful `docker build` proves nothing about whether the server works. This
 * builds the image, then speaks MCP to a running container over stdio exactly as a
 * client would, converts a real image through a mounted volume, and confirms the
 * output lands back on the host.
 *
 * It also checks the two properties that are easy to get wrong and invisible until
 * production: that the process is not root, and that the image ships build output
 * rather than sources.
 *
 * Skips cleanly when no Docker daemon is reachable, so it can sit in `verify:all`
 * without making an unrelated environment fail.
 *
 * Run: node scripts/verify-docker.mjs
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const IMAGE = process.env.PV_IMAGE ?? 'perfectvector/mcp:0.1.0';
const WORK = join(ROOT, 'tmp', 'docker-work');
const FIXTURE = join(ROOT, 'tmp', 'fixtures', 'logo.png');

const require = createRequire(join(ROOT, 'packages', 'mcp', 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks++;
  if (condition) console.log(`  \u2713 ${label}`);
  else {
    failures++;
    console.log(`  \u2717 ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

try {
  docker(['version', '--format', '{{.Server.Version}}']);
} catch {
  console.log('No Docker daemon reachable -- skipping container verification.');
  process.exit(0);
}

if (!existsSync(FIXTURE)) {
  console.error(`Fixture missing: ${FIXTURE}\nRun: pnpm run fixtures`);
  process.exit(1);
}

console.log('=== 1. Build the image ===');
try {
  docker(['build', '-f', 'packages/mcp/Dockerfile', '-t', IMAGE, '.'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  check(`image builds (${IMAGE})`, true);
} catch (error) {
  check(`image builds (${IMAGE})`, false, String(error.stderr ?? error.message).slice(-600));
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(1);
}

console.log('\n=== 2. Image hygiene ===');
{
  const size = docker(['image', 'inspect', IMAGE, '--format', '{{.Size}}']).trim();
  const mb = Number(size) / 1_000_000;
  console.log(`  image size: ${mb.toFixed(0)} MB`);
  // A Debian-slim Node image is ~200MB before anything is added; this only guards
  // against accidentally shipping the whole monorepo or a build cache.
  check('image is not bloated (< 600 MB)', mb < 600, `${mb.toFixed(0)} MB`);

  const whoami = docker(['run', '--rm', '--entrypoint', 'id', IMAGE, '-u']).trim();
  check(`runs as an unprivileged user (uid ${whoami})`, whoami !== '0');

  const listing = docker([
    'run', '--rm', '--entrypoint', 'sh', IMAGE,
    '-c', 'ls /app/node_modules/@perfectvector/mcp',
  ]);
  check('ships dist', listing.includes('dist'));
  check('does not ship src', !listing.split('\n').includes('src'));

  const shebang = docker([
    'run', '--rm', '--entrypoint', 'head', IMAGE,
    '-n', '1', '/app/node_modules/@perfectvector/mcp/dist/server.js',
  ]).trim();
  check('entry file keeps its shebang', shebang === '#!/usr/bin/env node');
}

console.log('\n=== 3. Speak MCP to a running container ===');
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
copyFileSync(FIXTURE, join(WORK, 'logo.png'));

// The image runs as uid 1000 by design, and this harness creates the directory as
// root, so the container could read the mount but not write to it. A real user mounts
// a directory they own; widening it here reproduces that rather than testing the
// harness's own permissions.
chmodSync(WORK, 0o777);

// `:z` relabels the mount for SELinux, which is enforcing on this host; without it
// the container cannot read the bind mount at all.
const transport = new StdioClientTransport({
  command: 'docker',
  args: ['run', '--rm', '-i', '-v', `${WORK}:/work:z`, IMAGE],
  stderr: 'pipe',
});
const client = new Client({ name: 'pv-docker-verify', version: '0.1.0' });

let stderrText = '';
try {
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => (stderrText += chunk));
  check('client completes the MCP handshake with the container', true);

  const { tools } = await client.listTools();
  check(`all seven tools exposed (${tools.length})`, tools.length === 7);

  const { resources } = await client.listResources();
  check(`both resources exposed (${resources.length})`, resources.length === 2);

  const result = await client.callTool({
    name: 'vectorize_image',
    arguments: { path: '/work/logo.png', outputPath: '/work/logo.svg' },
  });
  const text = (result.content ?? []).map((c) => c.text).join('\n');
  const structured = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);

  // Same numbers as the source build and the packed tarball. The engine is
  // deterministic, so any difference means the image is running other code.
  check(`colors match (${structured.stats.colors})`, structured.stats.colors === 4);
  check(`pieces match (${structured.stats.pieces})`, structured.stats.pieces === 4);
  check(`nodes match (${structured.stats.nodes})`, structured.stats.nodes === 34);
  check(
    `pre-fitting nodes match (${structured.stats.nodesBeforeFitting})`,
    structured.stats.nodesBeforeFitting === 1396
  );

  // Proves the mount is writable from the container and the path mapping is right.
  const hostOutput = join(WORK, 'logo.svg');
  check('SVG written through the volume to the host', existsSync(hostOutput));
  if (existsSync(hostOutput)) {
    const svg = readFileSync(hostOutput, 'utf8');
    check('host file is a real SVG', svg.startsWith('<svg') && svg.includes('</svg>'));
    check('and carries the traced geometry', (svg.match(/<path/g) ?? []).length === 4);
  }

  // A refusal has to survive the container boundary too, since it is carried as
  // tool-level content rather than a transport error.
  const photo = join(ROOT, 'tmp', 'fixtures', 'photo.jpg');
  if (existsSync(photo)) {
    copyFileSync(photo, join(WORK, 'photo.jpg'));
    const refusal = await client.callTool({
      name: 'vectorize_image',
      arguments: { path: '/work/photo.jpg' },
    });
    const refusalText = (refusal.content ?? []).map((c) => c.text).join('\n').toLowerCase();
    check(
      'photograph is still refused inside the container',
      refusal.isError === true || refusalText.includes('photograph') || refusalText.includes('redraw'),
      refusalText.slice(0, 160)
    );
  }
} catch (error) {
  check('container conversation succeeds', false, `${error.message} | stderr: ${stderrText.slice(-300)}`);
} finally {
  await client.close().catch(() => {});
}

console.log('\n=== 4. An unwritable mount fails clearly, not fatally ===');
{
  // Running unprivileged means write failures are a normal operating condition, so
  // they have to arrive as a readable tool error rather than a crash or a stack trace.
  const roTransport = new StdioClientTransport({
    command: 'docker',
    args: ['run', '--rm', '-i', '-v', `${WORK}:/work:z,ro`, IMAGE],
    stderr: 'pipe',
  });
  const roClient = new Client({ name: 'pv-docker-verify-ro', version: '0.1.0' });
  try {
    await roClient.connect(roTransport);
    const result = await roClient.callTool({
      name: 'vectorize_image',
      arguments: { path: '/work/logo.png', outputPath: '/work/denied.svg' },
    });
    const text = (result.content ?? []).map((c) => c.text).join('\n');

    check('the write is reported as a tool error', result.isError === true, text.slice(0, 200));
    check(
      'the message names the cause',
      /permission|read-only|EACCES|EROFS/i.test(text),
      text.slice(0, 200)
    );
    check('and it is a message, not a stack trace', !text.includes('at ') && text.length < 300);

    // The server must still be usable afterwards; one bad path should not end the session.
    const after = await roClient.callTool({
      name: 'vectorize_image',
      arguments: { path: '/work/logo.png' },
    });
    const afterText = (after.content ?? []).map((c) => c.text).join('\n');
    check('the session survives and can still convert', /```json/.test(afterText));
  } catch (error) {
    check('read-only mount handled', false, error.message);
  } finally {
    await roClient.close().catch(() => {});
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
