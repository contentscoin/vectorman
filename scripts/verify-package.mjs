/**
 * Publishability check.
 *
 * Packs both packages, installs the tarballs into a clean directory with npm, and
 * drives the installed binary over stdio. The point is to test what a user actually
 * receives rather than what the repository looks like — the two differ in ways that
 * are invisible until someone tries to install it.
 *
 * The specific trap this exists to catch: `npm pack` leaves `"@perfectvector/core":
 * "workspace:*"` in the published manifest. `workspace:` is a pnpm-only protocol, so
 * the tarball is unresolvable from a registry and `npx @perfectvector/mcp` fails at
 * install time. `pnpm pack` substitutes the real version. Nothing in a normal build,
 * typecheck or test run notices the difference.
 *
 * Run: node scripts/verify-package.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const PACK_DIR = join(ROOT, 'tmp', 'pack');
const INSTALL_DIR = join(ROOT, 'tmp', 'pack-install');
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

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** List the files inside a tarball. */
function tarList(tarball) {
  return run('tar', ['-tzf', tarball], ROOT).split('\n').filter(Boolean);
}

/** Read one file out of a tarball without extracting it. */
function tarRead(tarball, path) {
  return run('tar', ['-xzOf', tarball, path], ROOT);
}

if (!existsSync(FIXTURE)) {
  console.error(`Fixture missing: ${FIXTURE}\nRun: pnpm run fixtures`);
  process.exit(1);
}

console.log('=== 1. Pack both packages ===');
rmSync(PACK_DIR, { recursive: true, force: true });
mkdirSync(PACK_DIR, { recursive: true });

for (const pkg of ['core', 'mcp']) {
  run('pnpm', ['pack', '--pack-destination', PACK_DIR], join(ROOT, 'packages', pkg));
}

const coreTarball = join(PACK_DIR, 'perfectvector-core-0.1.0.tgz');
const mcpTarball = join(PACK_DIR, 'perfectvector-mcp-0.1.0.tgz');

check('core tarball produced', existsSync(coreTarball));
check('mcp tarball produced', existsSync(mcpTarball));

console.log('\n=== 2. The published manifest must be resolvable ===');
{
  const manifest = JSON.parse(tarRead(mcpTarball, 'package/package.json'));
  const deps = manifest.dependencies ?? {};

  // The whole reason this script exists.
  const workspaceRefs = Object.entries(deps).filter(([, range]) => String(range).startsWith('workspace:'));
  check(
    'no workspace: protocol survives into the tarball',
    workspaceRefs.length === 0,
    workspaceRefs.map(([name, range]) => `${name}@${range}`).join(', ')
  );
  check(
    `core is pinned to a real version (${deps['@perfectvector/core']})`,
    /^\d+\.\d+\.\d+$/.test(String(deps['@perfectvector/core'] ?? ''))
  );
  check('declares its bin', Boolean(manifest.bin?.['perfectvector-mcp']));
  check('is ESM', manifest.type === 'module');
}

console.log('\n=== 3. Tarballs ship build output, not sources ===');
{
  for (const [name, tarball] of [['core', coreTarball], ['mcp', mcpTarball]]) {
    const files = tarList(tarball);
    check(`${name}: contains compiled dist`, files.some((f) => /^package\/dist\/.+\.js$/.test(f)));
    check(`${name}: contains type declarations`, files.some((f) => /^package\/dist\/.+\.d\.ts$/.test(f)));
    // Shipping src doubles the download for no benefit; sourcemaps already point at it.
    check(`${name}: excludes src`, !files.some((f) => f.startsWith('package/src/')), files.filter((f) => f.startsWith('package/src/')).slice(0, 3).join(', '));
  }
  const mcpFiles = tarList(mcpTarball);
  check(
    'mcp ships the pool worker, not just the server',
    mcpFiles.includes('package/dist/batch-worker.js'),
  );
}

console.log('\n=== 4. Install the tarballs into a clean project ===');
rmSync(INSTALL_DIR, { recursive: true, force: true });
mkdirSync(INSTALL_DIR, { recursive: true });
writeFileSync(
  join(INSTALL_DIR, 'package.json'),
  JSON.stringify({ name: 'pv-install-test', version: '1.0.0', private: true }, null, 2)
);

let installed = false;
try {
  // Both at once so npm satisfies mcp's dependency on core from the local tarball
  // rather than reaching for a registry that has never seen it.
  run('npm', ['install', '--no-audit', '--no-fund', coreTarball, mcpTarball], INSTALL_DIR);
  installed = true;
} catch (error) {
  const message = String(error.stderr ?? error.message ?? error);
  check('npm install succeeds', false, message.split('\n').slice(0, 4).join(' | '));
}

if (installed) {
  check('npm install succeeds', true);

  const binPath = join(INSTALL_DIR, 'node_modules', '.bin', 'perfectvector-mcp');
  check('bin is linked', existsSync(binPath));
  if (existsSync(binPath)) {
    // npm sets the exec bit from the shebang; without it the bin cannot be spawned.
    check('bin is executable', (statSync(binPath).mode & 0o111) !== 0);
  }
  check(
    'core resolved from the local tarball',
    existsSync(join(INSTALL_DIR, 'node_modules', '@perfectvector', 'core', 'dist', 'index.js'))
  );
  check(
    'sharp installed with a native binary',
    existsSync(join(INSTALL_DIR, 'node_modules', 'sharp'))
  );

  console.log('\n=== 5. Drive the installed binary over stdio ===');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(INSTALL_DIR, 'node_modules', '@perfectvector', 'mcp', 'dist', 'server.js')],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pv-package-verify', version: '0.1.0' });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    check(`all seven tools available from the installed package (${tools.length})`, tools.length === 7);

    const outputPath = join(INSTALL_DIR, 'logo.svg');
    const result = await client.callTool({
      name: 'vectorize_image',
      arguments: { path: FIXTURE, outputPath },
    });
    const text = (result.content ?? []).map((c) => c.text).join('\n');
    const structured = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]);

    check('conversion runs from the packed engine', structured.stats.colors === 4, JSON.stringify(structured.stats));
    check('and writes a real SVG', existsSync(outputPath) && readFileSync(outputPath, 'utf8').startsWith('<svg'));

    // The engine is deterministic, so the packed build must reproduce the source
    // build exactly. Anything else means the tarball shipped different code than
    // the one the rest of the suites verified.
    const { pieces, nodes, nodesBeforeFitting } = structured.stats;
    check(`pieces match the source build (${pieces})`, pieces === 4);
    check(`node count matches the source build (${nodes})`, nodes === 34);
    check(
      `pre-fitting node count matches the source build (${nodesBeforeFitting})`,
      nodesBeforeFitting === 1396
    );
  } finally {
    await client.close().catch(() => {});
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`Tarballs in ${PACK_DIR}`);
if (failures > 0) process.exit(1);
