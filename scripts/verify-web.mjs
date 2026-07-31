/**
 * End-to-end browser verification.
 *
 * Starts the production build, drives it with a real headless Chromium, and checks
 * that a conversion actually happens in the page: the worker loads, the engine
 * runs, the stats appear, the SVG renders, and palette edits change the result.
 *
 * The server is started and stopped inside this script because background
 * processes do not survive between shell invocations in the sandbox.
 *
 * Run: node scripts/verify-web.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(import.meta.dirname, '..');
const WEB = join(ROOT, 'apps', 'web');
const PORT = Number(process.env.PORT ?? 3123);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = join(ROOT, 'tmp', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const require = createRequire(join(WEB, 'package.json'));

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run:\n  pnpm --filter @perfectvector/web add -D playwright-core');
  process.exit(1);
}

// Reuse the Chromium already present in the image rather than downloading one.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/playwright/chromium-1232/chrome-linux64/chrome',
];
const executablePath = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!executablePath) {
  console.error(`No Chromium found. Set CHROME_PATH. Tried:\n${CHROME_CANDIDATES.join('\n')}`);
  process.exit(1);
}

if (!existsSync(join(WEB, '.next'))) {
  console.error('No production build. Run: pnpm --filter @perfectvector/web build');
  process.exit(1);
}

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

const server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
  cwd: WEB,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

async function waitForServer(timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms.\n${serverLog}`);
}

let browser;
try {
  await waitForServer();
  console.log(`Server up on ${BASE}`);

  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  console.log('\n=== 1. Landing page renders ===');
  await page.goto(BASE, { waitUntil: 'networkidle' });

  check('hero headline present', await page.getByText('Make images into vectors.').isVisible());
  check(
    'measured sample stats rendered from the real engine',
    await page.getByText('Clean enough to count.').isVisible()
  );
  check(
    'the "what you get" section renders, with no error state',
    (await page.getByText('Three ways to run it').isVisible()) &&
      !(await page.getByText('temporarily unavailable').isVisible().catch(() => false))
  );
  check(
    'it claims only features that exist',
    (await page.getByText(/Centreline recovery for line work/).first().isVisible()) &&
      (await page.getByText(/Convert a folder across worker threads/).first().isVisible()) &&
      // These were advertised in an earlier draft but never built.
      !(await page.getByText(/across devices/).isVisible().catch(() => false)) &&
      !(await page.getByText(/Team preset library/).isVisible().catch(() => false))
  );
  check('suitability section present', await page.getByText("Won't convert well").isVisible());
  check('dropzone present', await page.getByRole('button', { name: 'Choose an image' }).isVisible());

  const sampleImages = await page.locator('#how img').count();
  check(`sample conversions inlined as SVG (${sampleImages})`, sampleImages >= 5);

  await page.screenshot({ path: join(SHOTS, '01-landing.png'), fullPage: true });

  console.log('\n=== 2. Convert a sample entirely in the browser ===');
  await page.locator('button[title*="Flat badge mark"]').click();

  // The worker has to load, decode, analyze and trace.
  await page.getByText('Traced in').waitFor({ timeout: 30_000 });

  const readStats = async () => {
    return page.evaluate(() => {
      const result = {};
      // Scoped to the live result. The landing page also renders stat grids for the
      // sample gallery, which a looser selector reads by mistake.
      const container = document.querySelector('[data-testid="trace-stats"]');
      if (!container) return result;
      for (const cell of container.querySelectorAll(':scope > div')) {
        const label = cell.querySelector('dt')?.textContent?.trim();
        const value = cell.querySelector('dd')?.textContent?.trim();
        if (label && value) result[label] = value;
      }
      return result;
    });
  };

  const stats = await readStats();
  console.log(`  stats: ${JSON.stringify(stats)}`);
  check('4 colors reported', stats.Colors === '4', stats.Colors);
  check('4 pieces reported', stats.Pieces === '4', stats.Pieces);
  check('node count matches the engine (34)', stats.Nodes === '34', stats.Nodes);
  check('svg size reported', /KB|B$/.test(stats.SVG ?? ''), stats.SVG);

  const svgRendered = await page.evaluate(() => {
    const images = [...document.querySelectorAll('img')];
    const vector = images.find((img) => img.src.startsWith('data:image/svg+xml'));
    return vector ? { ok: vector.naturalWidth > 0, width: vector.naturalWidth } : null;
  });
  check('vector preview actually rendered', Boolean(svgRendered?.ok), JSON.stringify(svgRendered));

  check(
    'suitability verdict shown',
    await page.getByText(/Good input for tracing/).first().isVisible()
  );

  const layerRows = await page.locator('aside ul li').count();
  check(`4 color layers listed (${layerRows})`, layerRows === 4);

  const swatches = await page.evaluate(() =>
    [...document.querySelectorAll('aside ul li span[style*="background-color"]')].map((el) =>
      el.getAttribute('style')
    )
  );
  check(
    'brand navy preserved exactly in the layer list',
    swatches.some((s) => s?.includes('rgb(29, 53, 87)')),
    swatches.join(' | ')
  );

  await page.screenshot({ path: join(SHOTS, '02-converted.png'), fullPage: false });

  console.log('\n=== 3. Settings change re-traces ===');
  {
    // Pixel art preset disables simplification, so the node count must jump.
    await page.getByRole('button', { name: 'Pixel art' }).click();
    await page.waitForTimeout(2500);
    const after = await readStats();
    console.log(`  after pixel-art: ${JSON.stringify(after)}`);
    check(
      `node count rose with literal tracing (${stats.Nodes} -> ${after.Nodes})`,
      Number(after.Nodes.replace(/,/g, '')) > Number(stats.Nodes.replace(/,/g, ''))
    );

    await page.getByRole('button', { name: 'Logo & wordmark' }).click();
    await page.waitForTimeout(2500);
    const restored = await readStats();
    check(
      `node count fell again on the logo preset (${restored.Nodes})`,
      Number(restored.Nodes.replace(/,/g, '')) < Number(after.Nodes.replace(/,/g, ''))
    );
  }

  console.log('\n=== 4. Deleting a color layer changes the output ===');
  {
    const before = await readStats();
    const firstLayer = page.locator('aside ul li').first();
    await firstLayer.hover();
    await firstLayer.getByRole('button', { name: 'Delete' }).click();
    await page.waitForTimeout(2500);

    const after = await readStats();
    console.log(`  ${before.Colors} colors -> ${after.Colors}`);
    check(
      `color count dropped (${before.Colors} -> ${after.Colors})`,
      Number(after.Colors) === Number(before.Colors) - 1
    );

    await page.getByRole('button', { name: 'Undo edits' }).click();
    await page.waitForTimeout(2500);
    const restored = await readStats();
    check(`undo restored the layer (${restored.Colors})`, restored.Colors === before.Colors);
  }

  console.log('\n=== 5. Merging colors reduces the palette ===');
  {
    const before = await readStats();
    const firstLayer = page.locator('aside ul li').first();
    await firstLayer.hover();
    const select = firstLayer.locator('select');
    const options = await select.locator('option').all();
    const target = await options[1].getAttribute('value');
    await select.selectOption(target);
    await page.waitForTimeout(2500);

    const after = await readStats();
    console.log(`  merged into ${target}: ${before.Colors} colors -> ${after.Colors}`);
    check(
      `palette shrank after merge (${before.Colors} -> ${after.Colors})`,
      Number(after.Colors) < Number(before.Colors)
    );
    check(
      'merge explanation shown in the layer panel',
      await page.getByText(/Merging is previewed instantly/).first().isVisible()
    );
  }

  await page.screenshot({ path: join(SHOTS, '03-edited.png'), fullPage: false });

  console.log('\n=== 6. Downloads produce real files ===');
  {
    await page.getByRole('button', { name: 'Undo edits' }).click();
    await page.waitForTimeout(2000);

    for (const [label, extension, sniff] of [
      ['SVG', 'svg', (text) => text.startsWith('<svg') && text.includes('<g id="layer-1"')],
      ['PDF', 'pdf', (text) => text.startsWith('%PDF-1.4') && text.includes('%%EOF')],
      ['EPS', 'eps', (text) => text.startsWith('%!PS-Adobe')],
      ['DXF', 'dxf', (text) => text.includes('ENTITIES') && text.includes('POLYLINE')],
      ['PNG', 'png', null],
    ]) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 25_000 }),
        page.getByRole('button', { name: label, exact: true }).click(),
      ]);

      const path = join(SHOTS, `download.${extension}`);
      await download.saveAs(path);
      const { readFileSync, statSync } = await import('node:fs');
      const size = statSync(path).size;

      check(
        `${label} downloaded as ${download.suggestedFilename()} (${size} bytes)`,
        size > 300 && download.suggestedFilename().endsWith(`.${extension}`)
      );

      if (sniff) {
        const text = readFileSync(path, 'latin1');
        check(`${label} content is valid`, sniff(text), text.slice(0, 30));
      } else {
        const bytes = readFileSync(path);
        // PNG magic number.
        check(
          `${label} is a real PNG`,
          bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        );
      }
    }
  }

  console.log('\n=== 6b. Centreline recovery in the browser ===');
  {
    await page.getByRole('button', { name: 'New image' }).click();
    await page.locator('button[title*="centreline"]').click();
    await page.getByText('Traced in').waitFor({ timeout: 40_000 });

    const stroked = await readStats();
    console.log(`  line art: ${JSON.stringify(stroked)}`);
    check(`centrelines reported (${stroked.Centrelines})`, Number(stroked.Centrelines) >= 5);
    check('no filled pieces remain', stroked.Pieces === undefined, JSON.stringify(stroked.Pieces));
    check(`node count is low (${stroked.Nodes})`, Number(stroked.Nodes.replace(/,/g, '')) < 40);
    check(
      'layer row shows the recovered stroke weight',
      await page.getByText(/centrelines at [\d.]+px/).first().isVisible()
    );

    // Switching the toggle to Fill must produce the two-outline result instead.
    await page.getByRole('button', { name: 'Fill', exact: true }).click();
    await page.waitForTimeout(2500);
    const filled = await readStats();
    console.log(`  same art as fills: ${JSON.stringify(filled)}`);
    check(`fill mode restores filled pieces (${filled.Pieces})`, Number(filled.Pieces) > 0);
    check(
      `and costs more nodes (${stroked.Nodes} -> ${filled.Nodes})`,
      Number(filled.Nodes.replace(/,/g, '')) > Number(stroked.Nodes.replace(/,/g, ''))
    );

    await page.getByRole('button', { name: 'Centreline', exact: true }).click();
    await page.waitForTimeout(2500);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 25_000 }),
      page.getByRole('button', { name: 'SVG', exact: true }).click(),
    ]);
    const strokePath = join(SHOTS, 'centreline.svg');
    await download.saveAs(strokePath);
    const { readFileSync: read } = await import('node:fs');
    const svg = read(strokePath, 'utf8');
    check('downloaded svg strokes the ink', /fill="none" stroke=/.test(svg));
    check('downloaded svg carries a stroke-width', /stroke-width="\d/.test(svg));

    await page.screenshot({ path: join(SHOTS, '05-centreline.png'), fullPage: false });
  }

  console.log('\n=== 6c. Saved presets persist across a reload ===');
  {
    await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.localStorage.clear());
    await page.reload({ waitUntil: 'networkidle' });

    await page.locator('button[title*="Flat badge mark"]').click();
    await page.getByText('Traced in').waitFor({ timeout: 40_000 });

    // Tweak away from any built-in preset so the save is distinguishable.
    await page.getByRole('button', { name: 'Line art & silhouette' }).click();
    await page.waitForTimeout(2000);
    const tweaked = await readStats();

    await page.getByRole('button', { name: 'Save current settings' }).click();
    await page.getByLabel('Preset name').fill('My house style');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(1500);

    check('saved preset appears in the list', await page.getByRole('button', { name: 'My house style', exact: true }).isVisible());
    check(
      'it is written to localStorage',
      await page.evaluate(() => (window.localStorage.getItem('perfectvector.presets.v1') ?? '').includes('My house style'))
    );

    // Survive a full reload, which is the whole point of saving one. The settings
    // panel only exists once an image is loaded, so load one before looking.
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('button[title*="Flat badge mark"]').click();
    await page.getByText('Traced in').waitFor({ timeout: 40_000 });

    check(
      'it survives a reload',
      await page.getByRole('button', { name: 'My house style', exact: true }).isVisible()
    );

    await page.getByRole('button', { name: 'My house style', exact: true }).click();
    await page.waitForTimeout(2500);
    const restored = await readStats();
    check(
      `restoring it reproduces the same trace (${restored.Nodes} vs ${tweaked.Nodes})`,
      restored.Nodes === tweaked.Nodes && restored.Colors === tweaked.Colors
    );

    // Deleting must remove it from storage too, not just from the list.
    await page.getByRole('button', { name: 'My house style', exact: true }).hover();
    await page.getByRole('button', { name: 'Delete My house style' }).click();
    await page.waitForTimeout(1500);
    check(
      'deleting removes it from storage',
      await page.evaluate(() => !(window.localStorage.getItem('perfectvector.presets.v1') ?? '').includes('My house style'))
    );

    // Corrupt storage must not break the studio.
    await page.evaluate(() => window.localStorage.setItem('perfectvector.presets.v1', '{"not":"an array"}'));
    await page.reload({ waitUntil: 'networkidle' });
    check(
      'corrupt saved-preset storage is ignored, not fatal',
      await page.getByRole('button', { name: 'Choose an image' }).isVisible()
    );
  }

  console.log('\n=== 7. Photograph is refused, in the UI ===');
  {
    // Self-contained: earlier sections may leave the studio in any state.
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.locator('button[title*="photograph"]').click();
    await page.getByText('Traced in').waitFor({ timeout: 40_000 });

    check(
      'refusal is shown prominently',
      await page.getByText('This image will not trace well').isVisible()
    );
    check(
      'explanation mentions redrawing',
      await page.getByText(/Redraw it instead/).isVisible()
    );
    await page.screenshot({ path: join(SHOTS, '04-refused.png'), fullPage: false });
  }

  console.log('\n=== 8. No console errors throughout ===');
  {
    const real = consoleErrors.filter(
      (message) => !/favicon|Download the React DevTools/i.test(message)
    );
    check(`no console errors (${real.length})`, real.length === 0, real.slice(0, 3).join(' | '));
  }

  console.log('\n=== 9. Studio route works standalone ===');
  {
    await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' });
    check('studio heading present', await page.getByRole('heading', { name: 'Studio' }).isVisible());
    check(
      'studio has its own dropzone',
      await page.getByRole('button', { name: 'Choose an image' }).isVisible()
    );
  }
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  server.kill('SIGKILL');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`Screenshots in ${SHOTS}`);
process.exit(failures > 0 ? 1 : 0);
