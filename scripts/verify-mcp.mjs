/**
 * MCP server verification over real stdio.
 *
 * Spawns the built server as a child process and drives it with the official MCP
 * client, so this exercises the actual JSON-RPC transport, schema validation and
 * tool wiring rather than calling the implementation functions directly.
 *
 * Run: node scripts/make-fixtures.mjs && node scripts/verify-mcp.mjs
 */

import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(import.meta.dirname, '..', 'packages', 'mcp', 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'tmp', 'fixtures');
const OUT = join(ROOT, 'tmp', 'mcp-out');
const SERVER = join(ROOT, 'packages', 'mcp', 'dist', 'server.js');

if (!existsSync(SERVER)) {
  console.error(`Server not built: ${SERVER}\nRun: pnpm --filter @perfectvector/mcp build`);
  process.exit(1);
}
if (!existsSync(FIXTURES)) {
  console.error('Fixtures missing. Run: node scripts/make-fixtures.mjs');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

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

/** Tool responses carry a text summary plus a fenced JSON block. */
function parseResponse(result) {
  const texts = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
  const summary = texts[0] ?? '';
  let structured = null;
  for (const text of texts) {
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    if (match) {
      structured = JSON.parse(match[1]);
      break;
    }
  }
  return { summary, structured, isError: Boolean(result.isError) };
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  stderr: 'pipe',
});

const client = new Client({ name: 'perfectvector-verify', version: '0.1.0' });
await client.connect(transport);

try {
  console.log('=== 1. Handshake and discovery ===');
  {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`  tools: ${names.join(', ')}`);
    check('all seven tools registered', names.length === 7, names.join(','));
    for (const expected of [
      'analyze_image',
      'compare_presets',
      'list_presets',
      'refine_colors',
      'suggest_color_merges',
      'vectorize_batch',
      'vectorize_image',
    ]) {
      check(`${expected} present`, names.includes(expected));
    }
    const vectorizeTool = tools.find((t) => t.name === 'vectorize_image');
    check('vectorize_image has a description', (vectorizeTool?.description?.length ?? 0) > 80);
    check(
      'vectorize_image exposes its settings in the schema',
      Boolean(vectorizeTool?.inputSchema?.properties?.maxColors) &&
        Boolean(vectorizeTool?.inputSchema?.properties?.preset)
    );

    const { resources } = await client.listResources();
    check('two resources registered', resources.length === 2, resources.map((r) => r.uri).join(','));

    const guide = await client.readResource({ uri: 'perfectvector://guide' });
    check('settings guide readable', (guide.contents[0]?.text?.length ?? 0) > 500);
  }

  console.log('\n=== 2. list_presets ===');
  {
    const { summary, structured } = parseResponse(await client.callTool({ name: 'list_presets', arguments: {} }));
    check('eight presets returned', structured.presets.length === 8, String(structured.presets.length));
    check('each preset has a description', structured.presets.every((p) => p.description.length > 30));
    check('summary mentions auto', summary.includes('auto'));
    check(
      'centreline preset is offered',
      structured.presets.some((p) => p.id === 'centerline' && p.options.strokeMode === 'force')
    );
    check(
      'line art preset recovers centrelines by default',
      structured.presets.find((p) => p.id === 'lineart')?.options.strokeMode === 'auto'
    );
  }

  console.log('\n=== 3. analyze_image on a clean logo ===');
  {
    const { summary, structured } = parseResponse(
      await client.callTool({ name: 'analyze_image', arguments: { path: join(FIXTURES, 'logo.png') } })
    );
    check(`verdict is excellent or good (${structured.suitability})`,
      ['excellent', 'good'].includes(structured.suitability));
    check(`classified as flat art (${structured.classification})`, structured.classification === 'flat-art');
    check('noise measured as zero on clean art', structured.noiseEstimate === 0, String(structured.noiseEstimate));
    check('recommends a preset', typeof structured.recommended.presetId === 'string');
    check('summary is human readable', summary.includes('Verdict:') && summary.includes('Recommended preset:'));
  }

  console.log('\n=== 4. analyze_image refuses a photograph ===');
  {
    const { summary, structured } = parseResponse(
      await client.callTool({ name: 'analyze_image', arguments: { path: join(FIXTURES, 'photo.jpg') } })
    );
    check(`verdict is poor (${structured.suitability}, score ${structured.score})`, structured.suitability === 'poor');
    check('has an error-level finding', structured.findings.some((f) => f.level === 'error'));
    check('summary says so plainly', /redraw|not suitable|photograph/i.test(summary));
  }

  console.log('\n=== 5. vectorize_image writes an SVG ===');
  {
    const outputPath = join(OUT, 'logo.svg');
    const { summary, structured } = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: { path: join(FIXTURES, 'logo.png'), outputPath },
      })
    );
    check('file written', existsSync(outputPath));
    check(`4 colours (${structured.stats.colors})`, structured.stats.colors === 4);
    check(`4 pieces (${structured.stats.pieces})`, structured.stats.pieces === 4);
    check(`low node count (${structured.stats.nodes})`, structured.stats.nodes < 120);
    check('preset auto-selected', structured.presetReason.startsWith('auto-selected'));
    check('layers reported with hex and area share',
      structured.layers.length === 4 && structured.layers.every((l) => /^#[0-9a-f]{6}$/.test(l.hex) && l.areaShare > 0));
    check('output path recorded', structured.output.path === outputPath);
    check('summary leads with counts, not path data',
      summary.includes('colors:') && !summary.includes('<path'));

    const svg = readFileSync(outputPath, 'utf8');
    check('svg is well formed', svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
    check('colours grouped into layers with ids', /<g id="layer-1" data-color="#[0-9a-f]{6}"/.test(svg));
    check('brand navy preserved exactly', svg.includes('#1d3557'));
  }

  console.log('\n=== 6. vectorize_image returns SVG inline when no path given ===');
  {
    const { structured } = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: { path: join(FIXTURES, 'pixelart.png'), preset: 'pixel-art' },
      })
    );
    check('content inlined', structured.output.inlined === true);
    check('content is an svg', typeof structured.content === 'string' && structured.content.includes('<svg'));
    check('no file written', structured.output.path === null);
  }

  console.log('\n=== 7. All vector formats export ===');
  {
    for (const format of ['pdf', 'eps', 'dxf']) {
      const outputPath = join(OUT, `logo.${format}`);
      const { structured } = parseResponse(
        await client.callTool({
          name: 'vectorize_image',
          arguments: { path: join(FIXTURES, 'logo.png'), format, outputPath },
        })
      );
      const written = existsSync(outputPath);
      check(`${format} written (${structured.output.bytes} bytes)`, written && structured.output.bytes > 200);
      if (written) {
        const head = readFileSync(outputPath, 'utf8').slice(0, 40);
        const expected = { pdf: '%PDF-1.4', eps: '%!PS-Adobe', dxf: '0\nSECTION' }[format];
        check(`${format} has the right header`, head.startsWith(expected), JSON.stringify(head.slice(0, 20)));
      }
    }
  }

  console.log('\n=== 8. Raster export ===');
  {
    const outputPath = join(OUT, 'logo.png');
    const response = await client.callTool({
      name: 'vectorize_image',
      arguments: { path: join(FIXTURES, 'logo.png'), format: 'png', outputPath, rasterWidth: 256 },
    });
    const { structured, isError } = parseResponse(response);
    if (isError) {
      // Acceptable: rasterizing needs SVG support in the local libvips.
      check('png failure is explained clearly', /libvips|SVG support/i.test(response.content[0].text));
    } else {
      check('png written', existsSync(outputPath) && structured.output.bytes > 500);
      check('binary output not inlined', structured.output.inlined === false);
    }
  }

  console.log('\n=== 8b. Centreline recovery through the tool surface ===');
  {
    const filled = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: { path: join(FIXTURES, 'lineart.png'), preset: 'lineart', strokeMode: 'off', includeContent: false },
      })
    );
    const outputPath = join(OUT, 'lineart-centreline.svg');
    const stroked = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: { path: join(FIXTURES, 'lineart.png'), preset: 'lineart', outputPath },
      })
    );

    check(`centrelines recovered (${stroked.structured.stats.strokes})`, stroked.structured.stats.strokes >= 5);
    check('nothing left filled', stroked.structured.stats.pieces === 0, String(stroked.structured.stats.pieces));
    check(
      `nodes collapse vs filled outlines (${filled.structured.stats.nodes} -> ${stroked.structured.stats.nodes})`,
      stroked.structured.stats.nodes * 2 < filled.structured.stats.nodes
    );
    check(
      `recovered width reported (${stroked.structured.strokeReport.medianWidth}px)`,
      Math.abs(stroked.structured.strokeReport.medianWidth - 9) < 0.5
    );
    check('summary names the centrelines', /centrelines: \d+/.test(stroked.summary), stroked.summary.slice(0, 200));
    check(
      'layer report carries the stroke width',
      stroked.structured.layers[0].strokes >= 5 && stroked.structured.layers[0].strokeWidth > 8
    );

    const svg = readFileSync(outputPath, 'utf8');
    check('svg strokes rather than fills the ink', /fill="none" stroke="#111111"/.test(svg));
    check('svg carries a stroke-width', /stroke-width="\d/.test(svg));

    // The safety rule, exercised end to end: keeping the white background means the
    // ink borders another colour, so it must stay filled.
    const blocked = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: {
          path: join(FIXTURES, 'sticker.png'),
          preset: 'centerline',
          background: 'keep',
          includeContent: false,
        },
      })
    );
    check(
      `regions bordering another colour are reported as blocked (${blocked.structured.strokeReport.blockedByNeighbours})`,
      blocked.structured.strokeReport.blockedByNeighbours > 0
    );
    check('and the summary explains why', /border another colour/.test(blocked.summary));
  }

  console.log('\n=== 9. suggest_color_merges on a noisy JPEG ===');
  {
    const { summary, structured } = parseResponse(
      await client.callTool({
        name: 'suggest_color_merges',
        arguments: { path: join(FIXTURES, 'logo-noisy.jpg'), colorMergeThreshold: 4, maxColors: 8 },
      })
    );
    check(`palette listed (${structured.colors.length} colours)`, structured.colors.length >= 4);
    check('area shares sum to about 1',
      Math.abs(structured.colors.reduce((s, c) => s + c.areaShare, 0) - 1) < 0.02,
      String(structured.colors.reduce((s, c) => s + c.areaShare, 0)));
    check(`merge candidates found (${structured.suggestions.length})`, structured.suggestions.length >= 1);
    check('summary explains the next step', /refine_colors/.test(summary));
  }

  console.log('\n=== 10. refine_colors actually reduces nodes ===');
  {
    const base = parseResponse(
      await client.callTool({
        name: 'vectorize_image',
        arguments: { path: join(FIXTURES, 'logo-noisy.jpg'), colorMergeThreshold: 4, maxColors: 8, includeContent: false },
      })
    );

    const outputPath = join(OUT, 'refined.svg');
    const refined = parseResponse(
      await client.callTool({
        name: 'refine_colors',
        arguments: {
          path: join(FIXTURES, 'logo-noisy.jpg'),
          colorMergeThreshold: 4,
          maxColors: 8,
          autoMergeBelowDeltaE: 14,
          outputPath,
        },
      })
    );

    check(`colours reduced (${base.structured.stats.colors} -> ${refined.structured.stats.colors})`,
      refined.structured.stats.colors < base.structured.stats.colors);
    check(`nodes reduced (${base.structured.stats.nodes} -> ${refined.structured.stats.nodes})`,
      refined.structured.stats.nodes < base.structured.stats.nodes);
    check('summary reports the before/after', /Refined:/.test(refined.summary));
    check('refined file written', existsSync(outputPath));
  }

  console.log('\n=== 11. refine_colors rejects unknown colours with a useful message ===');
  {
    const response = await client.callTool({
      name: 'refine_colors',
      arguments: {
        path: join(FIXTURES, 'logo.png'),
        remove: ['#123456'],
      },
    });
    check('call reports an error', response.isError === true);
    const text = response.content.map((c) => c.text).join('\n');
    check('error names the offending colour', text.includes('#123456'));
    check('error lists the available palette', /Available:/.test(text));
  }

  console.log('\n=== 12. compare_presets ===');
  {
    const { summary, structured } = parseResponse(
      await client.callTool({
        name: 'compare_presets',
        arguments: { path: join(FIXTURES, 'sticker.png'), presets: ['logo', 'sticker', 'pixel-art'] },
      })
    );
    check('three rows returned', structured.rows.length === 3, String(structured.rows.length));
    check('every row has stats', structured.rows.every((r) => r.nodes > 0 && r.colors > 0 && r.svgBytes > 0));
    check('pixel-art produces the most nodes',
      structured.rows.find((r) => r.preset === 'pixel-art').nodes ===
        Math.max(...structured.rows.map((r) => r.nodes)));
    check('summary is a readable table', summary.includes('preset') && summary.includes('nodes'));
  }

  console.log('\n=== 13. base64 input ===');
  {
    const base64 = readFileSync(join(FIXTURES, 'logo.png')).toString('base64');
    const { structured } = parseResponse(
      await client.callTool({ name: 'analyze_image', arguments: { base64 } })
    );
    check('base64 accepted', structured.width === 640 && structured.height === 640);
    check('origin describes inline input', /base64/.test(structured.source));
  }

  console.log('\n=== 14. Error handling ===');
  {
    const missing = await client.callTool({ name: 'analyze_image', arguments: { path: '/nope/missing.png' } });
    check('missing file reports an error', missing.isError === true);
    check('error names the path', missing.content.map((c) => c.text).join('').includes('missing.png'));

    const neither = await client.callTool({ name: 'analyze_image', arguments: {} });
    check('missing image argument reports an error', neither.isError === true);
    check('error explains what to pass',
      /path.*base64|base64.*path/is.test(neither.content.map((c) => c.text).join('')));

    const both = await client.callTool({
      name: 'analyze_image',
      arguments: { path: join(FIXTURES, 'logo.png'), base64: 'AAAA' },
    });
    check('passing both reports an error', both.isError === true);

    const badPreset = await client.callTool({
      name: 'vectorize_image',
      arguments: { path: join(FIXTURES, 'logo.png'), preset: 'not-a-preset' },
    });
    check('invalid preset rejected by schema validation', badPreset.isError === true);
  }
} finally {
  await client.close();
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${checks - failures}/${checks} checks passed`);
console.log(`Outputs in ${OUT}`);
if (failures > 0) process.exit(1);
