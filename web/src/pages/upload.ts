import '../style.css';
import { aiLinkPanel, select } from '../lib/ai-panel.ts';
import { ApiError, api, type ServerConfig } from '../lib/api.ts';
import { manageLink, privateLink } from '../lib/links.ts';
import { store } from '../lib/store.ts';
import { encryptAndUpload, guessType, type UploadResult } from '../lib/transfer.ts';
import { $, errorBox, formatBytes, formatWhen, h, linkField, progressBar } from '../lib/ui.ts';

const app = $('#app');

const EXPIRY: [number, string][] = [[600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [7 * 86400, '7 days'], [30 * 86400, '30 days']];
const VIEWS: [number, string][] = [[0, 'No limit'], [1, '1 view (burn after reading)'], [3, '3 views'], [10, '10 views']];

let config: ServerConfig;
let secret = '';

async function main() {
  try {
    config = await api.config();
  } catch {
    app.replaceChildren(errorBox('Cannot reach the server.'));
    return;
  }
  const saved = store.secret();
  if (!config.uploadSecretRequired) return uploadForm('');
  if (saved) {
    try { await api.checkSecret(saved); return uploadForm(saved); } catch { store.setSecret(null); }
  }
  unlockForm();
}

function unlockForm() {
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Upload secret', 'aria-label': 'Upload secret' });
  const remember = h('input', { type: 'checkbox', checked: true });
  const msg = h('div');
  const form = h('form', { class: 'card narrow', onsubmit: async (e: Event) => {
    e.preventDefault();
    try {
      await api.checkSecret(input.value);
      if (remember.checked) store.setSecret(input.value);
      uploadForm(input.value);
    } catch (err) {
      msg.replaceChildren(errorBox(err instanceof ApiError && err.status === 401 ? 'Wrong upload secret.' : (err as Error).message));
    }
  } },
    h('h1', {}, 'Unlock uploads'),
    h('p', { class: 'hint' }, 'This server only accepts uploads from its owner. Viewing shared links needs no secret.'),
    input,
    h('label', { class: 'check' }, remember, 'Remember on this device'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Continue'),
    msg);
  app.replaceChildren(form);
  input.focus();
}

function uploadForm(uploadSecret: string) {
  secret = uploadSecret;
  let file: File | null = null;
  let redacted = false;

  const picker = h('input', { type: 'file', class: 'sr-only', id: 'file' });
  const drop = h('label', { class: 'dropzone', for: 'file' },
    h('span', { class: 'drop-title' }, 'Drop a file here, or click to choose'),
    h('span', { class: 'hint' }, `Video, PDF, text, images, anything up to ${formatBytes(config.maxFileBytes)}. It is encrypted in this browser before it leaves your device.`),
    picker);
  const fileRow = h('div', { class: 'file-row', hidden: true });

  const tempBtn = h('button', { class: 'seg on', type: 'button', 'aria-pressed': 'true' }, 'Temporary');
  const permBtn = h('button', { class: 'seg', type: 'button', 'aria-pressed': 'false' }, 'Permanent');
  const expiry = select(EXPIRY.filter(([s]) => s <= config.maxTempSeconds), 86400, 'Expires after');
  const views = select(VIEWS, 0, 'View limit');
  const tempOpts = h('div', { class: 'row wrap' },
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'Delete after'), expiry),
    h('label', { class: 'field' }, h('span', { class: 'label' }, 'View limit'), views));
  const permNote = h('p', { class: 'hint', hidden: true }, 'Stays until you delete it from the manage page.');
  let permanent = false;
  const setPermanent = (p: boolean) => {
    permanent = p;
    tempBtn.classList.toggle('on', !p); tempBtn.setAttribute('aria-pressed', String(!p));
    permBtn.classList.toggle('on', p); permBtn.setAttribute('aria-pressed', String(p));
    tempOpts.hidden = p; permNote.hidden = !p;
  };
  tempBtn.addEventListener('click', () => setPermanent(false));
  permBtn.addEventListener('click', () => setPermanent(true));

  const password = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Optional password', 'aria-label': 'Optional password' });
  const remember = h('input', { type: 'checkbox', checked: true });
  const stripMeta = h('input', { type: 'checkbox', checked: true });
  const stripRow = h('label', { class: 'check', hidden: true }, stripMeta, 'Remove hidden photo data (GPS location, camera info)');
  const go = h('button', { class: 'btn primary big', type: 'button', disabled: true }, 'Encrypt & upload');
  const status = h('div');

  const setFile = (f: File | null, wasRedacted = false) => {
    file = f;
    redacted = wasRedacted;
    go.disabled = !f;
    drop.hidden = !!f;
    fileRow.hidden = !f;
    if (!f) return;
    const type = guessType(f);
    stripRow.hidden = !/^image\/(jpeg|png|webp)$/.test(type) || wasRedacted;
    fileRow.replaceChildren(
      h('div', { class: 'file-info' },
        h('strong', { class: 'file-name' }, f.name),
        h('span', { class: 'hint' }, `${formatBytes(f.size)} · ${type}${wasRedacted ? ' · redacted' : ''}`)),
      h('div', { class: 'row' },
        redactButton(f, type),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { picker.value = ''; setFile(null); } }, 'Remove')),
    );
  };

  const redactButton = (f: File, type: string) => {
    const btn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: async () => {
      const { openRedactor } = await import('../redact/editor.ts');
      const out = await openRedactor(f, type);
      if (out) setFile(out, true);
    } }, redacted ? 'Redact more' : 'Redact before sharing');
    import('../redact/editor.ts').then(({ redactMode }) => { btn.hidden = !redactMode(f, type); });
    return btn;
  };

  picker.addEventListener('change', () => setFile(picker.files?.[0] ?? null));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  });

  go.addEventListener('click', async () => {
    if (!file) return;
    if (file.size > config.maxFileBytes) { status.replaceChildren(errorBox(`This server accepts files up to ${formatBytes(config.maxFileBytes)}.`)); return; }
    go.disabled = true;
    const bar = progressBar();
    status.replaceChildren(bar.el);
    try {
      let toSend = file;
      if (!stripRow.hidden && stripMeta.checked) {
        bar.set(0, 'Removing photo metadata…');
        const { stripImageMetadata } = await import('../redact/editor.ts');
        toSend = await stripImageMetadata(file);
      }
      const maxViews = permanent ? null : Number(views.value) || null;
      const res = await encryptAndUpload(toSend, {
        secret,
        expiresIn: permanent ? null : Number(expiry.value),
        maxViews,
        password: password.value || null,
        onProgress: (f) => bar.set(f, `Encrypting and uploading… ${Math.round(f * 100)}%`),
      });
      done(res, maxViews, !!password.value, remember.checked);
    } catch (e) {
      go.disabled = false;
      status.replaceChildren(errorBox((e as Error).message));
    }
  });

  app.replaceChildren(
    h('section', { class: 'card' },
      h('h1', {}, 'Share a file privately'),
      h('p', { class: 'lede' }, 'End-to-end encrypted. The server only ever stores scrambled bytes. The key lives in the link.'),
      drop, fileRow, stripRow,
      h('div', { class: 'opts' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Lifetime'), h('div', { class: 'segmented', role: 'group' }, tempBtn, permBtn)),
        tempOpts, permNote,
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Password'), password,
          h('span', { class: 'hint' }, 'Optional. Recipients need the link and the password. Nobody can guess the password offline without the link.')),
        h('label', { class: 'check' }, remember, 'Save to "My files" on this device')),
      go, status),
  );
}

function done(res: UploadResult, maxViews: number | null, hasPassword: boolean, remember: boolean) {
  const priv = privateLink(res.id, res.fileKey, res.linkSecret);
  const manage = manageLink(res.id, res.manageToken, res.fileKey, res.linkSecret);
  if (remember) {
    store.addFile({
      id: res.id, name: res.meta.name, size: res.meta.size, type: res.meta.type, createdAt: Date.now(),
      expiresAt: res.expiresAt, maxViews, hasPassword, privateLink: priv, manageLink: manage,
    });
  }
  const policy = [
    res.expiresAt ? `deletes itself ${formatWhen(res.expiresAt)}` : 'permanent',
    maxViews ? `burns after ${maxViews} view${maxViews === 1 ? '' : 's'}` : null,
    hasPassword ? 'password protected' : null,
  ].filter(Boolean).join(' · ');

  app.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'success-head' }, h('span', { class: 'badge ok' }, 'Encrypted & uploaded'), h('h1', {}, res.meta.name)),
      h('p', { class: 'hint' }, `${formatBytes(res.meta.size)} · ${policy}`),
      linkField('Private link', priv, hasPassword ? 'send the password separately' : 'for people. Decrypts in their browser'),
      linkField('Manage link', manage, 'keep this to yourself: it can delete the file and create AI links', 'danger'),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn', href: manage.replace(location.origin, '') }, 'Open manage page'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => uploadForm(secret) }, 'Upload another')),
    ),
    aiLinkPanel({ id: res.id, manageToken: res.manageToken, fileKey: res.fileKey, name: res.meta.name, maxSeconds: config.maxAiLinkSeconds }),
  );
}

main();
