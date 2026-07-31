/**
 * Batch conversion verification, over the real MCP stdio transport.
 *
 * The fixture folder is built by the shell step in the repo docs and contains
 * deliberate hazards: a photograph that should be skipped, a file that is not an
 * image at all, duplicate basenames in a subfolder, and a dot-directory that must
 * not be searched. A batch tool is only trustworthy if it handles those without
 * losing the rest of the run.
 *
 * Run: node scripts/verify-batch.mjs
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const basenameOf = (path) => basename(path);
import { createRequire } from 'node:module';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = join(import.meta.dirname, '..');
const IN = join(ROOT, 'tmp', 'batch-in');
const OUT = join(ROOT, 'tmp', 'batch-out');
const SERVER = join(ROOT, 'packages', 'mcp', 'dist', 'server.js');

if (!existsSync(IN)) {
  console.error(`Input folder missing: ${IN}\nCreate it first (see scripts/make-batch-fixtures.mjs).`);
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

function parse(result) {
  const texts = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  let structured = null;
  for (const text of texts) {
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    if (match) {
      structured = JSON.parse(match[1]);
      break;
    }
  }
  return { summary: texts[0] ?? '', structured, isError: Boolean(result.isError) };
}

const countFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true }).filter((f) => statSync(join(dir, f)).isFile()).length
    : 0;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: 'pipe',
});
const client = new Client({ name: 'perfectvector-batch-verify', version: '0.1.0' });
await client.connect(transport);

try {
  console.log('=== 1. Tool is registered and described ===');
  {
    const { tools } = await client.listTools();
    const batch = tools.find((t) => t.name === 'vectorize_batch');
    check('vectorize_batch present', Boolean(batch));
    check('it explains the speed reason', /CPU-bound|worker threads/i.test(batch?.description ?? ''));
    check(
      'it exposes the safety options',
      Boolean(batch?.inputSchema?.properties?.dryRun) &&
        Boolean(batch?.inputSchema?.properties?.overwrite) &&
        Boolean(batch?.inputSchema?.properties?.minScore)
    );
  }

  console.log('\n=== 2. Dry run writes nothing ===');
  {
    rmSync(OUT, { recursive: true, force: true });
    const { summary, structured } = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, dryRun: true },
      })
    );

    check(`discovered the top-level images (${structured.discovered})`, structured.discovered === 26,
      String(structured.discovered));
    check('dot-directories were not searched',
      !structured.files.some((f) => f.path.includes('.hidden')));
    check('subfolder not searched without recursive',
      !structured.files.some((f) => f.path.includes('nested')));
    check('nothing was written', countFiles(OUT) === 0, `${countFiles(OUT)} files in output`);
    check('summary says it was a dry run', /Dry run/.test(summary) && /Nothing was written/.test(summary));
    check('dry run still reports real stats', structured.converted > 0 && structured.files.some((f) => f.nodes > 0));
  }

  console.log('\n=== 3. Real run converts the folder ===');
  {
    rmSync(OUT, { recursive: true, force: true });
    const started = Date.now();
    const { summary, structured } = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, outputDirectory: OUT },
      })
    );
    const wall = Date.now() - started;

    console.log(
      `  ${structured.converted} converted, ${structured.skipped} skipped, ${structured.failed} failed ` +
        `in ${(structured.wallClockMs / 1000).toFixed(2)}s across ${structured.concurrency} workers ` +
        `(${(structured.cpuMs / 1000).toFixed(2)}s of tracing)`
    );

    check(`converted the suitable images (${structured.converted})`, structured.converted === 24,
      String(structured.converted));
    check('files landed on disk', countFiles(OUT) === structured.converted,
      `${countFiles(OUT)} on disk vs ${structured.converted} reported`);
    check('every output is a valid svg', readdirSync(OUT).filter((f) => f.endsWith('.svg')).every((f) =>
      readFileSync(join(OUT, f), 'utf8').startsWith('<svg')));

    // The photograph must be skipped rather than turned into 80 layers of bands.
    const photo = structured.files.find((f) => f.path.endsWith('photo.jpg'));
    check('photograph was skipped', photo?.status === 'skipped', JSON.stringify(photo));
    check('and the reason names the score', /scored \d+\/100/.test(photo?.reason ?? ''), photo?.reason);
    check('and mentions it is a photograph', /photograph/.test(photo?.reason ?? ''));

    // A file that is not an image must fail alone.
    const broken = structured.files.find((f) => f.path.endsWith('broken.png'));
    check('non-image failed', broken?.status === 'failed', JSON.stringify(broken));
    check('failure has a readable reason', (broken?.reason?.length ?? 0) > 10, broken?.reason);
    check('one bad file did not abort the run', structured.converted === 24);
    check('summary lists the failure', /Failed \(1\)/.test(summary));

    // No region may ever be silently discarded: that loses a whole colour layer.
    const dropped = structured.files.reduce((sum, f) => sum + (f.droppedRegions ?? 0), 0);
    check(`no region was discarded (${dropped})`, dropped === 0);

    check('line art was recovered as centrelines',
      structured.files.some((f) => f.path.includes('lineart') && f.strokes >= 5),
      JSON.stringify(structured.files.find((f) => f.path.includes('lineart'))));
    check('presets were auto-selected per file',
      new Set(structured.files.filter((f) => f.preset).map((f) => f.preset)).size >= 3,
      [...new Set(structured.files.filter((f) => f.preset).map((f) => f.preset))].join(','));

    check(`wall clock is close to reported (${wall}ms vs ${structured.wallClockMs}ms)`,
      Math.abs(wall - structured.wallClockMs) < 2000);
  }

  console.log('\n=== 4. Parallel speedup is real ===');
  {
    const run = async (concurrency) => {
      rmSync(OUT, { recursive: true, force: true });
      const { structured } = parse(
        await client.callTool({
          name: 'vectorize_batch',
          arguments: { directory: IN, outputDirectory: OUT, concurrency, minScore: 0 },
        })
      );
      return structured;
    };

    const serial = await run(1);
    const parallel = await run(7);

    const speedup = serial.wallClockMs / parallel.wallClockMs;
    console.log(
      `  1 worker: ${(serial.wallClockMs / 1000).toFixed(2)}s   ` +
        `7 workers: ${(parallel.wallClockMs / 1000).toFixed(2)}s   speedup ${speedup.toFixed(2)}x`
    );

    check('both runs converted the same files', serial.converted === parallel.converted,
      `${serial.converted} vs ${parallel.converted}`);
    check(`parallel run is meaningfully faster (${speedup.toFixed(2)}x)`, speedup > 1.8);

    // 24 convertible + the photograph. broken.png is not an image, so it fails
    // regardless of the score threshold.
    check(`minScore 0 converts the photograph too (${parallel.converted})`, parallel.converted === 25,
      String(parallel.converted));
    check('the photograph is among them',
      parallel.files.some((f) => f.path.endsWith('photo.jpg') && f.status === 'converted'));
    check('broken.png still fails, threshold or not',
      parallel.files.some((f) => f.path.endsWith('broken.png') && f.status === 'failed'));
  }

  console.log('\n=== 4b. Identical inputs give identical outputs ===');
  {
    // The fixture folder holds four byte-identical copies of several images, so any
    // disagreement between them is nondeterminism — and running twice at different
    // concurrency catches anything that depends on scheduling.
    //
    // This check exists because a single earlier run reported one copy of the noisy
    // JPEG as 3 colours where its three twins gave 4. That never reproduced across
    // subsequent controlled runs, so it was most likely a transient fixture state,
    // but "probably fine" is not a property worth trusting. Now a recurrence fails
    // the suite instead of hiding in a report.
    const fingerprint = (structured) =>
      structured.files
        .map((f) => [f.id, basenameOf(f.path), f.status, f.colors, f.pieces, f.strokes, f.nodes, f.outputBytes].join(':'))
        .join('|');

    const run = async (concurrency) => {
      rmSync(OUT, { recursive: true, force: true });
      const { structured } = parse(
        await client.callTool({
          name: 'vectorize_batch',
          arguments: { directory: IN, outputDirectory: OUT, recursive: true, concurrency },
        })
      );
      return structured;
    };

    const a = await run(7);
    const b = await run(3);

    check('two runs at different concurrency agree exactly', fingerprint(a) === fingerprint(b));

    // Group the identical copies and require one distinct outcome per group.
    const groups = new Map();
    for (const file of a.files) {
      if (file.status !== 'converted') continue;
      const base = basenameOf(file.path).replace(/-\d+(\.\w+)$/, '$1');
      const key = `${base}`;
      const outcome = `${file.colors}c/${file.pieces}p/${file.strokes}s/${file.nodes}n/${file.outputBytes}B`;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(outcome);
    }

    for (const [name, outcomes] of groups) {
      if (outcomes.size === 1) continue;
      check(`identical copies of ${name} agree`, false, [...outcomes].join(' vs '));
    }
    const disagreeing = [...groups.values()].filter((o) => o.size > 1).length;
    check(
      `all ${groups.size} duplicate groups are self-consistent`,
      disagreeing === 0,
      `${disagreeing} groups disagreed`
    );
  }

  console.log('\n=== 5. Existing output is protected ===');
  {
    rmSync(OUT, { recursive: true, force: true });
    await client.callTool({
      name: 'vectorize_batch',
      arguments: { directory: IN, outputDirectory: OUT },
    });

    const marker = join(OUT, 'logo-1.svg');
    writeFileSync(marker, '<svg>sentinel</svg>');

    const second = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, outputDirectory: OUT },
      })
    );

    check('second run converted nothing', second.structured.converted === 0,
      String(second.structured.converted));
    check('existing files were skipped', second.structured.skipped >= 24);
    check('the sentinel was not touched', readFileSync(marker, 'utf8') === '<svg>sentinel</svg>');
    check('summary explains how to override', /pass overwrite to replace it/.test(second.summary));

    const third = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, outputDirectory: OUT, overwrite: true },
      })
    );
    check(`overwrite replaces them (${third.structured.converted})`, third.structured.converted === 24);
    check('the sentinel was overwritten', readFileSync(marker, 'utf8').startsWith('<svg xmlns'));
  }

  console.log('\n=== 6. Recursive mode mirrors the tree ===');
  {
    rmSync(OUT, { recursive: true, force: true });
    const { structured } = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, outputDirectory: OUT, recursive: true },
      })
    );

    check(`found the subfolder images (${structured.discovered})`, structured.discovered === 28,
      String(structured.discovered));
    check('output mirrors the input tree', existsSync(join(OUT, 'nested', 'logo.svg')),
      readdirSync(OUT).join(','));
    // Same basename in two folders must not collide.
    check('duplicate basenames did not collide',
      existsSync(join(OUT, 'logo-1.svg')) && existsSync(join(OUT, 'nested', 'logo.svg')));
    check('dot-directory still ignored', !existsSync(join(OUT, '.hidden')));
  }

  console.log('\n=== 7. Explicit paths and other formats ===');
  {
    rmSync(OUT, { recursive: true, force: true });
    const { structured } = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: {
          paths: [join(IN, 'logo-1.png'), join(IN, 'lineart-1.png')],
          outputDirectory: OUT,
          format: 'dxf',
          preset: 'centerline',
        },
      })
    );

    check('both files converted', structured.converted === 2, String(structured.converted));
    check('dxf files written', readdirSync(OUT).filter((f) => f.endsWith('.dxf')).length === 2,
      readdirSync(OUT).join(','));
    check('dxf content is valid', readdirSync(OUT).every((f) =>
      readFileSync(join(OUT, f), 'utf8').includes('ENTITIES')));
    check('explicit preset was used', structured.files.every((f) => f.preset === 'centerline'));
  }

  console.log('\n=== 8. Guards and errors ===');
  {
    const noOutput = await client.callTool({
      name: 'vectorize_batch',
      arguments: { directory: IN },
    });
    check('missing outputDirectory is rejected', noOutput.isError === true);
    check('error says what to pass',
      /outputDirectory. is required/.test(noOutput.content.map((c) => c.text).join('')));

    const both = await client.callTool({
      name: 'vectorize_batch',
      arguments: { directory: IN, paths: [join(IN, 'logo-1.png')], dryRun: true },
    });
    check('directory plus paths is rejected', both.isError === true);

    const missing = await client.callTool({
      name: 'vectorize_batch',
      arguments: { directory: join(IN, 'does-not-exist'), dryRun: true },
    });
    check('missing directory is rejected', missing.isError === true);

    const empty = await client.callTool({
      name: 'vectorize_batch',
      arguments: { directory: join(IN, 'nested'), extensions: ['.tiff'], dryRun: true },
    });
    check('no matching files is explained', empty.isError === true);
    check('and suggests recursive',
      /recursive|Looked for/.test(empty.content.map((c) => c.text).join('')));

    rmSync(OUT, { recursive: true, force: true });
    const limited = parse(
      await client.callTool({
        name: 'vectorize_batch',
        arguments: { directory: IN, outputDirectory: OUT, limit: 3 },
      })
    );
    check(`limit is honoured (${limited.structured.discovered})`, limited.structured.discovered === 3);
  }
} finally {
  await client.close();
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
