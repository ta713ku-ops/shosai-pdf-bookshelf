import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
export { getDocument };
export type { PDFDocumentProxy };

async function coverFromDocument(pdf: PDFDocumentProxy): Promise<Blob> {
  const page = await pdf.getPage(1);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: 360 / original.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('表紙を作成できませんでした')), 'image/jpeg', 0.85));
}

export async function inspectPdf(file: Blob): Promise<{ pageCount: number; cover: Blob }> {
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    return { pageCount: pdf.numPages, cover: await coverFromDocument(pdf) };
  } finally { await task.destroy(); }
}

export async function generateCover(file: Blob): Promise<Blob> {
  return (await inspectPdf(file)).cover;
}
