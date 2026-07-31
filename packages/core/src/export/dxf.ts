import type { Point, RGB, VectorizeResult } from '../types.js';
import { flattenContour } from './flatten.js';

/**
 * DXF export, for laser cutters, routers and CAM software.
 *
 * Three decisions worth knowing about:
 *
 *  - **Curves are flattened.** DXF's spline entity is poorly and inconsistently
 *    supported across cutting software, and a mis-imported spline becomes a ruined
 *    workpiece. Closed polylines are understood by everything. The flattening
 *    tolerance defaults to 0.1px, finer than any hobby cutter can track.
 *  - **R12 output.** The oldest, most widely readable variant. Entities are plain
 *    `POLYLINE`/`VERTEX`/`SEQEND` groups rather than `LWPOLYLINE`, which did not
 *    exist until R14.
 *  - **Layer naming carries the exact color.** R12 only has the 255-entry ACI
 *    palette, so an exact RGB cannot be stored. The nearest ACI index is set for
 *    display, and the true hex goes in the layer name so nothing is lost.
 *
 * DXF is also y-up, so coordinates are flipped on the way out.
 */

export interface DxfExportOptions {
  /**
   * Curve flattening tolerance in source pixels.
   * @default 0.1
   */
  tolerance?: number;
  /**
   * Units per source pixel. Leave at 1 to keep pixel coordinates, or set to
   * 25.4/dpi for millimetres.
   * @default 1
   */
  unitsPerPixel?: number;
  /** Decimal places in coordinates. @default 4 */
  precision?: number;
}

export function exportDxf(result: VectorizeResult, options: DxfExportOptions = {}): string {
  const tolerance = options.tolerance ?? 0.1;
  const unitsPerPixel = options.unitsPerPixel ?? 1;
  const precision = options.precision ?? 4;

  const out: string[] = [];
  const pair = (code: number | string, value: string | number) => {
    out.push(String(code), String(value));
  };

  const layerNames = result.layers.map(
    (layer, index) => `PV_${String(index + 1).padStart(2, '0')}_${layer.hex.replace('#', '')}`
  );

  // Centrelines go on their own layers, named with the recovered stroke width, so a
  // CAM operator can select every 3px line at once.
  const strokeLayerNames = new Set<string>();
  result.layers.forEach((layer, index) => {
    for (const stroke of layer.strokes) {
      strokeLayerNames.add(
        `${layerNames[index]}_W${stroke.width.toFixed(2).replace('.', 'p')}`
      );
    }
  });

  // ---- HEADER --------------------------------------------------------------
  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1009');
  pair(9, '$INSBASE');
  pair(10, 0);
  pair(20, 0);
  pair(30, 0);
  pair(9, '$EXTMIN');
  pair(10, 0);
  pair(20, 0);
  pair(30, 0);
  pair(9, '$EXTMAX');
  pair(10, format(result.width * unitsPerPixel, precision));
  pair(20, format(result.height * unitsPerPixel, precision));
  pair(30, 0);
  pair(0, 'ENDSEC');

  // ---- TABLES --------------------------------------------------------------
  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, result.layers.length + strokeLayerNames.size + 1);

  pair(0, 'LAYER');
  pair(2, '0');
  pair(70, 0);
  pair(62, 7);
  pair(6, 'CONTINUOUS');

  result.layers.forEach((layer, index) => {
    pair(0, 'LAYER');
    pair(2, layerNames[index]);
    pair(70, 0);
    pair(62, nearestAciColor(layer.color));
    pair(6, 'CONTINUOUS');

    const aci = nearestAciColor(layer.color);
    for (const stroke of layer.strokes) {
      const name = `${layerNames[index]}_W${stroke.width.toFixed(2).replace('.', 'p')}`;
      if (!strokeLayerNames.has(name)) continue;
      strokeLayerNames.delete(name);
      pair(0, 'LAYER');
      pair(2, name);
      pair(70, 0);
      pair(62, aci);
      pair(6, 'CONTINUOUS');
    }
  });

  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  // ---- ENTITIES ------------------------------------------------------------
  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  /** Emit one polyline entity. `closed` sets the R12 closed flag. */
  const emitPolyline = (points: Point[], layerName: string, aci: number, closed: boolean) => {
    if (points.length < 2) return;

    pair(0, 'POLYLINE');
    pair(8, layerName);
    pair(62, aci);
    pair(66, 1); // vertices follow
    pair(70, closed ? 1 : 0);
    pair(10, 0);
    pair(20, 0);
    pair(30, 0);

    for (const point of points) {
      pair(0, 'VERTEX');
      pair(8, layerName);
      pair(10, format(point.x * unitsPerPixel, precision));
      // Flip y: DXF is y-up, source coordinates are y-down.
      pair(20, format((result.height - point.y) * unitsPerPixel, precision));
      pair(30, 0);
    }

    pair(0, 'SEQEND');
    pair(8, layerName);
  };

  result.layers.forEach((layer, index) => {
    const layerName = layerNames[index];
    const aci = nearestAciColor(layer.color);

    for (const shape of layer.shapes) {
      for (const contour of shape.contours) {
        const polygon = flattenContour(contour, tolerance);
        if (polygon.length < 3) continue;
        emitPolyline(polygon, layerName, aci, true);
      }
    }

    // Recovered centrelines are the ideal DXF payload: an open polyline down the
    // middle of a stroke is exactly the toolpath a laser or router wants, whereas
    // the filled outline of the same stroke would cut both of its edges instead.
    // Stroke width has no DXF equivalent, so it goes in the layer name.
    for (const stroke of layer.strokes) {
      const polyline = flattenContour(
        { start: stroke.start, segments: stroke.segments, signedArea: 0, isHole: false },
        tolerance
      );
      if (polyline.length < 2) continue;
      const strokeLayer = `${layerName}_W${stroke.width.toFixed(2).replace('.', 'p')}`;
      emitPolyline(polyline, strokeLayer, aci, stroke.closed);
    }
  });

  pair(0, 'ENDSEC');
  pair(0, 'EOF');

  return out.join('\n') + '\n';
}

/**
 * Nearest AutoCAD Color Index among the standard low indices.
 *
 * Only the basic entries are considered: the goal is a recognisable on-screen
 * color in CAM software, and the exact value already travels in the layer name.
 */
const ACI_BASIC: Array<[number, RGB]> = [
  [1, { r: 255, g: 0, b: 0 }],
  [2, { r: 255, g: 255, b: 0 }],
  [3, { r: 0, g: 255, b: 0 }],
  [4, { r: 0, g: 255, b: 255 }],
  [5, { r: 0, g: 0, b: 255 }],
  [6, { r: 255, g: 0, b: 255 }],
  [7, { r: 255, g: 255, b: 255 }],
  [8, { r: 128, g: 128, b: 128 }],
  [9, { r: 192, g: 192, b: 192 }],
  [250, { r: 51, g: 51, b: 51 }],
  [251, { r: 91, g: 91, b: 91 }],
  [252, { r: 132, g: 132, b: 132 }],
  [30, { r: 255, g: 127, b: 0 }],
  [140, { r: 0, g: 127, b: 255 }],
  [190, { r: 127, g: 0, b: 255 }],
  [90, { r: 0, g: 255, b: 127 }],
];

function nearestAciColor(rgb: RGB): number {
  let best = 7;
  let bestDistance = Infinity;

  for (const [index, candidate] of ACI_BASIC) {
    const dr = rgb.r - candidate.r;
    const dg = rgb.g - candidate.g;
    const db = rgb.b - candidate.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return best;
}

function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0.0';
  return value.toFixed(precision);
}
