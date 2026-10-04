import '../style.css';
import { ApiError, api, type PeekInfo } from '../lib/api.ts';
import { parseFragment, pathId } from '../lib/links.ts';
import { previewKind, renderPreview } from '../lib/preview.ts';
import {
  canStreamToDisk, decryptToBlob, decryptToDisk, keyFromPassword, openWithKey, saveBlob, type Opened,
} from '../lib/transfer.ts';
import { $, errorBox, formatBytes, formatWhen, h, progressBar } from '../lib/ui.ts';

const app = $('#app');
const PREVIEW_MAX = 512 * 1024 * 1024;

function fail(msg: string) {
  app.replaceChildren(h('section', { class: 'card narrow' }, h('h1', {}, 'Can’t open this file'), errorBox(msg)));
}

const GONE = 'This file doesn’t exist anymore. It may have expired, reached its view limit, or been deleted by its owner.';

async function main() {
  const id = pathId();
  const secrets = parseFragment();
  if (!id) return fail('This link is malformed.');
  if (!secrets.k && !secrets.s) return fail('This link is missing its key: the part after “#”. Ask the sender for the complete link.');

  let peek: PeekInfo;
  try {
    peek = await api.peek(id);
  } catch (e) {
    return fail(e instanceof ApiError && e.status === 404 ? GONE : 'Cannot reach the server.');
  }

  let fileKey = secrets.k ?? null;
  if (peek.pwWrap) {
    if (!secrets.s) return fail('This file needs a password, but the link is incomplete.');
    fileKey = await askPassword(peek, secrets.s);
  }
  if (!fileKey) return fail('This link is missing its key.');

  if (peek.maxViews !== null) {
    const left = peek.maxViews - peek.views;
    await confirmOpen(`This file can be opened ${left} more time${left === 1 ? '' : 's'}. Opening it now uses one view.`);
  }
  await open(id, fileKey);
}

function askPassword(peek: PeekInfo, linkSecret: string): Promise<string> {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Password', 'aria-label': 'Password' });
    const msg = h('div');
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Unlock');
    app.replaceChildren(h('form', { class: 'card narrow', onsubmit: async (e: Event) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      try {
        resolve(await keyFromPassword(peek.pwWrap!, linkSecret, input.value));
      } catch (err) {
        msg.replaceChildren(errorBox((err as Error).message));
        btn.disabled = false;
        btn.textContent = 'Unlock';
      }
    } },
      h('span', { class: 'badge' }, 'Password protected'),
      h('h1', {}, 'Enter the password'),
      h('p', { class: 'hint' }, 'The password is checked in your browser. It never reaches the server.'),
      input, btn, msg));
    input.focus();
  });
}

function confirmOpen(text: string): Promise<void> {
  return new Promise((resolve) => {
    app.replaceChildren(h('section', { class: 'card narrow' },
      h('span', { class: 'badge warn' }, 'Limited views'),
      h('h1', {}, 'Open this file?'),
      h('p', {}, text),
      h('button', { class: 'btn primary', type: 'button', onclick: () => resolve() }, 'Open file')));
  });
}

async function open(id: string, fileKey: string) {
  const bar = progressBar();
  app.replaceChildren(h('section', { class: 'card narrow' }, h('h1', {}, 'Decrypting…'), bar.el));
  let o: Opened;
  let info;
  try {
    info = await api.open(id);
    o = await openWithKey(id, fileKey, info.meta, info.chunkCount, { session: info.session });
  } catch (e) {
    return fail(e instanceof ApiError && e.status === 404 ? GONE : (e as Error).message);
  }

  const { meta } = o;
  const facts = [
    formatBytes(meta.size),
    meta.type,
    info.expiresAt ? `expires ${formatWhen(info.expiresAt)}` : null,
    info.maxViews !== null ? (info.views >= info.maxViews ? 'last view: gone once you leave' : `${info.maxViews - info.views} views left`) : null,
  ].filter(Boolean).join(' · ');

  const previewEl = h('div', { class: 'preview' });
  const dl = h('button', { class: 'btn primary', type: 'button' }, 'Download');
  const status = h('div');
  const burnNote = info.maxViews !== null && info.views >= info.maxViews
    ? h('div', { class: 'notice warn' }, `This was the final view. The file will be erased from the server ${formatWhen(info.sessionExpiresAt)}. Download it now if you need it.`)
    : null;

  app.replaceChildren(h('section', { class: 'card wide' },
    h('div', { class: 'view-head' },
      h('div', {}, h('h1', { class: 'file-name' }, meta.name), h('p', { class: 'hint' }, facts)),
      dl),
    burnNote, status, previewEl,
    h('p', { class: 'hint center' }, 'Decrypted in your browser. The server never saw this file’s contents or name.')));

  let blob: Blob | null = null;
  const wantsPreview = previewKind(meta) !== 'none' && meta.size <= PREVIEW_MAX;

  dl.addEventListener('click', async () => {
    if (blob) return saveBlob(blob, meta.name);
    dl.disabled = true;
    const p = progressBar();
    status.replaceChildren(p.el);
    try {
      if (canStreamToDisk()) {
        const saved = await decryptToDisk(o, (f) => p.set(f, `Decrypting to disk… ${Math.round(f * 100)}%`));
        status.replaceChildren(saved ? h('div', { class: 'notice ok' }, 'Saved.') : h('div'));
      } else {
        blob = await decryptToBlob(o, (f) => p.set(f, `Decrypting… ${Math.round(f * 100)}%`));
        saveBlob(blob, meta.name);
        status.replaceChildren();
      }
    } catch (e) {
      status.replaceChildren(errorBox((e as Error).message));
    } finally {
      dl.disabled = false;
    }
  });

  if (!wantsPreview) {
    previewEl.append(h('div', { class: 'notice' }, previewKind(meta) === 'none'
      ? 'No preview for this file type. Use Download to save it.'
      : 'This file is large, so it isn’t previewed. Use Download to save it.'));
    return;
  }
  const p = progressBar();
  previewEl.append(p.el);
  try {
    blob = await decryptToBlob(o, (f) => p.set(f, `Decrypting… ${Math.round(f * 100)}%`));
    await renderPreview(previewEl, blob, meta);
  } catch (e) {
    previewEl.replaceChildren(errorBox((e as Error).message));
  }
}

main();
