/**
 * Vercel deployment verification.
 *
 * A hosting config is usually only tested by deploying, which means the first attempt
 * is the test. This checks what can be checked without an account:
 *
 *   1. the config is internally sound, and every key is one Vercel actually supports
 *      (validated against Vercel's published schema when the network allows)
 *   2. the exact commands Vercel will run produce the exact directory it will serve,
 *      executed in a pristine copy of the repository rather than this working tree
 *   3. every header rule matches something real, and no path can receive two different
 *      Cache-Control values, so the result does not depend on Vercel's merge order
 *
 * What it cannot check is Vercel's own infrastructure. That needs a token.
 *
 * Run: node scripts/verify-vercel.mjs
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SIM = join(ROOT, 'tmp', 'vercel-sim');
const CONFIG_PATH = join(ROOT, 'vercel.json');

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

if (!existsSync(CONFIG_PATH)) {
  console.error('vercel.json is missing.');
  process.exit(1);
}
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/** Vercel sources are path-to-regexp; only the `(.*)` form is used here. */
function sourceToRegExp(source) {
  const escaped = source
    .split('(.*)')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(.*)');
  return new RegExp(`^${escaped}$`);
}

console.log('=== 1. The config is internally sound ===');
{
  check('buildCommand is declared', typeof config.buildCommand === 'string');
  check('outputDirectory is declared', typeof config.outputDirectory === 'string');

  // Vercel runs its own install step before the build. Left to itself it runs a plain
  // `pnpm install`, which exits non-zero in this repository over an unapproved
  // dependency build script and fails the deployment before the build starts.
  check(
    'installCommand is pinned and ignores dependency build scripts',
    typeof config.installCommand === 'string' && config.installCommand.includes('--ignore-scripts'),
    config.installCommand ?? '(not set)'
  );

  check(
    'trailingSlash matches the export',
    config.trailingSlash === true,
    'the Next export writes routes as directories'
  );

  const rules = config.headers ?? [];
  check(`header rules present (${rules.length})`, rules.length >= 3);
  check(
    'every rule has a source and at least one header',
    rules.every((r) => typeof r.source === 'string' && Array.isArray(r.headers) && r.headers.length > 0)
  );

  const csp = rules
    .flatMap((r) => r.headers)
    .find((h) => h.key === 'Content-Security-Policy')?.value;
  check('a CSP is defined', Boolean(csp));
  if (csp) {
    // The three directives the app cannot run without. Tightening any of them breaks
    // the worker or the object URLs used for previews and downloads, which the browser
    // suite catches because it serves this same file.
    check("CSP allows the module worker", csp.includes("worker-src 'self'"), csp);
    check('CSP allows blob: for previews and downloads', csp.includes('blob:'));
    check("CSP forbids plugins (object-src 'none')", csp.includes("object-src 'none'"));
  }
}

console.log('\n=== 2. Every key is one Vercel supports ===');
{
  let schema = null;
  try {
    const response = await fetch('https://openapi.vercel.sh/vercel.json', {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) schema = await response.json();
  } catch {
    // Left null; reported as a skip below.
  }

  if (!schema?.properties) {
    console.log("  - Vercel's schema was not reachable, skipping this section");
  } else {
    const known = Object.keys(schema.properties);
    const unknown = Object.keys(config).filter((key) => !known.includes(key));
    check(
      `all ${Object.keys(config).length} top-level keys exist in Vercel's schema`,
      unknown.length === 0,
      unknown.join(', ')
    );
    // A misspelled key is silently ignored by Vercel, so the failure mode is a deploy
    // that succeeds with the setting missing.
    for (const key of ['installCommand', 'buildCommand', 'outputDirectory', 'headers', 'trailingSlash']) {
      check(`${key} is spelled the way Vercel reads it`, known.includes(key));
    }
  }
}

console.log('\n=== 3. Vercel\'s commands, run against a pristine copy ===');
rmSync(SIM, { recursive: true, force: true });
mkdirSync(SIM, { recursive: true });

// `git archive` gives exactly the tracked files at HEAD, which is what the host clones.
// An earlier version of this used tar with an exclude list and forgot packages/core/dist,
// so the working tree's compiled engine was copied in and a build that could never have
// worked on a fresh clone passed here. Asking git what it tracks removes the chance to
// forget something.
if (execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim()) {
  console.log('  ! working tree is dirty; HEAD is what gets tested, as on the host');
}
execSync(`git archive HEAD | (cd ${JSON.stringify(SIM)} && tar -xf -)`, {
  cwd: ROOT,
  shell: '/bin/bash',
  stdio: 'inherit',
});

// Asserted rather than assumed, so this harness cannot quietly regress into testing
// leftovers again.
for (const leftover of ['node_modules', 'packages/core/dist', 'apps/web/.next', 'apps/web/out']) {
  check(`the copy has no ${leftover}`, !existsSync(join(SIM, leftover)));
}

const outputDirectory = join(SIM, config.outputDirectory);
let built = false;
for (const [label, command] of [
  ['installCommand', config.installCommand],
  ['buildCommand', config.buildCommand],
]) {
  if (!command) continue;
  const started = Date.now();
  try {
    execSync(command, {
      cwd: SIM,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true' },
      timeout: 900_000,
    });
    check(`${label} succeeds (${((Date.now() - started) / 1000).toFixed(0)}s): ${command}`, true);
    built = true;
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    check(`${label} succeeds: ${command}`, false, output.slice(-700));
    built = false;
    break;
  }
}

if (built) {
  check(`outputDirectory exists: ${config.outputDirectory}`, existsSync(outputDirectory));
}

console.log('\n=== 4. The served directory is complete ===');
let servablePaths = [];
if (built && existsSync(outputDirectory)) {
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push('/' + posix.join(...relative(outputDirectory, full).split('/')));
    }
  })(outputDirectory);

  for (const required of ['/index.html', '/studio/index.html', '/404.html']) {
    check(`ships ${required}`, files.includes(required));
  }
  check('ships the measured sample images', files.some((f) => f.startsWith('/samples/')));
  check(
    'ships the engine as a separate chunk',
    files.some((f) => f.startsWith('/_next/static/chunks/') && f.endsWith('.js'))
  );

  // trailingSlash means these are the paths a visitor requests; the files above are
  // what the host resolves them to.
  servablePaths = [...files, '/', '/studio/'];
}

console.log('\n=== 5. Header rules match reality ===');
if (servablePaths.length > 0) {
  for (const rule of config.headers ?? []) {
    const regex = sourceToRegExp(rule.source);
    const hits = servablePaths.filter((path) => regex.test(path));
    check(
      `${rule.source} matches something that exists (${hits.length})`,
      hits.length > 0,
      'a rule matching nothing is a rule that does nothing'
    );
  }

  // Non-overlapping cache rules mean the outcome does not depend on how Vercel merges
  // rules that both match. Overlap here was a real defect: the HTML rule was written
  // for /index.html, which no visitor requests once trailingSlash is on.
  const conflicts = [];
  for (const path of servablePaths) {
    const values = new Set(
      (config.headers ?? [])
        .filter((rule) => sourceToRegExp(rule.source).test(path))
        .flatMap((rule) => rule.headers)
        .filter((header) => header.key === 'Cache-Control')
        .map((header) => header.value)
    );
    if (values.size > 1) conflicts.push(`${path} -> ${[...values].join(' | ')}`);
  }
  check(
    'no path receives conflicting Cache-Control values',
    conflicts.length === 0,
    conflicts.slice(0, 3).join('; ')
  );

  const uncached = servablePaths.filter(
    (path) =>
      !(config.headers ?? []).some(
        (rule) =>
          sourceToRegExp(rule.source).test(path) &&
          rule.headers.some((header) => header.key === 'Cache-Control')
      )
  );
  check(
    'every served path has a Cache-Control rule',
    uncached.length === 0,
    uncached.slice(0, 5).join(', ')
  );
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
