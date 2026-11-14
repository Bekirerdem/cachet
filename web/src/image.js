// Prepares a photo on the device before it is encrypted. Every photo is turned upright,
// scaled down to what the model needs and drawn again on a canvas, which drops the
// camera's location and device data. Hidden areas are painted into the pixels, so what
// is under them does not exist in the image that leaves the phone.
const MAX_SIDE = 2000;
const QUALITY = 0.85;

export async function prepareImage(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { canvas, preview: canvas.toDataURL('image/jpeg', QUALITY) };
}

/**
 * A PDF is drawn page by page on this device, into the same kind of canvas a photo becomes.
 * The reader for PDFs is loaded only when a PDF is chosen. Returns up to `limit` pages.
 */
export async function preparePdf(file, limit) {
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= Math.min(pdf.numPages, limit); n += 1) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pages.push({ canvas, preview: canvas.toDataURL('image/jpeg', QUALITY) });
  }
  await task.destroy();
  return pages;
}

/** Boxes are fractions of the page (x, y, w, h between 0 and 1). Returns the image that will be sent. */
export function seal(canvas, boxes) {
  if (boxes.length === 0) return canvas.toDataURL('image/jpeg', QUALITY);
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  context.fillStyle = '#0b0b14';
  for (const box of boxes) context.fillRect(Math.floor(box.x * copy.width), Math.floor(box.y * copy.height), Math.ceil(box.w * copy.width), Math.ceil(box.h * copy.height));
  return copy.toDataURL('image/jpeg', QUALITY);
}
