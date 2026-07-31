import type { Contour, Point, StrokePath, VectorizeResult } from '../types.js';

/**
 * PDF export.
 *
 * Print shops ask for "a vector file" and usually mean PDF, so this writes real
 * vector path operators — not a raster wrapped in a PDF, which is exactly the
 * thing that gets orders rejected.
 *
 * Two details matter:
 *
 *  - **Coordinate flip.** PDF puts the origin at the bottom-left with y
 *    increasing upward, the opposite of SVG. A single `cm` transform at the top
 *    of the content stream handles it, so all path data can be emitted in source
 *    coordinates untouched.
 *  - **Fill rule.** The `f` operator is nonzero winding, which matches how the
 *    tracer winds holes against their outlines. Holes therefore work with no
 *    special handling.
 */

export interface PdfExportOptions {
  /**
   * Pixels per inch used to convert image pixels to PDF points.
   * @default 96
   */
  dpi?: number;
  /** Decimal places in coordinates. @default 3 */
  precision?: number;
  /** Paint a solid background rectangle first. */
  backgroundColor?: string | null;
  title?: string;
}

export function exportPdf(result: VectorizeResult, options: PdfExportOptions = {}): string {
  const dpi = options.dpi ?? 96;
  const precision = options.precision ?? 3;
  const scale = 72 / dpi;

  const pageWidth = result.width * scale;
  const pageHeight = result.height * scale;

  const content = buildContentStream(result, {
    scale,
    precision,
    pageHeight,
    backgroundColor: options.backgroundColor ?? null,
  });

  const title = options.title ?? 'Vectorized artwork';

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${format(pageWidth, 3)} ${format(pageHeight, 3)}] ` +
      `/Contents 4 0 R /Resources << >> ` +
      `/Group << /S /Transparency /CS /DeviceRGB >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title (${escapePdfString(title)}) /Producer (PerfectVector) /Creator (PerfectVector) >>`,
  ];

  // Offsets must be exact byte counts, so the body is assembled incrementally.
  // Everything emitted here is ASCII, which keeps character count equal to byte
  // count and avoids needing a real encoder.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  const total = objects.length + 1;

  pdf += `xref\n0 ${total}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${total} /Root 1 0 R /Info 5 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return pdf;
}

interface ContentConfig {
  scale: number;
  precision: number;
  pageHeight: number;
  backgroundColor: string | null;
}

function buildContentStream(result: VectorizeResult, config: ContentConfig): string {
  const lines: string[] = ['q'];

  // Flip the y axis and convert pixels to points in one transform.
  lines.push(
    `${format(config.scale, 6)} 0 0 ${format(-config.scale, 6)} 0 ${format(config.pageHeight, 6)} cm`
  );

  if (config.backgroundColor) {
    const rgb = parseHex(config.backgroundColor);
    if (rgb) {
      lines.push(`${pdfColor(rgb)} rg`);
      lines.push(`0 0 ${format(result.width, config.precision)} ${format(result.height, config.precision)} re f`);
    }
  }

  for (const layer of result.layers) {
    if (layer.shapes.length === 0 && layer.strokes.length === 0) continue;

    if (layer.shapes.length > 0) {
      lines.push(`${pdfColor(layer.color)} rg`);

      // All subpaths of one color are painted with a single `f`, so nonzero winding
      // resolves outlines and holes together.
      const ops: string[] = [];
      for (const shape of layer.shapes) {
        for (const contour of shape.contours) {
          ops.push(contourToPdfPath(contour, config.precision));
        }
      }
      if (ops.length > 0) {
        lines.push(ops.join('\n'));
        lines.push('f');
      }
    }

    if (layer.strokes.length > 0) {
      // Stroke colour is a separate graphics-state parameter from fill colour: `RG`
      // rather than `rg`. Setting only `rg` would stroke in the default black.
      lines.push(`${pdfColor(layer.color)} RG`);
      // Round caps and joins, matching the SVG output and covering junctions.
      lines.push('1 J 1 j');

      let currentWidth = -1;
      for (const stroke of layer.strokes) {
        const width = Math.round(stroke.width * 1000) / 1000;
        if (width !== currentWidth) {
          lines.push(`${format(width, config.precision)} w`);
          currentWidth = width;
        }
        lines.push(strokeToPdfPath(stroke, config.precision));
        // `S` strokes without closing; `s` would close the path first.
        lines.push(stroke.closed ? 'h S' : 'S');
      }
    }
  }

  lines.push('Q');
  return lines.join('\n');
}

function contourToPdfPath(contour: Contour, precision: number): string {
  const parts: string[] = [];
  const point = (p: Point) => `${format(p.x, precision)} ${format(p.y, precision)}`;

  parts.push(`${point(contour.start)} m`);

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

function strokeToPdfPath(stroke: StrokePath, precision: number): string {
  const parts: string[] = [];
  const point = (p: Point) => `${format(p.x, precision)} ${format(p.y, precision)}`;

  parts.push(`${point(stroke.start)} m`);
  for (const segment of stroke.segments) {
    if (segment.kind === 'line') {
      parts.push(`${point(segment.to)} l`);
    } else {
      parts.push(`${point(segment.c1)} ${point(segment.c2)} ${point(segment.to)} c`);
    }
  }

  return parts.join('\n');
}

function pdfColor(rgb: { r: number; g: number; b: number }): string {
  return `${format(rgb.r / 255, 4)} ${format(rgb.g / 255, 4)} ${format(rgb.b / 255, 4)}`;
}

function format(value: number, precision: number): string {
  if (!Number.isFinite(value)) return '0';
  let s = value.toFixed(precision);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
