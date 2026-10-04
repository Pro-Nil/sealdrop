import type { FileMeta } from '../../../shared/format.ts';
import { h } from './ui.ts';

const TEXT_PREVIEW_LIMIT = 5 * 1024 * 1024;
const TEXT_LIKE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh|sql|toml))/;

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';

export function previewKind(meta: FileMeta): PreviewKind {
  const t = meta.type.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (TEXT_LIKE.test(t) && meta.size <= TEXT_PREVIEW_LIMIT) return 'text';
  return 'none';
}

/**
 * Renders decrypted content. Nothing is ever interpreted as HTML: images go through <img>
 * (which never runs SVG scripts), text through textContent, PDFs through pdf.js onto canvas.
 */
export async function renderPreview(container: HTMLElement, blob: Blob, meta: FileMeta): Promise<void> {
  const kind = previewKind(meta);
  const unsupported = (msg: string) => container.replaceChildren(h('div', { class: 'notice' }, msg));

  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    const url = URL.createObjectURL(blob);
    const el = kind === 'image'
      ? h('img', { src: url, alt: meta.name, class: 'preview-media' })
      : h(kind, { src: url, controls: true, playsinline: true, preload: 'metadata', class: 'preview-media' });
    el.addEventListener('error', () => unsupported(`Your browser can't play this ${kind} format. Download it to open locally.`), { once: true });
    container.replaceChildren(el);
    return;
  }
  if (kind === 'pdf') {
    container.replaceChildren();
    const { renderPdfInto } = await import('./pdf.ts');
    try {
      await renderPdfInto(container, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      unsupported('This PDF could not be rendered here. Download it to open locally.');
    }
    return;
  }
  if (kind === 'text') {
    container.replaceChildren(h('pre', { class: 'preview-text' }, await blob.text()));
    return;
  }
  unsupported('No preview for this file type. Download it to open locally.');
}
