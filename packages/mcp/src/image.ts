import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import sharp, { type Sharp } from 'sharp';
import type { RasterImage } from '@perfectvector/core';

/**
 * Node-side image I/O.
 *
 * The engine itself is platform-free and speaks only RGBA buffers, which is what
 * lets the same code run in a browser worker and here. This module is the only
 * place that knows about files and codecs.
 */

/** Refuse anything large enough to exhaust memory before tracing even starts. */
const MAX_PIXELS = 40_000_000;

/** Guard against a base64 payload big enough to be a denial of service. */
const MAX_INPUT_BYTES = 64 * 1024 * 1024;

export interface ImageSource {
  path?: string;
  base64?: string;
}

export interface LoadedImage {
  image: RasterImage;
  /** Where it came from, for messages. */
  origin: string;
  format: string;
  /** Bytes of the original encoded file. */
  byteLength: number;
}

export async function loadRaster(source: ImageSource): Promise<LoadedImage> {
  const { buffer, origin } = await readSource(source);

  let pipeline: Sharp;
  try {
    // `rotate()` with no argument applies EXIF orientation. Without it a photo
    // shot in portrait traces sideways.
    pipeline = sharp(buffer, { failOn: 'none' }).rotate();
  } catch (error) {
    throw new Error(`Could not open image (${origin}): ${describe(error)}`);
  }

  const metadata = await pipeline.metadata().catch((error: unknown) => {
    throw new Error(`Could not read image metadata (${origin}): ${describe(error)}`);
  });

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`Image has no usable dimensions (${origin}).`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(
      `Image is ${width}x${height} (${(width * height / 1e6).toFixed(1)} megapixels), ` +
        `above the ${MAX_PIXELS / 1e6} megapixel limit. Downscale it first.`
    );
  }

  // `ensureAlpha` guarantees 4 channels so the engine's stride assumption holds
  // for JPEG (3 channels) and greyscale (1 channel) input alike.
  const { data, info } = await pipeline
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(`Expected 4 channels after ensureAlpha, got ${info.channels}.`);
  }

  return {
    image: {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    },
    origin,
    format: metadata.format ?? 'unknown',
    byteLength: buffer.byteLength,
  };
}

async function readSource(source: ImageSource): Promise<{ buffer: Buffer; origin: string }> {
  if (source.path && source.base64) {
    throw new Error('Provide either `path` or `base64`, not both.');
  }

  if (source.path) {
    const absolute = resolve(source.path);
    const info = await stat(absolute).catch(() => null);
    if (!info) throw new Error(`No such file: ${absolute}`);
    if (!info.isFile()) throw new Error(`Not a file: ${absolute}`);
    if (info.size > MAX_INPUT_BYTES) {
      throw new Error(`File is ${formatBytes(info.size)}, above the ${formatBytes(MAX_INPUT_BYTES)} limit.`);
    }
    return { buffer: await readFile(absolute), origin: absolute };
  }

  if (source.base64) {
    // Accept a data URL as well as a bare base64 payload.
    const payload = source.base64.replace(/^data:[^;,]*;base64,/, '');
    const buffer = Buffer.from(payload, 'base64');
    if (buffer.byteLength === 0) {
      throw new Error('`base64` did not decode to any bytes.');
    }
    if (buffer.byteLength > MAX_INPUT_BYTES) {
      throw new Error(`Decoded ${formatBytes(buffer.byteLength)}, above the ${formatBytes(MAX_INPUT_BYTES)} limit.`);
    }
    return { buffer, origin: `inline base64 (${formatBytes(buffer.byteLength)})` };
  }

  throw new Error('An image is required: pass `path` or `base64`.');
}

/**
 * Rasterize an SVG to PNG or JPEG.
 *
 * Depends on the SVG support compiled into the local libvips. That is usually
 * present but not guaranteed, so the failure is reported as an actionable message
 * rather than a stack trace — the vector formats remain available either way.
 */
export async function rasterizeSvg(
  svg: string,
  format: 'png' | 'jpeg',
  options: { width?: number; background?: string } = {}
): Promise<Buffer> {
  try {
    let pipeline = sharp(Buffer.from(svg, 'utf8'), {
      density: 300,
      ...(options.width ? { limitInputPixels: false } : {}),
    });

    if (options.width) {
      pipeline = pipeline.resize({ width: options.width, fit: 'inside' });
    }

    if (format === 'jpeg') {
      // JPEG has no alpha, so transparency has to land on something.
      return await pipeline
        .flatten({ background: options.background ?? '#ffffff' })
        .jpeg({ quality: 92 })
        .toBuffer();
    }

    return await pipeline.png({ compressionLevel: 9 }).toBuffer();
  } catch (error) {
    throw new Error(
      `Could not rasterize the SVG to ${format}. This build of sharp/libvips may lack SVG ` +
        `support. The svg, pdf, eps and dxf formats do not need it. Original error: ${describe(error)}`
    );
  }
}

export async function writeOutput(path: string, contents: string | Buffer): Promise<string> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return absolute;
}

/** Swap or append an extension so an output path matches the chosen format. */
export function withExtension(path: string, extension: string): string {
  const current = extname(path);
  if (current.toLowerCase() === `.${extension}`) return path;
  if (current.length > 0) return path.slice(0, -current.length) + `.${extension}`;
  return `${path}.${extension}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
