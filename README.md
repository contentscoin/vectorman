# PerfectVector

Raster to clean, editable SVG. A working reimplementation of [perfectvector.com](https://perfectvector.com/),
built from scratch: the tracing engine, the web app, and an MCP plugin server.

```
packages/core   the vectorization engine — pure TypeScript, runs in a browser worker and in Node
packages/mcp    MCP server exposing the engine as tools for AI assistants
apps/web        Next.js landing page + a converter that runs entirely client-side
scripts/        verification suites and calibration tools
```

## What it does

Converts PNG/JPG into an SVG where each colour is its own `<g>` layer, holes are punched
correctly, and paths are few enough to actually edit. A 220px circle traces to **4 nodes**,
not 500.

| Sample | Colours | Pieces | Nodes | Raster in | SVG out |
|---|---|---|---|---|---|
| Flat badge logo | 4 | 4 | 34 | 18.3 KB | 1.5 KB |
| Same logo at JPEG quality 22 | 4 | 4 | 34 | 7.5 KB | 1.5 KB |
| Flat sticker illustration | 4 | 6 | 47 | 16.7 KB | 2.0 KB |
| Line art (10 centrelines) | 1 | 0 | 19 | 16.4 KB | 1.2 KB |
| Pixel art (traced literally) | 3 | 5 | 56 | 199 B | 0.8 KB |

Measured by `scripts/measure-samples.mjs`, which is also what generates the numbers the
landing page displays — so the marketing figures cannot drift from what the code does.

## Quick start

Requires Node 20+ and pnpm.

```bash
pnpm install

pnpm run build        # engine + MCP server
pnpm run build:web    # fixtures, measured sample stats, then the Next.js build
pnpm run dev:web      # http://localhost:3000

pnpm run fixtures     # regenerate the test artwork
pnpm run verify:all   # 336 checks across five suites
```

## The engine

```ts
import { vectorize, emitSvg, analyzeImage, resolvePreset } from '@perfectvector/core';

const image = { width, height, data: rgbaBytes };

const analysis = analyzeImage(image);
if (analysis.suitability === 'poor') {
  console.log(analysis.findings); // says why, e.g. "this is a photograph"
}

const result = vectorize(image, resolvePreset(analysis.recommended.presetId));
console.log(result.stats); // { colors: 4, pieces: 4, nodes: 34, ... }
console.log(emitSvg(result));
```

Also exports `exportPdf`, `exportEps`, `exportDxf`, `suggestMerges`, `remergeWithPalette`.

### Pipeline

```
downscale → harden alpha → denoise → quantize → drop background
  → despeckle → regions → planar trace → simplify & fit each shared boundary once
  → assemble outlines → rescale to source size
```

Stage order is load-bearing; each stage assumes the previous one removed a specific class of
defect. All cleanup happens on the **label map**, before any geometry exists, because
repairing a bad path is far harder than repairing the pixels that produced it.

### The part that matters most

The obvious design is: for each colour, build a mask, trace its outline, smooth it, emit a
path. It looks correct and it is what most tracers do. It also has a defect that appears the
moment anyone zooms in or sends the file to a cutter.

Two adjacent colours share a boundary. Traced independently, each side simplifies and
curve-fits that shared boundary *separately*. The anchors chosen differ, so the fitted curves
differ — by up to the simplification epsilon, around a pixel. The regions no longer meet:
they leave a hairline gap that renders as a bright seam, or they overlap and double-print.

`packages/core/src/trace/planar.ts` treats the label map as a planar subdivision instead.
Boundaries between regions become graph edges; junctions where three or more regions meet
become fixed nodes; the maximal runs between junctions are **chains**. Each chain is
simplified and fitted exactly once, and both adjacent regions reference the same fitted
curve, one of them reversed. They therefore agree exactly. As a bonus it is also faster,
since every shared boundary is fitted once instead of twice.

Verified directly: in the three-region junction test, all three colour layers place an anchor
on the identical point.

### Centreline recovery

A stroke traced as a filled region comes back as *two parallel outlines* with caps on
the ends. Geometrically faithful, and close to useless for what line art is actually
for: a plotter or laser wants one path to follow, and a designer wants one path whose
weight they can change.

With `strokeMode: 'auto'`, thin elongated regions are skeletonized (Zhang-Suen),
split into branches at junctions, spur-pruned, and fitted as single stroked paths.
On the line-art fixture:

| | Paths | Nodes | SVG |
|---|---|---|---|
| Filled outlines | 4 pieces | 228 | 5.3 KB |
| Centrelines | 10 strokes | **19** | **1.2 KB** |

The recovered `stroke-width` is 8.96px where the source was drawn at 9. It also looks
*better*: fitting one centreline is far better conditioned than fitting two outlines
9px apart, so the filled version's outlines visibly wobble where the centreline is
smooth.

Three details carry that result:

- **Deciding what is a stroke** compares area against the largest inscribed circle,
  `area / (4 * maxRadius^2)`. A disc scores 0.79 at any size; a stroke scores about
  its length-to-width ratio. So the threshold reads as "how many times longer than
  wide", rather than being a tuned constant.
- **The safety condition.** Replacing a fill with a stroke moves that colour's edge to
  the centreline, so a region is only converted when its *entire* boundary faces empty
  space. Ink on transparency qualifies; a line across a filled background does not,
  and stays filled. Otherwise this would reintroduce the very seam the planar tracer
  exists to prevent.
- **Width from area over fitted length**, with the eroded end caps added back.
  Sampling the distance transform is biased about a pixel low on even widths, because
  an 8px stroke has no centre *pixel*. Summing pixel steps is biased high on curves,
  because a staircase is longer than the arc it approximates. Measuring the fitted
  curve and correcting for the ends brings the error under 1%.

### Other decisions worth knowing

- **Exact colours for flat art.** If an image has few enough distinct colours, they are kept
  *bit-exactly* rather than re-quantised, so a brand hex survives the round trip. Colours that
  lie on the Lab segment between two chosen colours *and* cover under 2% of the artwork are
  anti-aliasing blends and get skipped — without that check, a four-colour illustration comes
  back with seven layers.
- **Denoising is adaptive.** A median filter shifts three-way junctions and chamfers corners
  by up to a pixel, so it only runs when noise is actually measured. Detection combines
  flat-area deviation with an overshoot test, both of which read exactly 0 on clean art no
  matter how heavily anti-aliased.
- **No majority label smoothing by default.** A single-pixel spur and a 90° convex corner have
  identical 8-neighbourhoods, so no threshold can remove one and keep the other. Sharp corners
  win; staircases are handled by simplification and curve fitting instead.
- **Honest suitability scoring.** Tracing a photograph cannot succeed — a photograph has no
  regions to find. `analyzeImage` says so up front rather than returning 40 layers of mush.

## MCP server

Seven tools over stdio: `list_presets`, `analyze_image`, `vectorize_image`,
`vectorize_batch`, `suggest_color_merges`, `refine_colors`, `compare_presets`. Plus a
settings guide resource.

```jsonc
{
  "mcpServers": {
    "perfectvector": {
      "command": "node",
      "args": ["/absolute/path/to/perfectvector/packages/mcp/dist/server.js"]
    }
  }
}
```

Responses lead with a readable summary — counts of colours, pieces and nodes — followed by a
JSON payload. Path data is enormous and tells a model nothing it can act on, so geometry is
written to disk unless inline output is explicitly requested.

```
> Vectorize ~/Desktop/client-logo.png as SVG

Vectorized 640x640 PNG using preset "logo" (auto-selected from image analysis).

  colors: 4   pieces: 4   nodes: 34 (41.1x fewer than a pixel-following trace)
  traced at 640x640 in 149ms
  output: SVG, 1.5 KB

Color layers:
  #1d3557  Dark Blue       58.2% of area, 1 piece(s), 12 nodes
  ...
```

## Verification

Nothing here is asserted without being checked. All four suites pass.

```bash
pnpm run verify          # 65 checks — synthetic shapes with known exact answers
pnpm run verify:strokes  # 51 checks — centreline recovery, widths, and the safety rule
pnpm run verify:real     # 39 checks — realistic fixtures with real AA and JPEG ringing
pnpm run verify:mcp      # 80 checks — the MCP server over real stdio JSON-RPC
pnpm run verify:batch    # 51 checks — folder conversion, safety guards, determinism
pnpm run verify:web      # 50 checks — headless Chromium driving the built app
pnpm run verify:all      # 336 checks
```

Synthetic input is the point of the first suite: for a 200px square the outline is exactly 4
nodes, so "4 nodes" is a pass and "37 nodes" is a specific, diagnosable failure. The browser
suite does real conversions in the page, edits the palette, and downloads all five formats,
checking each file's magic bytes.

Two scripts exist purely to set constants from measurement rather than guesswork:
`measure-noise.mjs` compares candidate noise metrics across the fixtures, and
`sweep-noisy.mjs` sweeps settings on a compressed JPEG. The latter is where the finding that
`colorMergeThreshold` — not `denoise` — is the dominant lever for JPEG came from: at the
default of 8 the result was 58 speckle pieces, and at 12 it was 4, matching the clean original.

### Batch conversion

`vectorize_batch` converts a folder across worker threads. The pool is not decoration:
tracing is synchronous CPU-bound JavaScript, measured at 210–1356ms per image against
1–7ms to decode one, so `Promise.all` would run it strictly one at a time. Work is
pulled from a shared queue rather than split up front, because per-image cost spans two
orders of magnitude and any static partition leaves threads idle.

On the 28-file fixture folder: **2.9s wall clock for 17.7s of tracing**, and 7.2s → 3.0s
against a single worker end to end (the gap is thread startup plus per-thread JIT warmup).

The guards matter more than the speed:

- Photographs are skipped by default rather than converted into unusable files — they
  are also the slowest to trace, so skipping them saves the most time.
- One unreadable file is reported and the run continues.
- Existing outputs are never replaced without `overwrite`, and `dryRun` reports the
  plan without touching the disk.
- The output tree mirrors the input, so the same basename in two folders cannot collide.

### A bug worth describing

Intermittently — roughly 1 conversion in 500, and only under worker threads — an entire
colour layer would vanish from the output. Chasing it ruled out a lot: the input bytes,
the decoded pixels and the resolved settings were identical; 400 in-process repeats and
280 interleaved conversions were stable; disabling the libvips cache changed nothing;
and the label map, component list and chain graph were bit-identical across 540 runs.

Two real defects surfaced on the way. `stats.nodes` was incremented before a region
could be discarded, so it described geometry that was never emitted — which is why the
symptom looked impossible ("a layer disappeared but the node count did not move"). And
`segments.push(...path.segments)` passes every element as a call argument, which is a
stack hazard precisely because worker threads get a smaller stack.

The fix that resolved it was not finding the float that flipped. Every connected region
has exactly one outer boundary — that is a property of connected sets, not an assumption
about this code. So when no loop is classified as an outline, the *classification* is
wrong, and the loop enclosing the most area is promoted instead of the region being
dropped. `stats.droppedRegions` must always be 0, `stats.repairedRegions` records when
this fired, and both are asserted. 1125 worker-thread conversions now produce identical
output, with the repair path firing about once in a thousand.

The underlying numeric cause is still unpinned, and the README says so rather than
implying otherwise. Guaranteeing the invariant was worth more than the diagnosis.

## Limits

These are properties of tracing, not gaps in the implementation.

- **Photographs and gradient-heavy art do not work.** Every band becomes a flat shape. The
  analyzer refuses them.
- **Text comes back as letter-shaped paths**, not editable type. The font is not recoverable
  from pixels.
- **Detail that is not in the source is not invented.** A 200px logo traces like a 200px logo.
- **Centreline recovery needs a free boundary.** A thin shape wedged between two other
  colours stays a filled outline, and `strokeReport.blockedByNeighbours` says how many
  did. Dropping the background usually unblocks them.

## Licence

MIT. Not affiliated with perfectvector.com; built as an engineering exercise.
