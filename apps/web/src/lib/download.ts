/**
 * Client-side file delivery.
 *
 * PNG and JPG are produced by drawing the SVG into a canvas here on the main
 * thread, because rasterizing needs an `Image`, which a worker has no access to.
 * The SVG is inlined as a data URL rather than a blob URL: an `<img>` loaded from
 * a blob URL is treated as cross-origin in some browsers, which taints the canvas
 * and makes `toBlob` throw a security error.
 */

const MIME: Record<string, string> = {
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  eps: 'application/postscript',
  dxf: 'application/dxf',
  png: 'image/png',
  jpg: 'image/jpeg',
};

export function downloadText(text: string, filename: string, extension: string): void {
  // PDF content is written as latin1 bytes, so it must not be re-encoded as UTF-8.
  const blob =
    extension === 'pdf'
      ? new Blob([latin1ToBytes(text)], { type: MIME.pdf })
      : new Blob([text], { type: MIME[extension] ?? 'text/plain' });

  triggerDownload(blob, filename);
}

export async function downloadRaster(
  svg: string,
  filename: string,
  format: 'png' | 'jpg',
  options: { width: number; height: number; scale?: number; background?: string | null }
): Promise<void> {
  const scale = options.scale ?? 1;
  const width = Math.max(1, Math.round(options.width * scale));
  const height = Math.max(1, Math.round(options.height * scale));

  const image = new Image();
  image.decoding = 'sync';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('The browser could not render the SVG to an image.'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser did not provide a 2D canvas context.');

  // JPEG has no alpha channel, so transparency has to land on something opaque.
  const background = format === 'jpg' ? (options.background ?? '#ffffff') : options.background;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }

  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, MIME[format], format === 'jpg' ? 0.92 : undefined)
  );
  if (!blob) throw new Error('The browser could not encode the image.');

  triggerDownload(blob, filename);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * PDF content is assembled as one byte per character, and its cross-reference table
 * stores absolute byte offsets. Letting `Blob` encode the string as UTF-8 would
 * widen every byte above 0x7f and shift all those offsets, producing a file that
 * most readers reject. So the bytes are written out explicitly.
 *
 * The buffer is allocated first and viewed second so the type is `ArrayBuffer`
 * rather than `ArrayBufferLike`, which is what `BlobPart` requires.
 */
function latin1ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(text.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** `logo.png` -> `logo.svg` */
export function swapExtension(name: string, extension: string): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'artwork';
  return `${base}.${extension}`;
}
