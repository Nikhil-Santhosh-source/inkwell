// Turning PDFs and pictures into stored assets. All assets are JPEG, so PDF
// export can embed them as they are.

import { LEGACY_PAPER, PAGE_WIDTH, createPage, newId } from './model.js';

const MAX_IMAGE_SIDE = 1600; // px; larger pictures are scaled down
const PDF_RENDER_WIDTH = 1536; // px per PDF page: sharp at 2× zoom on iPad
const JPEG_QUALITY = 0.85;

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('Could not encode the image'));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

function whiteCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

// A picture file → { id, mime, bytes, width, height }, scaled to fit MAX_IMAGE_SIDE.
export async function imageFileToAsset(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const { canvas, ctx } = whiteCanvas(width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const bytes = await canvasToJpeg(canvas);
  canvas.width = canvas.height = 0;
  return { id: newId(), mime: 'image/jpeg', bytes, width, height };
}

let pdfjs = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import(new URL('../vendor/pdf.min.mjs', import.meta.url).href);
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

// A PDF file's bytes → notebook pages (each with the PDF page as its
// background picture) and their assets. onProgress(done, total) reports progress.
export async function pdfToPages(bytes, { onProgress } = {}) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: bytes }).promise;
  const pages = [];
  const assets = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const pdfPage = await pdf.getPage(n);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: PDF_RENDER_WIDTH / base.width });
      const width = Math.round(viewport.width);
      const height = Math.round(viewport.height);
      const { canvas, ctx } = whiteCanvas(width, height);
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;
      const asset = { id: newId(), mime: 'image/jpeg', bytes: await canvasToJpeg(canvas), width, height };
      canvas.width = canvas.height = 0; // free the memory now; iPad Safari is strict about it
      pdfPage.cleanup();

      const page = createPage(LEGACY_PAPER, Math.round((PAGE_WIDTH * height) / width));
      page.background = { assetId: asset.id };
      pages.push(page);
      assets.push(asset);
      onProgress?.(n, pdf.numPages);
    }
  } finally {
    await pdf.destroy();
  }
  return { pages, assets };
}
