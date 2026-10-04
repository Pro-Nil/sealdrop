import '../style.css';
import { aiLinkPanel } from '../lib/ai-panel.ts';
import { ApiError, api, type ManageInfo, type ServerConfig } from '../lib/api.ts';
import { parseFragment, pathId, privateLink } from '../lib/links.ts';
import { store } from '../lib/store.ts';
import { decryptToBlob, openWithKey, saveBlob } from '../lib/transfer.ts';
import { $, copy, errorBox, formatBytes, formatWhen, h, linkField, progressBar, toast } from '../lib/ui.ts';

const app = $('#app');

async function main() {
  const id = pathId();
  if (!id) return myFiles();
  const { t, k, s } = parseFragment();
  if (!t || !k) {
    app.replaceChildren(h('section', { class: 'card narrow' }, errorBox('This manage link is incomplete (missing the part after “#”).')));
    return;
  }
  await manage(id, t, k, s ?? null);
}

function myFiles() {
  const files = store.files();
  const list = h('div', { class: 'file-list' });
  const render = () => {
    const current = store.files();
    list.replaceChildren(...(current.length ? current.map((f) => {
      const expired = f.expiresAt !== null && f.expiresAt <= Date.now();
      return h('div', { class: `file-item${expired ? ' dim' : ''}` },
        h('div', { class: 'file-info' },
          h('a', { class: 'file-name', href: f.manageLink.replace(location.origin, '') }, f.name),
          h('span', { class: 'hint' }, [
            formatBytes(f.size),
            `uploaded ${formatWhen(f.createdAt)}`,
            f.expiresAt ? (expired ? 'expired' : `expires ${formatWhen(f.expiresAt)}`) : 'permanent',
            f.hasPassword ? 'password' : null,
          ].filter(Boolean).join(' · '))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => copy(f.privateLink) }, 'Copy link'),
          h('button', { class: 'btn ghost', type: 'button', title: 'Removes it from this device only', onclick: () => {
            store.removeFile(f.id); render();
          } }, 'Forget')));
    }) : [h('p', { class: 'hint' }, 'Nothing saved on this device yet.')]));
  };
  render();
  app.replaceChildren(h('section', { class: 'card' },
    h('h1', {}, 'My files'),
    h('p', { class: 'hint' }, `Saved in this browser only (${files.length}). The server has no list of your files and cannot show one.`),
    list));
}

async function manage(id: string, manageToken: string, fileKey: string, linkSecret: string | null) {
  let info: ManageInfo;
  let config: ServerConfig;
  try {
    [info, config] = await Promise.all([api.manage(id, manageToken), api.config()]);
  } catch (e) {
    const gone = e instanceof ApiError && e.status === 404;
    if (gone) store.removeFile(id);
    app.replaceChildren(h('section', { class: 'card narrow' },
      h('h1', {}, gone ? 'File is gone' : 'Error'),
      errorBox(gone ? 'This file has expired, burned, or was deleted. It no longer exists on the server.' : (e as Error).message),
      h('a', { class: 'btn', href: '/m' }, 'My files')));
    return;
  }

  let opened;
  try {
    opened = await openWithKey(id, fileKey, info.meta, info.chunkCount, { manageToken });
  } catch (e) {
    app.replaceChildren(h('section', { class: 'card narrow' }, errorBox((e as Error).message)));
    return;
  }
  const { meta } = opened;
  const priv = privateLink(id, fileKey, linkSecret);

  if (!store.files().some((f) => f.id === id)) {
    store.addFile({
      id, name: meta.name, size: meta.size, type: meta.type, createdAt: info.createdAt, expiresAt: info.expiresAt,
      maxViews: info.maxViews, hasPassword: !!info.pwWrap, privateLink: priv, manageLink: location.href,
    });
  }

  const linksEl = h('div', { class: 'ai-list' });
  const refreshLinks = async () => {
    const fresh = await api.manage(id, manageToken);
    linksEl.replaceChildren(...(fresh.aiLinks.length ? fresh.aiLinks.map((l) => h('div', { class: `ai-item${l.active ? '' : ' dim'}` },
      h('span', {}, l.active ? h('span', { class: 'badge ok' }, 'active') : h('span', { class: 'badge' }, 'used up / expired')),
      h('span', { class: 'hint' }, `${l.fetches}/${l.maxFetches} fetches · ${l.active ? `expires ${formatWhen(l.expiresAt)}` : `created ${formatWhen(l.createdAt)}`}`),
      l.active ? h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
        await api.revokeAiLink(id, manageToken, l.id);
        toast('AI link revoked');
        refreshLinks();
      } }, 'Revoke') : null,
    )) : [h('p', { class: 'hint' }, 'No AI links yet.')]));
  };

  const status = h('div');
  const facts = [
    formatBytes(meta.size), meta.type,
    info.expiresAt ? `expires ${formatWhen(info.expiresAt)}` : 'permanent',
    info.maxViews !== null ? `${info.views}/${info.maxViews} views used` : `${info.views} view${info.views === 1 ? '' : 's'}`,
    info.pwWrap ? 'password protected' : null,
  ].filter(Boolean).join(' · ');

  app.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'view-head' },
        h('div', {},
          info.live ? h('span', { class: 'badge ok' }, 'live') : h('span', { class: 'badge warn' }, 'no longer viewable'),
          h('h1', { class: 'file-name' }, meta.name),
          h('p', { class: 'hint' }, facts)),
        h('button', { class: 'btn', type: 'button', onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          const p = progressBar();
          status.replaceChildren(p.el);
          try {
            saveBlob(await decryptToBlob(opened, (f) => p.set(f, `Decrypting… ${Math.round(f * 100)}%`)), meta.name);
            status.replaceChildren();
          } catch (err) {
            status.replaceChildren(errorBox((err as Error).message));
          } finally {
            btn.disabled = false;
          }
        } }, 'Download (doesn’t use a view)')),
      status,
      linkField('Private link', priv, info.pwWrap ? 'recipients also need the password' : 'for people'),
    ),
    info.live ? aiLinkPanel({ id, manageToken, fileKey, name: meta.name, maxSeconds: config.maxAiLinkSeconds, onCreated: refreshLinks }) : '',
    h('section', { class: 'card' }, h('h3', {}, 'AI links'), linksEl),
    h('section', { class: 'card danger-zone' },
      h('h3', {}, 'Delete'),
      h('p', { class: 'hint' }, 'Erases the encrypted data from the server now. Every link to it stops working.'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`Delete “${meta.name}” permanently?`)) return;
        try {
          await api.deleteFile(id, manageToken);
          store.removeFile(id);
          app.replaceChildren(h('section', { class: 'card narrow' },
            h('span', { class: 'badge ok' }, 'Deleted'), h('h1', {}, 'File erased'),
            h('p', { class: 'hint' }, 'The encrypted data is gone from the server.'),
            h('a', { class: 'btn', href: '/' }, 'Upload a file')));
        } catch (err) {
          toast((err as Error).message, 'err');
        }
      } }, 'Delete file')),
  );
  refreshLinks();
}

main();
