import type { Contour, Point, StrokePath, VectorizeResult } from '../types.js';

/**
 * Encapsulated PostScript export.
 *
 * Still the lingua franca for older RIPs, sign shops and vinyl cutters. Like PDF,
 * PostScript is y-up, so a single `concat` at the top flips the space and lets
 * path data be emitted in source coordinates. `fill` is nonzero winding, matching
 * how the tracer winds holes.
 *
 * Short operator aliases are defined in the prolog. On artwork with thousands of
 * curve operators this measurably shrinks the file, and every PostScript
 * interpreter handles it.
 */

export interface EpsExportOptions {
  /** Pixels per inch used to convert pixels to PostScript points. @default 96 */
  dpi?: number;
  /** Decimal places in coordinates. @default 3 */
  precision?: number;
  backgroundColor?: string | null;
  title?: string;
}

export function exportEps(result: VectorizeResult, options: EpsExportOptions = {}): string {
  const dpi = options.dpi ?? 96;
  const precision = options.precision ?? 3;
  const scale = 72 / dpi;

  const pageWidth = result.width * scale;
  const pageHeight = result.height * scale;
  const title = options.title ?? 'Vectorized artwork';

  const lines: string[] = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(pageWidth)} ${Math.ceil(pageHeight)}`,
    `%%HiResBoundingBox: 0 0 ${format(pageWidth, 4)} ${format(pageHeight, 4)}`,
    '%%Creator: PerfectVector',
    `%%Title: ${sanitizeComment(title)}`,
    `%%LanguageLevel: 2`,
    '%%EndComments',
    '%%BeginProlog',
    '/m {moveto} bind def',
    '/l {lineto} bind def',
    '/c {curveto} bind def',
    '/h {closepath} bind def',
    '/f {fill} bind def',
    '/s {stroke} bind def',
    '/k {setrgbcolor} bind def',
    '%%EndProlog',
    '%%Page: 1 1',
    'gsave',
    `[${format(scale, 6)} 0 0 ${format(-scale, 6)} 0 ${format(pageHeight, 6)}] concat`,
  ];

  if (options.backgroundColor) {
    const rgb = parseHex(options.backgroundColor);
    if (rgb) {
      lines.push(`${psColor(rgb)} k`);
      lines.push(
        `newpath 0 0 m ${format(result.width, precision)} 0 l ` +
          `${format(result.width, precision)} ${format(result.height, precision)} l ` +
          `0 ${format(result.height, precision)} l h f`
      );
    }
  }

  for (const layer of result.layers) {
    if (layer.shapes.length === 0 && layer.strokes.length === 0) continue;

    lines.push(`%% layer ${layer.index + 1}: ${sanitizeComment(layer.name)} ${layer.hex}`);
    lines.push(`${psColor(layer.color)} k`);

    if (layer.shapes.length > 0) {
      lines.push('newpath');
      for (const shape of layer.shapes) {
        for (const contour of shape.contours) {
          lines.push(contourToPostScript(contour, precision));
        }
      }
      // One fill for all subpaths of the color, so nonzero winding resolves holes.
      lines.push('f');
    }

    if (layer.strokes.length > 0) {
      // Round caps and joins, matching the SVG output.
      lines.push('1 setlinecap 1 setlinejoin');

      let currentWidth = -1;
      for (const stroke of layer.strokes) {
        const width = Math.round(stroke.width * 1000) / 1000;
        if (width !== currentWidth) {
          lines.push(`${format(width, precision)} setlinewidth`);
          currentWidth = width;
        }
        lines.push('newpath');
        lines.push(strokeToPostScript(stroke, precision));
        if (stroke.closed) lines.push('h');
        lines.push('s');
      }
    }
  }

  lines.push('grestore', 'showpage', '%%EOF');
  return lines.join('\n') + '\n';
}

function contourToPostScript(contour: Contour, precision: number): string {
  const point = (p: Point) => `${format(p.x, precision)} ${format(p.y, precision)}`;
  const parts: string[] = [`${point(contour.start)} m`];

  for (const segment of contour.segments) {
    if (segment.kind === 'line') {
      parts.push(`${point(segment.to)} l`);
    } else {
      parts.push(`${point(segment.c1)} ${point(segment.c2)} ${point(segment.to)} c`);
    }
  }

  parts.push('h');
  return parts.join('\n');
}

function strokeToPostScript(stroke: StrokePath, precision: number): string {
  const point = (p: Point) => `${format(p.x, precision)} ${format(p.y, precision)}`;
  const parts: string[] = [`${point(stroke.start)} m`];

  for (const segment of stroke.segments) {
    if (segment.kind === 'line') {
      parts.push(`${point(segment.to)} l`);
    } else {
      parts.push(`${point(segment.c1)} ${point(segment.c2)} ${point(segment.to)} c`);
    }
  }

  return parts.join('\n');
}

function psColor(rgb: { r: number; g: number; b: number }): string {
  return `${format(rgb.r / 255, 4)} ${format(rgb.g / 255, 4)} ${format(rgb.b / 255, 4)}`;
}

function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0';
  let s = value.toFixed(precision);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

function sanitizeComment(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
