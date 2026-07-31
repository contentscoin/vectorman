/**
 * Exact Euclidean distance transform.
 *
 * For every foreground pixel, the distance to the nearest background pixel. Two
 * things downstream need it:
 *
 *  - **Stroke detection.** The largest inscribed radius in a region, compared to
 *    the region's area, is what distinguishes a long thin stroke from a blob.
 *  - **Width estimation.** Distance at a skeleton pixel is the stroke's
 *    half-width there, which is how a centreline recovers the `stroke-width` it
 *    should be drawn with.
 *
 * Implemented after Felzenszwalb and Huttenlocher (2012): the squared transform
 * is separable, so a 2D transform is two passes of a 1D transform, and each 1D
 * pass is the lower envelope of a set of parabolas computed in linear time. Total
 * cost is O(width * height), and the result is *exact* — not the approximation
 * that chamfer or 3x3 mask methods give, which is worth having because the
 * elongation test compares an area against the square of one of these radii, so
 * a few percent of radius error becomes a much larger error in the decision.
 */

const INFINITY = 1e20;

export interface DistanceField {
  /** Squared distance per pixel, in the mask's coordinate space. */
  squared: Float64Array;
  width: number;
  height: number;
}

/**
 * Squared Euclidean distance from each set pixel of `mask` to the nearest unset
 * pixel.
 *
 * Pixels outside the image are treated as foreground, i.e. the image border does
 * *not* cut the shape. That matters for both callers: a wide region that happens
 * to touch the edge would otherwise report a small inscribed radius and be
 * misread as a stroke, and a stroke running off the edge would report a width
 * that tapers to nothing.
 */
export function distanceTransform(
  mask: Uint8Array,
  width: number,
  height: number
): DistanceField {
  const squared = new Float64Array(width * height);

  for (let i = 0; i < squared.length; i++) {
    squared[i] = mask[i] ? INFINITY : 0;
  }

  const columnBuffer = new Float64Array(height);
  const columnResult = new Float64Array(height);
  const rowBuffer = new Float64Array(width);
  const rowResult = new Float64Array(width);

  // Scratch for the 1D pass, sized for the longer axis.
  const longest = Math.max(width, height);
  const vertices = new Int32Array(longest);
  const boundaries = new Float64Array(longest + 1);

  // Pass 1: down each column.
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) columnBuffer[y] = squared[y * width + x];
    lowerEnvelope(columnBuffer, columnResult, height, vertices, boundaries);
    for (let y = 0; y < height; y++) squared[y * width + x] = columnResult[y];
  }

  // Pass 2: along each row.
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) rowBuffer[x] = squared[rowStart + x];
    lowerEnvelope(rowBuffer, rowResult, width, vertices, boundaries);
    for (let x = 0; x < width; x++) squared[rowStart + x] = rowResult[x];
  }

  return { squared, width, height };
}

/**
 * 1D squared distance transform: the lower envelope of the parabolas
 * `(q - i)^2 + f[i]`.
 *
 * Each input value seeds a parabola. Sweeping left to right maintains the subset
 * of parabolas that form the envelope, popping any that the newest one hides. Each
 * parabola is pushed and popped at most once, so the pass is linear rather than
 * the quadratic cost of evaluating every parabola at every position.
 */
function lowerEnvelope(
  f: Float64Array,
  out: Float64Array,
  n: number,
  vertices: Int32Array,
  boundaries: Float64Array
): void {
  if (n === 0) return;
  if (n === 1) {
    out[0] = f[0];
    return;
  }

  let k = 0;
  vertices[0] = 0;
  boundaries[0] = -INFINITY;
  boundaries[1] = INFINITY;

  for (let q = 1; q < n; q++) {
    // Intersection of the new parabola with the rightmost one on the envelope.
    let s =
      (f[q] + q * q - (f[vertices[k]] + vertices[k] * vertices[k])) /
      (2 * q - 2 * vertices[k]);

    // If it lies left of where that parabola took over, that parabola is fully
    // hidden and comes off the envelope.
    while (k > 0 && s <= boundaries[k]) {
      k--;
      s =
        (f[q] + q * q - (f[vertices[k]] + vertices[k] * vertices[k])) /
        (2 * q - 2 * vertices[k]);
    }

    k++;
    vertices[k] = q;
    boundaries[k] = s;
    boundaries[k + 1] = INFINITY;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (boundaries[k + 1] < q) k++;
    const d = q - vertices[k];
    out[q] = d * d + f[vertices[k]];
  }
}

/** Distance in pixels at one location. */
export function distanceAt(field: DistanceField, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= field.width || y >= field.height) return 0;
  return Math.sqrt(field.squared[y * field.width + x]);
}

/** Largest inscribed radius in the mask, in pixels. */
export function maxInscribedRadius(field: DistanceField): number {
  let worst = 0;
  for (let i = 0; i < field.squared.length; i++) {
    if (field.squared[i] > worst && field.squared[i] < INFINITY) worst = field.squared[i];
  }
  return Math.sqrt(worst);
}
