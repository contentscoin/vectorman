import type { Lab, RGB } from '../types.js';

/**
 * Color space conversions and perceptual distance.
 *
 * Quantization happens in CIE L*a*b* rather than RGB because RGB distance badly
 * misjudges perceptual similarity: pure blue and pure green are equidistant from
 * black in RGB, but nowhere near it perceptually. Clustering in Lab is what keeps
 * a logo's two similar greys from collapsing while two nearly identical
 * anti-aliasing blues do collapse.
 */

// D65 reference white, 2-degree observer.
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Undo the sRGB transfer function for one 8-bit channel. */
export function srgbToLinear(channel8: number): number {
  return LINEAR_LUT[channel8 & 0xff];
}

function linearToSrgb8(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

const DELTA = 6 / 29;
const DELTA3 = DELTA * DELTA * DELTA;

function fLab(t: number): number {
  return t > DELTA3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
}

function fLabInverse(t: number): number {
  return t > DELTA ? t * t * t : 3 * DELTA * DELTA * (t - 4 / 29);
}

export function rgbToLab(rgb: RGB): Lab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;

  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToRgb(lab: Lab): RGB {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;

  const x = fLabInverse(fx) * XN;
  const y = fLabInverse(fy) * YN;
  const z = fLabInverse(fz) * ZN;

  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  return { r: linearToSrgb8(r), g: linearToSrgb8(g), b: linearToSrgb8(b) };
}

/**
 * Fill a Float32Array of packed Lab triples from packed RGBA bytes.
 * Writing into a caller-provided buffer avoids allocating an object per pixel,
 * which matters a lot at 1400x1400.
 */
export function rgbaToLabBuffer(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  out?: Float32Array
): Float32Array {
  const lab = out && out.length >= pixelCount * 3 ? out : new Float32Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const r = LINEAR_LUT[rgba[o]];
    const g = LINEAR_LUT[rgba[o + 1]];
    const b = LINEAR_LUT[rgba[o + 2]];

    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
    const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
    const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;

    const fx = x > DELTA3 ? Math.cbrt(x) : x / (3 * DELTA * DELTA) + 4 / 29;
    const fy = y > DELTA3 ? Math.cbrt(y) : y / (3 * DELTA * DELTA) + 4 / 29;
    const fz = z > DELTA3 ? Math.cbrt(z) : z / (3 * DELTA * DELTA) + 4 / 29;

    const t = i * 3;
    lab[t] = 116 * fy - 16;
    lab[t + 1] = 500 * (fx - fy);
    lab[t + 2] = 200 * (fy - fz);
  }
  return lab;
}

/** CIE76 deltaE. Fast, and adequate for the merge-threshold decision. */
export function deltaE76(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * CIEDE2000. Used for the user-facing "merge similar colors" threshold, where
 * CIE76's well-known blue-region inaccuracy would otherwise merge colors a
 * designer considers clearly distinct.
 */
export function deltaE2000(s1: Lab, s2: Lab): number {
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.hypot(s1.a, s1.b);
  const C2 = Math.hypot(s2.a, s2.b);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))); // 25^7
  const a1p = (1 + G) * s1.a;
  const a2p = (1 + G) * s2.a;

  const C1p = Math.hypot(a1p, s1.b);
  const C2p = Math.hypot(a2p, s2.b);

  const h1p = hueAngle(s1.b, a1p);
  const h2p = hueAngle(s2.b, a2p);

  const dLp = s2.L - s1.L;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(degToRad(dhp) / 2);

  const Lbarp = (s1.L + s2.L) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp: number;
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos(degToRad(hbarp - 30)) +
    0.24 * Math.cos(degToRad(2 * hbarp)) +
    0.32 * Math.cos(degToRad(3 * hbarp + 6)) -
    0.2 * Math.cos(degToRad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625));
  const RT = -RC * Math.sin(2 * degToRad(dTheta));

  const Lbarp50 = Math.pow(Lbarp - 50, 2);
  const SL = 1 + (0.015 * Lbarp50) / Math.sqrt(20 + Lbarp50);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;

  const termL = dLp / (kL * SL);
  const termC = dCp / (kC * SC);
  const termH = dHp / (kH * SH);

  return Math.sqrt(termL * termL + termC * termC + termH * termH + RT * termC * termH);
}

function hueAngle(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  const deg = Math.atan2(b, ap) * (180 / Math.PI);
  return deg >= 0 ? deg : deg + 360;
}

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    ((1 << 24) | (clamp8(rgb.r) << 16) | (clamp8(rgb.g) << 8) | clamp8(rgb.b))
      .toString(16)
      .slice(1)
  );
}

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Relative luminance per WCAG, used to pick readable text over a swatch. */
export function relativeLuminance(rgb: RGB): number {
  return (
    0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
  );
}

const HUE_NAMES: Array<[number, string]> = [
  [15, 'red'],
  [40, 'orange'],
  [65, 'yellow'],
  [95, 'lime'],
  [150, 'green'],
  [185, 'teal'],
  [210, 'cyan'],
  [250, 'blue'],
  [280, 'indigo'],
  [310, 'purple'],
  [340, 'pink'],
  [360, 'red'],
];

/**
 * Short human-readable color label for the layer list. Not a marketing color
 * dictionary, just enough for a designer to tell two layers apart at a glance.
 */
export function describeColor(rgb: RGB): string {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2 / 255;
  const chroma = (max - min) / 255;

  if (chroma < 0.08) {
    if (lightness > 0.96) return 'White';
    if (lightness > 0.75) return 'Light grey';
    if (lightness > 0.45) return 'Grey';
    if (lightness > 0.15) return 'Dark grey';
    return 'Black';
  }

  let hue = 0;
  if (max === r) hue = ((g - b) / (max - min)) * 60;
  else if (max === g) hue = (2 + (b - r) / (max - min)) * 60;
  else hue = (4 + (r - g) / (max - min)) * 60;
  if (hue < 0) hue += 360;

  let base = 'red';
  for (const [limit, name] of HUE_NAMES) {
    if (hue < limit) {
      base = name;
      break;
    }
  }

  let modifier = '';
  if (lightness > 0.82) modifier = 'Pale ';
  else if (lightness > 0.62) modifier = 'Light ';
  else if (lightness < 0.2) modifier = 'Deep ';
  else if (lightness < 0.38) modifier = 'Dark ';
  else if (chroma > 0.7) modifier = 'Vivid ';

  return modifier + base.charAt(0).toUpperCase() + base.slice(1);
}

/** Disambiguate repeated labels so the layer list never shows two identical names. */
export function uniquifyNames(names: string[]): string[] {
  const counts = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const n of names) totals.set(n, (totals.get(n) ?? 0) + 1);

  return names.map((n) => {
    if ((totals.get(n) ?? 0) <= 1) return n;
    const next = (counts.get(n) ?? 0) + 1;
    counts.set(n, next);
    return `${n} ${next}`;
  });
}
