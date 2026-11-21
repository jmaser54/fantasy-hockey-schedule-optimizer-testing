/**
 * Screenshot text recognition for Upload Image. Runs Tesseract.js in Web Workers, entirely in the
 * browser: images never leave the device. The engine (about 4.4 MB over the network on first use,
 * then cached by the browser) is loaded only when the user picks a screenshot; the library itself is
 * a separate chunk, so the rest of the site never downloads it.
 */
import type { Worker } from 'tesseract.js';

const OCR_PATH = `${import.meta.env.BASE_URL}ocr/`;
/** Large screenshots are scaled down to this width: plenty for names, much faster to read. */
const MAX_WIDTH = 1600;
/** Up to two workers read screenshots in parallel. */
const MAX_WORKERS = 2;

let pool: Promise<Worker>[] = [];
let busy = 0;

async function createOcrWorker(): Promise<Worker> {
  const { createWorker, OEM } = await import('tesseract.js');
  return createWorker('eng', OEM.LSTM_ONLY, { workerPath: `${OCR_PATH}worker.min.js`, corePath: OCR_PATH, langPath: OCR_PATH, gzip: true });
}

/** Start loading the engine early (e.g. when Upload Image is opened) so the first read is quicker. */
export function warmUpOcr(): Promise<unknown> {
  if (pool.length === 0) pool.push(createOcrWorker());
  return pool[0]!;
}

async function acquire(): Promise<Worker> {
  if (pool.length === 0) pool.push(createOcrWorker());
  else if (busy >= pool.length && pool.length < MAX_WORKERS) pool.push(createOcrWorker());
  const w = pool[busy % pool.length]!;
  busy++;
  return w;
}

/** Greyscale, invert dark-mode screenshots (dark text on light reads best) and cap the width. */
async function prepare(file: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const y = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    px[i] = px[i + 1] = px[i + 2] = y;
    sum += y;
  }
  if (sum / (px.length / 4) < 110) for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i]!;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Read the text in one screenshot. */
export async function readScreenshot(file: Blob): Promise<string> {
  const [canvas, worker] = await Promise.all([prepare(file), acquire()]);
  try {
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    busy--;
  }
}
