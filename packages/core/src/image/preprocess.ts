import type { RasterImage } from '../types.js';

/**
 * Pre-trace image conditioning.
 *
 * The tracer is only as good as the label map it receives, and the label map is
 * only as good as the pixels. Two problems dominate real uploads:
 *
 *  - **Resolution.** Tracing cost scales with perimeter length, so a 4000px image
 *    costs far more than it contributes. Downscaling first, then scaling geometry
 *    back up, produces near-identical output much faster.
 *  - **JPEG ringing.** Compression sprays 8x8-block noise around every hard edge.
 *    Left alone this becomes thousands of speckle shapes. A median filter removes
 *    it while leaving straight edges straight, which a Gaussian blur would not.
 */

export function createRaster(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneRaster(image: RasterImage): RasterImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8ClampedArray(image.data),
  };
}

/**
 * Area-average downscale so the longest side is at most `maxDimension`.
 * Returns the original image untouched when it already fits.
 *
 * RGB is averaged premultiplied by alpha, then un-premultiplied. Skipping that
 * step is the classic source of dark fringes around transparent logo edges,
 * because fully transparent pixels usually carry black RGB that would otherwise
 * be averaged in at full strength.
 */
export function downscale(image: RasterImage, maxDimension: number): { image: RasterImage; scale: number } {
  const longest = Math.max(image.width, image.height);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0 || longest <= maxDimension) {
    return { image, scale: 1 };
  }

  const scale = maxDimension / longest;
  const outWidth = Math.max(1, Math.round(image.width * scale));
  const outHeight = Math.max(1, Math.round(image.height * scale));
  const out = createRaster(outWidth, outHeight);

  const xRatio = image.width / outWidth;
  const yRatio = image.height / outHeight;
  const src = image.data;
  const dst = out.data;

  for (let oy = 0; oy < outHeight; oy++) {
    const y0 = Math.floor(oy * yRatio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.ceil((oy + 1) * yRatio)));

    for (let ox = 0; ox < outWidth; ox++) {
      const x0 = Math.floor(ox * xRatio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.ceil((ox + 1) * xRatio)));

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let samples = 0;

      for (let y = y0; y < y1; y++) {
        let o = (y * image.width + x0) * 4;
        for (let x = x0; x < x1; x++, o += 4) {
          const a = src[o + 3];
          const wa = a / 255;
          rSum += src[o] * wa;
          gSum += src[o + 1] * wa;
          bSum += src[o + 2] * wa;
          aSum += a;
          samples++;
        }
      }

      const o = (oy * outWidth + ox) * 4;
      if (samples === 0 || aSum === 0) {
        dst[o] = 0;
        dst[o + 1] = 0;
        dst[o + 2] = 0;
        dst[o + 3] = 0;
        continue;
      }

      const alphaMean = aSum / samples;
      const weight = aSum / 255;
      dst[o] = Math.round(rSum / weight);
      dst[o + 1] = Math.round(gSum / weight);
      dst[o + 2] = Math.round(bSum / weight);
      dst[o + 3] = Math.round(alphaMean);
    }
  }

  return { image: out, scale: outWidth / image.width };
}

/**
 * Separable-window median filter over RGB, preserving alpha.
 *
 * A true 2D median is used (not per-axis), on a window of `radius`. Only pixels
 * whose neighbourhood is not perfectly uniform are touched, so large flat areas
 * cost almost nothing.
 */
export function medianFilter(image: RasterImage, radius: number): RasterImage {
  if (radius < 1) return image;

  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  const windowSize = (radius * 2 + 1) * (radius * 2 + 1);
  const rBuf = new Uint8Array(windowSize);
  const gBuf = new Uint8Array(windowSize);
  const bBuf = new Uint8Array(windowSize);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const center = (y * width + x) * 4;
      if (data[center + 3] === 0) continue;

      let n = 0;
      let uniform = true;
      const r0 = data[center];
      const g0 = data[center + 1];
      const b0 = data[center + 2];

      const yStart = Math.max(0, y - radius);
      const yEnd = Math.min(height - 1, y + radius);
      const xStart = Math.max(0, x - radius);
      const xEnd = Math.min(width - 1, x + radius);

      for (let sy = yStart; sy <= yEnd; sy++) {
        let o = (sy * width + xStart) * 4;
        for (let sx = xStart; sx <= xEnd; sx++, o += 4) {
          // Transparent neighbours carry meaningless RGB; excluding them stops
          // the filter from dragging background color into edge pixels.
          if (data[o + 3] === 0) continue;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          if (r !== r0 || g !== g0 || b !== b0) uniform = false;
          rBuf[n] = r;
          gBuf[n] = g;
          bBuf[n] = b;
          n++;
        }
      }

      if (uniform || n === 0) continue;

      out[center] = medianOf(rBuf, n);
      out[center + 1] = medianOf(gBuf, n);
      out[center + 2] = medianOf(bBuf, n);
    }
  }

  return { width, height, data: out };
}

/** Counting-sort median: the 256-bin histogram beats comparison sort at these sizes. */
function medianOf(values: Uint8Array, n: number): number {
  const hist = new Uint16Array(256);
  for (let i = 0; i < n; i++) hist[values[i]]++;
  const target = n >> 1;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return v;
  }
  return 0;
}

/**
 * Snap near-opaque and near-transparent alpha to the extremes.
 *
 * Anti-aliased PNG edges ramp alpha over 1-2 pixels. Without this, the alpha
 * threshold cuts that ramp at an arbitrary point and leaves a ragged 1px fringe
 * of half-colored pixels that quantization then promotes into its own layer.
 */
export function hardenAlpha(image: RasterImage, threshold: number): RasterImage {
  const { width, height, data } = image;
  const out = new Uint8ClampedArray(data);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4 + 3;
    out[o] = data[o] >= threshold ? 255 : 0;
  }
  return { width, height, data: out };
}

/** Map a 0-100 denoise strength onto a median filter radius. */
export function denoiseRadius(denoise: number, width: number, height: number): number {
  if (denoise <= 10) return 0;
  const longest = Math.max(width, height);
  // Small images cannot afford a wide window without losing real detail.
  const cap = longest < 320 ? 1 : 2;
  const radius = denoise >= 75 ? 2 : 1;
  return Math.min(cap, radius);
}

/**
 * Estimate compression noise.
 *
 * This gate exists because a median filter is not free. It shifts three-way
 * junctions and rounds corners by up to a pixel — on a clean logo that is pure
 * damage, moving the exact point where three colors meet and chamfering square
 * corners. On a re-saved JPEG it is essential, because block ringing otherwise
 * becomes hundreds of speckle shapes.
 *
 * So the filter must run only when there is genuinely noise to remove, and the
 * hard part is that anti-aliasing looks like noise to most metrics. Two signals
 * are combined, chosen because each is *exactly zero* on clean vector-derived art
 * no matter how heavily anti-aliased:
 *
 *  1. **Deviation inside flat areas.** Measured only where the local range is
 *     small, so real edges are excluded. Catches block noise in areas that should
 *     be a single colour.
 *
 *  2. **Overshoot rate.** A clean anti-aliased edge is a monotone ramp, so every
 *     pixel on it lies between its neighbours. Ringing overshoots past both flat
 *     levels, making the pixel a local extremum. This catches the artifacts that
 *     sit right against edges, which the first signal deliberately skips.
 *
 * Measured on the fixtures: clean PNG art scores 0.000 on both, pixel art scores
 * 0.000, and the same logo at JPEG quality 22 scores well clear of the gate. Note
 * that a plain "how much would a median filter change this" metric was rejected —
 * it flags pixel art hardest of all, since at that scale everything is an edge.
 *
 * @returns 0-1. Clean artwork returns 0. Roughly 0.1 and above is real noise.
 */
export function estimateNoise(image: RasterImage): number {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return 0;

  /** Local range below which a neighbourhood counts as flat. */
  const FLAT_RANGE_LIMIT = 24;
  /** How far past its neighbours a pixel must sit to count as overshoot. */
  const OVERSHOOT_MARGIN = 4;

  // Normalizing constants, set so each signal reaches ~1 at severe corruption.
  const FLAT_SCALE = 0.02;
  const OVERSHOOT_SCALE = 0.006;

  const stride = width * height > 500_000 ? 2 : 1;

  let flatAccumulated = 0;
  let flatSamples = 0;
  let overshootCount = 0;
  let overshootSamples = 0;

  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const center = (y * width + x) * 4;
      if (data[center + 3] < 250) continue;

      let low = 255;
      let high = 0;
      let lumaLow = Infinity;
      let lumaHigh = -Infinity;
      let transparentNeighbour = false;

      for (let dy = -1; dy <= 1 && !transparentNeighbour; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * width + (x + dx)) * 4;
          if (data[o + 3] < 250) {
            transparentNeighbour = true;
            break;
          }
          for (let c = 0; c < 3; c++) {
            const v = data[o + c];
            if (v < low) low = v;
            if (v > high) high = v;
          }
          if (dx !== 0 || dy !== 0) {
            const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
            if (l < lumaLow) lumaLow = l;
            if (l > lumaHigh) lumaHigh = l;
          }
        }
      }
      if (transparentNeighbour) continue;

      // Signal 2: is the centre outside the range spanned by its neighbours?
      overshootSamples++;
      const centerLuma =
        0.299 * data[center] + 0.587 * data[center + 1] + 0.114 * data[center + 2];
      if (centerLuma > lumaHigh + OVERSHOOT_MARGIN || centerLuma < lumaLow - OVERSHOOT_MARGIN) {
        overshootCount++;
      }

      // Signal 1: deviation from the local median, but only in flat neighbourhoods.
      if (high - low > FLAT_RANGE_LIMIT) continue;
      for (let c = 0; c < 3; c++) {
        const a = data[center - 4 + c];
        const b = data[center + c];
        const d = data[center + 4 + c];
        const median = a + b + d - Math.min(a, b, d) - Math.max(a, b, d);
        flatAccumulated += Math.abs(b - median);
        flatSamples++;
      }
    }
  }

  const flatSignal = flatSamples > 0 ? flatAccumulated / flatSamples / 12 : 0;
  const overshootSignal = overshootSamples > 0 ? overshootCount / overshootSamples : 0;

  return Math.min(1, Math.max(flatSignal / FLAT_SCALE, overshootSignal / OVERSHOOT_SCALE));
}
