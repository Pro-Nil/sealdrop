// pdf.js, bundled and served from this origin (no CDN), loaded only when a PDF appears.

import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { h } from './ui.ts';

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

export function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [m, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    m.GlobalWorkerOptions.workerSrc = worker.default;
    return m;
  })();
  return lib;
}

export async function loadPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  return m.getDocument({
    data: data.slice(),
    enableXfa: false,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
  }).promise;
}

export async function renderPage(page: PDFPageProxy, scale: number): Promise<{ canvas: HTMLCanvasElement; viewport: PageViewport }> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport }).promise;
  return { canvas, viewport };
}

/** Scrollable page list; pages render when they come near the viewport. */
export async function renderPdfInto(container: HTMLElement, data: Uint8Array): Promise<void> {
  const doc = await loadPdf(data);
  const pages = h('div', { class: 'pdf-pages' });
  container.append(h('div', { class: 'pdf-meta' }, `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`), pages);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const observer = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const slot = entry.target as HTMLElement;
      observer.unobserve(slot);
      const page = await doc.getPage(Number(slot.dataset.page));
      const base = page.getViewport({ scale: 1 });
      const scale = (slot.clientWidth / base.width) * dpr;
      const { canvas } = await renderPage(page, scale);
      canvas.className = 'pdf-canvas';
      slot.replaceChildren(canvas);
    }
  }, { rootMargin: '600px 0px' });

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const slot = h('div', { class: 'pdf-page', 'data-page': i, 'aria-label': `Page ${i}` });
    slot.style.aspectRatio = `${vp.width} / ${vp.height}`;
    pages.append(slot);
    observer.observe(slot);
  }
}

/** Plain text of every page, separated by page markers. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  const doc = await loadPdf(data);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str + (item.hasEOL ? '\n' : '');
    }
    out.push(`--- Page ${i} ---\n${text.trim()}`);
  }
  return out.join('\n\n');
}
