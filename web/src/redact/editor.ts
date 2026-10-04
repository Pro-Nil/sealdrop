// Redact a file locally before it is encrypted. Resolves with the redacted File, or null if cancelled.

import { h, toast } from '../lib/ui.ts';
import { DEFAULT_KINDS, DETECTORS, applyRedactions, detectPII, parseTerms, type Finding } from './pii.ts';

type Mode = 'text' | 'pdf' | 'image';

export function redactMode(file: File, type: string): Mode | null {
  if (type === 'application/pdf') return 'pdf';
  if (/^image\/(png|jpeg|webp|gif|bmp)$/.test(type)) return 'image';
  if (/^(text\/|application\/(json|xml))/.test(type) && file.size <= 10 * 1024 * 1024) return 'text';
  return null;
}

function baseName(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name, ''];
}

// ---------- dialog shell ----------

interface Shell {
  dialog: HTMLDialogElement;
  body: HTMLElement;
  footer: HTMLElement;
  close: (result: File | null) => void;
  result: Promise<File | null>;
}

function shell(title: string): Shell {
  const body = h('div', { class: 'dialog-body' });
  const footer = h('div', { class: 'dialog-footer' });
  const dialog = h('dialog', { class: 'dialog', 'aria-label': title },
    h('div', { class: 'dialog-head' }, h('h2', {}, title), h('button', { class: 'btn ghost', type: 'button', onclick: () => close(null) }, 'Close')),
    body, footer);
  let resolve!: (f: File | null) => void;
  const result = new Promise<File | null>((r) => (resolve = r));
  const close = (f: File | null) => { dialog.close(); dialog.remove(); resolve(f); };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, body, footer, close, result };
}

function kindToggles(kinds: Set<string>): HTMLElement {
  return h('fieldset', { class: 'kinds' }, h('legend', {}, 'Detect'),
    ...DETECTORS.map((d) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: kinds.has(d.kind), onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) kinds.add(d.kind); else kinds.delete(d.kind);
      } }), d.label)));
}

function termsInput(): HTMLInputElement {
  return h('input', { type: 'text', class: 'input', placeholder: 'Also hide: your name, address, account no… (comma separated)', 'aria-label': 'Custom words to hide' });
}

// ---------- entry ----------

export async function openRedactor(file: File, type: string): Promise<File | null> {
  const mode = redactMode(file, type);
  if (mode === 'text') return textRedactor(await file.text(), file.name, type);
  if (mode === 'image') return boxRedactor(file, 'image');
  if (mode === 'pdf') {
    const choice = await new Promise<'text' | 'boxes' | null>((resolve) => {
      const s = shell('Redact PDF');
      const pick = (how: 'text' | 'boxes') => { resolve(how); s.close(null); };
      s.result.then(() => resolve(null)); // no-op if a choice was already made
      s.body.append(
        h('p', {}, 'How should the PDF be redacted?'),
        h('div', { class: 'choice-grid' },
          h('button', { class: 'choice', type: 'button', onclick: () => pick('text') },
            h('strong', {}, 'Extract text, then redact'), h('span', {}, 'Best for AI. Produces a clean .txt that any AI reads reliably. Layout and images are dropped.')),
          h('button', { class: 'choice', type: 'button', onclick: () => pick('boxes') },
            h('strong', {}, 'Black out areas'), h('span', {}, 'Keeps the look. Pages become images, so AI has to read them visually (OCR).'))),
      );
    });
    if (!choice) return null;
    if (choice === 'text') {
      const { extractPdfText } = await import('../lib/pdf.ts');
      let text: string;
      try {
        text = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
      } catch {
        toast('Could not read text from this PDF', 'err');
        return null;
      }
      if (!text.replace(/--- Page \d+ ---/g, '').trim()) toast('This PDF has no text layer (scanned?). Use "Black out areas" instead.', 'err');
      return textRedactor(text, `${baseName(file.name)[0]}.txt`, 'text/plain');
    }
    return boxRedactor(file, 'pdf');
  }
  return null;
}

// ---------- text ----------

async function textRedactor(initial: string, name: string, type: string): Promise<File | null> {
  const s = shell('Redact text');
  const kinds = new Set(DEFAULT_KINDS);
  const terms = termsInput();
  const area = h('textarea', { class: 'redact-text mono', spellcheck: 'false', 'aria-label': 'File text' });
  area.value = initial;
  const list = h('div', { class: 'findings' });
  let findings: Finding[] = [];

  const scan = () => {
    findings = detectPII(area.value, kinds, parseTerms(terms.value));
    list.replaceChildren();
    if (!findings.length) { list.append(h('p', { class: 'hint' }, 'Nothing found. You can still edit the text directly.')); return; }
    const boxes = findings.map((f) => {
      const cb = h('input', { type: 'checkbox', checked: true });
      list.append(h('label', { class: 'finding' }, cb, h('span', { class: 'tag' }, f.kind), h('span', { class: 'mono' }, f.text)));
      return cb;
    });
    list.append(h('button', { class: 'btn', type: 'button', onclick: () => {
      area.value = applyRedactions(area.value, findings.filter((_, i) => boxes[i].checked));
      toast('Redacted');
      scan();
    } }, `Redact selected`));
  };

  s.body.append(
    h('div', { class: 'redact-grid' },
      h('div', { class: 'redact-side' }, kindToggles(kinds), terms, h('button', { class: 'btn', type: 'button', onclick: scan }, 'Find personal data'), list),
      area),
  );
  const [base, ext] = baseName(name);
  s.footer.append(
    h('span', { class: 'hint' }, 'Review everything yourself; detection can miss things.'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close(null) }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: () =>
      s.close(new File([area.value], `${base}-redacted.${ext || 'txt'}`, { type: type.startsWith('text/') ? type : 'text/plain' })) }, 'Use redacted version'),
  );
  scan();
  return s.result;
}

// ---------- boxes (PDF pages / images) ----------

interface Box { x: number; y: number; w: number; h: number }
interface PageState { canvas: HTMLCanvasElement; boxes: Box[]; overlay: HTMLElement; widthPt: number; heightPt: number }

async function boxRedactor(file: File, kind: 'pdf' | 'image'): Promise<File | null> {
  const s = shell(kind === 'pdf' ? 'Black out areas' : 'Redact image');
  const pagesEl = h('div', { class: 'box-pages' }, h('p', { class: 'hint' }, 'Loading…'));
  const kinds = new Set(DEFAULT_KINDS);
  const terms = termsInput();
  const pages: PageState[] = [];
  let pdfTextBoxes: ((kinds: Set<string>, terms: string[]) => Promise<Box[][]>) | null = null;

  const toolbar = h('div', { class: 'box-toolbar' },
    h('span', { class: 'hint' }, 'Drag to black out an area. Click a box to remove it.'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { pages.forEach((p) => { p.boxes = []; draw(p); }); } }, 'Clear all'));
  if (kind === 'pdf') {
    toolbar.prepend(h('details', { class: 'auto' }, h('summary', {}, 'Auto-detect'),
      kindToggles(kinds), terms,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const found = await pdfTextBoxes!(kinds, parseTerms(terms.value));
        let n = 0;
        found.forEach((bs, i) => { pages[i].boxes.push(...bs); n += bs.length; draw(pages[i]); });
        toast(n ? `Added ${n} box${n === 1 ? '' : 'es'}. Check each page.` : 'Nothing found in the text layer');
      } }, 'Find and black out')));
  }
  s.body.append(toolbar, pagesEl);

  const draw = (p: PageState) => {
    p.overlay.replaceChildren(...p.boxes.map((b, i) => {
      const el = h('button', { class: 'redact-box', type: 'button', 'aria-label': 'Remove box', onclick: (e: Event) => {
        e.stopPropagation(); p.boxes.splice(i, 1); draw(p);
      } });
      Object.assign(el.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
      return el;
    }));
  };

  const addPage = (canvas: HTMLCanvasElement, widthPt: number, heightPt: number) => {
    const overlay = h('div', { class: 'box-overlay' });
    const p: PageState = { canvas, boxes: [], overlay, widthPt, heightPt };
    canvas.className = 'box-canvas';
    pagesEl.append(h('div', { class: 'box-page' }, canvas, overlay));
    pages.push(p);

    let start: { x: number; y: number } | null = null;
    let live: HTMLElement | null = null;
    const frac = (e: PointerEvent) => {
      const r = overlay.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target !== overlay) return;
      overlay.setPointerCapture(e.pointerId);
      start = frac(e);
      live = h('div', { class: 'redact-box live' });
      overlay.append(live);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start || !live) return;
      const c = frac(e);
      Object.assign(live.style, {
        left: `${Math.min(start.x, c.x) * 100}%`, top: `${Math.min(start.y, c.y) * 100}%`,
        width: `${Math.abs(c.x - start.x) * 100}%`, height: `${Math.abs(c.y - start.y) * 100}%`,
      });
    });
    const finish = (e: PointerEvent) => {
      if (!start) return;
      const c = frac(e);
      const b = { x: Math.min(start.x, c.x), y: Math.min(start.y, c.y), w: Math.abs(c.x - start.x), h: Math.abs(c.y - start.y) };
      start = null;
      live?.remove();
      live = null;
      if (b.w > 0.004 && b.h > 0.004) p.boxes.push(b);
      draw(p);
    };
    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', finish);
  };

  try {
    if (kind === 'image') {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      pagesEl.replaceChildren();
      addPage(c, bmp.width, bmp.height);
    } else {
      const { loadPdf, renderPage, pdfjs } = await import('../lib/pdf.ts');
      const lib = await pdfjs();
      const doc = await loadPdf(new Uint8Array(await file.arrayBuffer()));
      pagesEl.replaceChildren();
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const { canvas } = await renderPage(page, 2);
        addPage(canvas, base.width, base.height);
      }
      const measureCtx = document.createElement('canvas').getContext('2d')!;
      measureCtx.font = '100px Helvetica, Arial, sans-serif';
      const measure = (s: string) => measureCtx.measureText(s).width;
      pdfTextBoxes = async (k, t) => {
        const out: Box[][] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const boxes: Box[] = [];
          for (const item of content.items) {
            if (!('str' in item) || !item.str) continue;
            const tx = lib.Util.transform(vp.transform, item.transform);
            const fh = Math.hypot(tx[2], tx[3]);
            // Position matches by measured width ratio: character counts drift with proportional fonts.
            const full = measure(item.str) || 1;
            for (const f of detectPII(item.str, k, t)) {
              const x0 = tx[4] + (item.width * measure(item.str.slice(0, f.start))) / full;
              const x1 = tx[4] + (item.width * measure(item.str.slice(0, f.end))) / full;
              const padX = fh * 0.5; // generous: better to cover a neighbour than leak a character
              const padY = fh * 0.2;
              boxes.push({
                x: (x0 - padX) / vp.width, y: (tx[5] - fh - padY) / vp.height,
                w: (x1 - x0 + 2 * padX) / vp.width, h: (fh * 1.3 + 2 * padY) / vp.height,
              });
            }
          }
          out.push(boxes);
        }
        return out;
      };
    }
  } catch {
    pagesEl.replaceChildren(h('div', { class: 'notice err' }, 'Could not open this file for redaction.'));
  }

  const [base, ext] = baseName(file.name);
  const exportFile = async (): Promise<File> => {
    const burned = pages.map((p) => {
      const c = document.createElement('canvas');
      c.width = p.canvas.width; c.height = p.canvas.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(p.canvas, 0, 0);
      ctx.fillStyle = '#000';
      for (const b of p.boxes) ctx.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height);
      return c;
    });
    const toBlob = (c: HTMLCanvasElement, t: string, q?: number) =>
      new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), t, q));

    if (kind === 'image') {
      const jpeg = /^jpe?g$/i.test(ext);
      const blob = await toBlob(burned[0], jpeg ? 'image/jpeg' : 'image/png', 0.95);
      return new File([blob], `${base}-redacted.${jpeg ? 'jpg' : 'png'}`, { type: blob.type });
    }
    const { PDFDocument } = await import('pdf-lib');
    const out = await PDFDocument.create();
    for (let i = 0; i < burned.length; i++) {
      const img = await out.embedJpg(new Uint8Array(await (await toBlob(burned[i], 'image/jpeg', 0.9)).arrayBuffer()));
      const page = out.addPage([pages[i].widthPt, pages[i].heightPt]);
      page.drawImage(img, { x: 0, y: 0, width: pages[i].widthPt, height: pages[i].heightPt });
    }
    const bytes = await out.save();
    return new File([bytes as Uint8Array<ArrayBuffer>], `${base}-redacted.pdf`, { type: 'application/pdf' });
  };

  s.footer.append(
    h('span', { class: 'hint' }, kind === 'image' ? 'Hidden metadata (GPS, camera) is removed too.' : 'Pages are flattened, so hidden text under boxes is gone.'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => s.close(null) }, 'Cancel'),
    h('button', { class: 'btn primary', type: 'button', onclick: async (e: Event) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      try { s.close(await exportFile()); } catch { toast('Export failed', 'err'); btn.disabled = false; btn.textContent = 'Use redacted version'; }
    } }, 'Use redacted version'),
  );
  return s.result;
}

/** Re-encodes an image through a canvas, dropping EXIF/GPS and other embedded metadata. */
export async function stripImageMetadata(file: File): Promise<File> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  const jpeg = file.type === 'image/jpeg';
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), jpeg ? 'image/jpeg' : 'image/png', 0.95));
  const name = jpeg ? file.name : file.name.replace(/\.\w+$/, '') + '.png';
  return new File([blob], name, { type: blob.type });
}
