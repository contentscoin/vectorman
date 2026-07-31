import type { RasterImage } from '@perfectvector/core';

/**
 * Browser image decoding.
 *
 * Everything happens locally: the file never leaves the tab. That is a privacy
 * property worth having, and it also means conversion has no per-request cost.
 */

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Guard against a decode that would exhaust memory before tracing starts. */
const MAX_PIXELS = 40_000_000;

export interface DecodedImage extends RasterImage {
  /** Object URL for showing the original alongside the result. Revoke when done. */
  previewUrl: string;
  name: string;
  type: string;
  byteLength: number;
}

export async function decodeFile(file: File): Promise<DecodedImage> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`
    );
  }
  if (file.type && !ACCEPTED_TYPES.includes(file.type)) {
    throw new Error(`${file.type} is not supported. Use PNG, JPG, WebP or GIF.`);
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file could not be decoded as an image.');
  });

  try {
    return {
      ...bitmapToRaster(bitmap),
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      type: file.type || 'image/*',
      byteLength: file.size,
    };
  } finally {
    bitmap.close();
  }
}

/** Decode a same-origin URL, used for the sample images. */
export async function decodeUrl(url: string, name: string): Promise<DecodedImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${name} (${response.status}).`);
  const blob = await response.blob();
  const file = new File([blob], name, { type: blob.type });
  return decodeFile(file);
}

function bitmapToRaster(bitmap: ImageBitmap): RasterImage {
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    throw new Error(
      `That image is ${bitmap.width}x${bitmap.height}. The limit is ${MAX_PIXELS / 1e6} megapixels.`
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  // `willReadFrequently` avoids the GPU round trip, which is the slow path for a
  // single large getImageData call.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This browser did not provide a 2D canvas context.');

  context.drawImage(bitmap, 0, 0);
  const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);

  return { width: bitmap.width, height: bitmap.height, data: imageData.data };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
