#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { PRESETS } from '@perfectvector/core';
import {
  OUTPUT_FORMATS,
  PRESET_IDS,
  runAnalyze,
  runComparePresets,
  runListPresets,
  runRefine,
  runSuggestMerges,
  runVectorize,
} from './tools.js';
import { runBatch } from './batch.js';
import { describe } from './image.js';

/**
 * PerfectVector MCP server.
 *
 * Exposes the raster-to-SVG engine over stdio so an agent can vectorize artwork,
 * judge whether an image is even suitable, and iterate on the palette.
 *
 * Two choices shape the tool surface:
 *
 *  - **`analyze_image` exists as its own tool.** Tracing a photograph cannot
 *    succeed, and an agent that discovers this by inspecting 40 layers of mush has
 *    already wasted a turn and a lot of context. Letting it ask first is cheaper
 *    and produces better decisions.
 *
 *  - **Responses lead with a summary, not path data.** SVG path data is enormous
 *    and tells a model nothing it can act on. Counts of colors, pieces and nodes
 *    are what indicate whether settings need adjusting, so those come first and
 *    the geometry is written to disk unless explicitly requested inline.
 */

const server = new McpServer(
  { name: 'perfectvector', version: '0.1.0' },
  {
    instructions: [
      'PerfectVector converts PNG/JPG raster images into clean, editable SVG with each color on its own layer.',
      '',
      'Recommended flow:',
      '  1. analyze_image — confirm the image is suitable and get a recommended preset.',
      '     Photographs and gradient-heavy art cannot be traced usefully; say so rather than trying.',
      '  2. vectorize_image — convert. Leave preset as "auto" unless you have a reason.',
      '  3. suggest_color_merges — inspect the palette and find near-duplicate colors.',
      '  4. refine_colors — merge or delete colors and re-export.',
      '',
      'For a whole folder use vectorize_batch instead of looping over vectorize_image: it runs across',
      'worker threads and skips unsuitable images. Try it with dryRun first if the path is uncertain.',
      '',
      'Prefer writing output with outputPath. SVG path data is large and rarely worth reading.',
      'Good input: logos, wordmarks, flat illustration, stickers, line art, silhouettes, AI art prompted flat.',
      'Bad input: photographs, photoreal or gradient-heavy AI art, blurry or very low-resolution sources.',
    ].join('\n'),
  }
);

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const imageSourceShape = {
  path: z
    .string()
    .optional()
    .describe('Absolute or relative path to a PNG, JPG, WebP, GIF or TIFF file.'),
  base64: z
    .string()
    .optional()
    .describe('Base64-encoded image bytes, with or without a data URL prefix. Use instead of path.'),
};

const settingsShape = {
  maxColors: z
    .number()
    .int()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Palette size cap. Images with fewer distinct colors than this keep their exact original values.'
    ),
  detail: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'How closely paths follow the pixel boundary. Higher keeps more detail and more nodes; 100 traces literally, pixel for pixel.'
    ),
  smoothing: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'How aggressively corners round into curves. 0 preserves every corner, 100 smooths nearly everything.'
    ),
  denoise: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Cleanup strength for JPEG speckle. Only takes effect when noise is actually measured, so clean art is left alone.'
    ),
  background: z
    .enum(['auto', 'keep', 'remove'])
    .optional()
    .describe(
      'auto drops a flat backdrop touching the frame edge, giving a transparent SVG. keep traces it as a layer.'
    ),
  colorMergeThreshold: z
    .number()
    .min(0)
    .max(50)
    .optional()
    .describe('Palette entries closer than this CIEDE2000 distance are merged. Default 6.'),
  maxDimension: z
    .number()
    .int()
    .min(64)
    .max(8192)
    .optional()
    .describe('Longest side used for tracing. Output still matches the source size. Default 1400.'),
  precision: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe('Decimal places in path coordinates. Default 2.'),
  minArea: z
    .number()
    .min(1)
    .optional()
    .describe('Drop regions smaller than this many source pixels. Derived from image size by default.'),
  strokeMode: z
    .enum(['off', 'auto', 'force'])
    .optional()
    .describe(
      'Recover thin regions as stroked centrelines instead of filled outlines. A stroke traced as a ' +
        'fill comes back as two parallel outlines, which is useless for a pen plotter or laser and ' +
        'costs several times the nodes. "auto" converts clearly stroke-like regions, "force" lowers ' +
        'the bar. Only regions whose whole boundary faces empty space are ever converted, since ' +
        'replacing a fill with a stroke next to another colour would open a gap. Default off.'
    ),
  minStrokeElongation: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe(
      'How many times longer than wide a region must be for "auto" to treat it as a stroke. Default 5.'
    ),
};

const presetShape = {
  preset: z
    .enum(['auto', ...PRESET_IDS] as [string, ...string[]])
    .optional()
    .describe(
      `Starting settings. "auto" (default) picks from image analysis. Options: ${PRESET_IDS.join(', ')}.`
    ),
};

const outputShape = {
  format: z
    .enum(OUTPUT_FORMATS as [string, ...string[]])
    .optional()
    .describe(
      'svg (default), pdf, eps and dxf are true vector formats. png and jpeg rasterize the result and need SVG support in the local libvips.'
    ),
  outputPath: z
    .string()
    .optional()
    .describe('Write the result here. The extension is corrected to match the format.'),
  includeContent: z
    .boolean()
    .optional()
    .describe(
      'Return the file contents in the response. Defaults to true only when no outputPath is given, and never for binary formats.'
    ),
  maxInlineBytes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Size ceiling for inlined content. Default 60000.'),
  backgroundColor: z
    .string()
    .optional()
    .describe('Hex color painted behind the artwork instead of leaving transparency.'),
  rasterWidth: z
    .number()
    .int()
    .min(1)
    .max(20000)
    .optional()
    .describe('Pixel width for png/jpeg output. Defaults to the source width.'),
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'list_presets',
  {
    title: 'List vectorization presets',
    description:
      'List the available presets with their settings and what each is tuned for. ' +
      'Call this when you need to choose settings deliberately rather than relying on auto-detection.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => {
    const { summary, structured } = runListPresets();
    return respond(summary, structured);
  }
);

server.registerTool(
  'analyze_image',
  {
    title: 'Analyze image suitability',
    description:
      'Judge whether an image can be traced usefully, before spending a conversion on it. ' +
      'Reports a classification (flat art, line art, gradient art, photo), a 0-100 score, ' +
      'specific warnings, and a recommended preset. ' +
      'Call this first: photographs and gradient-heavy artwork cannot be vectorized into anything ' +
      'a designer would accept, and it is more useful to say so than to return 40 layers of colour bands.',
    inputSchema: { ...imageSourceShape },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runAnalyze(args);
    return respond(summary, structured);
  }
);

server.registerTool(
  'vectorize_image',
  {
    title: 'Vectorize image to SVG',
    description:
      'Convert a raster image into a clean, editable vector file. Each colour becomes its own ' +
      'layer, holes are handled correctly, and adjacent colours share exact boundaries so there ' +
      'are no seams. Returns counts of colours, pieces and nodes rather than dumping path data. ' +
      'Pass outputPath to write the file; without it, a small SVG is returned inline.',
    inputSchema: {
      ...imageSourceShape,
      ...presetShape,
      ...settingsShape,
      ...outputShape,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runVectorize(args as never);
    return respond(summary, structured);
  }
);

server.registerTool(
  'suggest_color_merges',
  {
    title: 'Inspect palette and suggest merges',
    description:
      'Trace the image and report the resulting colour palette, how much area each colour covers, ' +
      'and which pairs are close enough to be worth merging. Use this to see the exact hex values ' +
      'before calling refine_colors, since that tool rejects colours that are not in the palette.',
    inputSchema: {
      ...imageSourceShape,
      ...presetShape,
      ...settingsShape,
      threshold: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe('CIEDE2000 distance below which a pair is suggested for merging. Default 8.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runSuggestMerges(args as never);
    return respond(summary, structured);
  }
);

server.registerTool(
  'refine_colors',
  {
    title: 'Merge or remove colours and re-export',
    description:
      'Apply palette edits and re-export. Merging re-runs the trace with the merged palette, so the ' +
      'boundary between merged regions is never traced at all and the node count genuinely drops — ' +
      'unlike simply recolouring shapes. Removing a colour turns its area into transparency. ' +
      'Get exact hex values from suggest_color_merges first.',
    inputSchema: {
      ...imageSourceShape,
      ...presetShape,
      ...settingsShape,
      ...outputShape,
      merge: z
        .array(
          z.object({
            keep: z.string().describe('Hex colour that survives, e.g. "#e63946".'),
            absorb: z.array(z.string()).describe('Hex colours folded into `keep`.'),
          })
        )
        .optional()
        .describe('Groups of colours to fuse together.'),
      remove: z
        .array(z.string())
        .optional()
        .describe('Hex colours to delete outright. Their area becomes transparent.'),
      autoMergeBelowDeltaE: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe('Also merge every pair closer than this CIEDE2000 distance automatically.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runRefine(args as never);
    return respond(summary, structured);
  }
);

server.registerTool(
  'vectorize_batch',
  {
    title: 'Vectorize a folder of images',
    description:
      'Convert many images in one call, across worker threads. Tracing is CPU-bound, so this is ' +
      'several times faster than calling vectorize_image in a loop. ' +
      'Unsuitable images (photographs and the like) are skipped by default rather than converted ' +
      'into unusable files, and they are also the slowest to trace, so skipping them saves the most ' +
      'time. One unreadable file never aborts the run — it is reported and the rest continue. ' +
      'Existing outputs are left alone unless overwrite is set, and dryRun reports the plan without ' +
      'touching the disk. Start with dryRun when you are unsure of a path.',
    inputSchema: {
      directory: z
        .string()
        .optional()
        .describe('Folder of images to convert. Use this or `paths`, not both.'),
      paths: z
        .array(z.string())
        .optional()
        .describe('Explicit list of image files to convert.'),
      recursive: z
        .boolean()
        .optional()
        .describe('Search subfolders. Dot-directories are always skipped. The output tree mirrors the input.'),
      extensions: z
        .array(z.string())
        .optional()
        .describe('File extensions to include. Defaults to png, jpg, jpeg, webp, gif.'),
      outputDirectory: z
        .string()
        .optional()
        .describe('Where results are written. Required unless dryRun is set.'),
      minScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe(
          'Analyzer score below which a file is skipped. Default 35, which excludes photographs. Set 0 to convert everything regardless.'
        ),
      overwrite: z
        .boolean()
        .optional()
        .describe('Replace existing output files. Default false, which skips them and says so.'),
      dryRun: z
        .boolean()
        .optional()
        .describe('Report what would be converted without reading or writing anything. Default false.'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(32)
        .optional()
        .describe('Worker threads to use. Defaults to one fewer than the core count.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Stop after this many files. Capped at 500 per run.'),
      ...presetShape,
      ...settingsShape,
      format: outputShape.format,
      backgroundColor: outputShape.backgroundColor,
      rasterWidth: outputShape.rasterWidth,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runBatch(
      args as never,
      new URL('./batch-worker.js', import.meta.url)
    );
    return respond(summary, structured);
  }
);

server.registerTool(
  'compare_presets',
  {
    title: 'Compare presets on one image',
    description:
      'Trace the same image with several presets and report colours, pieces, nodes and file size for ' +
      'each, so you can pick on evidence instead of guessing. Useful when the intended output medium ' +
      'matters — cutting needs few pieces, editing needs few nodes.',
    inputSchema: {
      ...imageSourceShape,
      presets: z
        .array(z.enum(PRESET_IDS as [string, ...string[]]))
        .optional()
        .describe('Which presets to try. Defaults to all of them.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (args) => {
    const { summary, structured } = await runComparePresets(args as never);
    return respond(summary, structured);
  }
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.registerResource(
  'settings-guide',
  'perfectvector://guide',
  {
    title: 'Settings guide',
    description: 'How the vectorization settings interact and which to reach for when.',
    mimeType: 'text/markdown',
  },
  async () => ({
    contents: [
      {
        uri: 'perfectvector://guide',
        mimeType: 'text/markdown',
        text: SETTINGS_GUIDE,
      },
    ],
  })
);

server.registerResource(
  'presets',
  'perfectvector://presets',
  {
    title: 'Preset definitions',
    description: 'The preset list with exact option values, as JSON.',
    mimeType: 'application/json',
  },
  async () => ({
    contents: [
      {
        uri: 'perfectvector://presets',
        mimeType: 'application/json',
        text: JSON.stringify(PRESETS, null, 2),
      },
    ],
  })
);

const SETTINGS_GUIDE = `# PerfectVector settings

## Start here
Run \`analyze_image\` first. It classifies the artwork and recommends a preset. If the
verdict is \`poor\` the image is a photograph or gradient-heavy, and no settings will
rescue it — tracing produces flat colour bands, not a usable vector. Report that
rather than shipping the result.

## What each setting actually does

**maxColors** — Upper bound on the palette. If the image has fewer distinct colours
than this, they are preserved *bit-exactly* rather than re-quantised, so a brand hex
survives the round trip. Raise it for shaded artwork, lower it for cutting and screen
printing where every colour is a physical cost.

**detail** — Controls simplification. Around 50-60 removes the pixel staircase while
keeping shape. Above 90 the staircase starts to survive. Exactly 100 disables
simplification entirely, which is what you want for pixel art and nothing else.

**smoothing** — The turn angle above which a vertex is treated as a hard corner. Low
values keep corners sharp, which matters for lettering and geometric marks. High
values suit organic shapes. A 90 degree corner survives up to roughly 70.

**denoise** — Cleanup strength for compression artifacts. Applied adaptively: noise is
measured inside areas that should be flat, so clean artwork is never filtered.
Raise it for a re-saved JPEG, drop it to 0 for pixel art.

**background** — \`auto\` removes a flat backdrop that touches the frame edge, giving a
transparent SVG, while preserving enclosed areas of the same colour (the whites of an
eye stay filled). \`keep\` traces it as a normal layer.

**colorMergeThreshold** — CIEDE2000 distance below which two palette entries collapse.
Anti-aliasing and JPEG artifacts create near-duplicates that would otherwise each
become a layer.

**strokeMode** — Whether thin regions are recovered as stroked centrelines. A stroke
traced as a fill becomes two parallel outlines: correct, but useless as a plotter or
laser toolpath and several times the nodes. On the line-art sample, filled outlines
cost 228 nodes where centrelines cost 19, and the recovered \`stroke-width\` matched the
drawn thickness to within a rounding error.

Only regions whose *entire* boundary faces empty space are converted, because replacing
a fill with a stroke moves that colour's edge inward — doing it next to another colour
would open a gap. \`strokeReport.blockedByNeighbours\` counts the regions this rule
protected; removing the background usually unblocks them.

## Reading the results

- **colors** — layer count. More than the artwork visibly has means the palette is too large.
- **pieces** — discrete filled regions. A high count on simple art signals leftover speckle:
  raise \`denoise\` or \`minArea\`.
- **strokes** — recovered centrelines. A region becomes a piece or a stroke, never both.
- **nodes** — anchor points. This is the editability metric. A traced circle should be a
  handful of nodes, not hundreds.

## Formats

| Format | Use for | Notes |
|---|---|---|
| svg | design tools, web, cutting machines | Colours grouped per layer with ids |
| pdf | print shops | True vector paths, not a wrapped raster |
| eps | older RIPs, sign shops | PostScript paths |
| dxf | laser cutters, CNC, CAM | Curves flattened to polylines; layer names carry the exact hex |
| | | Recovered centrelines become open polylines on their own layers, named with the stroke width |
| png/jpeg | previews | Rasterized; needs SVG support in the local libvips |

## Known limits

Text comes back as letter-shaped paths, not editable type — the original font is not
recoverable from pixels. Detail that is not in the source is not invented. Centreline
recovery needs a free boundary, so a thin shape wedged between two other colours stays
a filled outline.
`;

// ---------------------------------------------------------------------------

function respond(summary: string, structured: unknown) {
  return {
    content: [
      { type: 'text' as const, text: summary },
      {
        type: 'text' as const,
        // The structured payload follows the summary so a model can act on the
        // headline numbers without parsing, and still reach exact values if needed.
        text: '```json\n' + JSON.stringify(structured, null, 2) + '\n```',
      },
    ],
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; anything human-readable must go to stderr.
  process.stderr.write('perfectvector MCP server ready on stdio\n');
}

main().catch((error) => {
  process.stderr.write(`perfectvector MCP server failed to start: ${describe(error)}\n`);
  process.exit(1);
});
