import { api } from './api.ts';
import { aiLink } from './links.ts';
import { errorBox, h, linkField } from './ui.ts';

const TTL_OPTIONS: [number, string][] = [[600, '10 minutes'], [3600, '1 hour'], [6 * 3600, '6 hours'], [86400, '24 hours']];
const FETCH_OPTIONS: [number, string][] = [[1, '1 fetch'], [3, '3 fetches'], [10, '10 fetches']];

export function select(options: [number, string][], selected: number, label: string): HTMLSelectElement {
  return h('select', { class: 'input', 'aria-label': label },
    ...options.map(([v, t]) => h('option', { value: v, selected: v === selected }, t)));
}

/** "Share with an AI" block. Creating a link needs the manage token and the file key. */
export function aiLinkPanel(opts: {
  id: string; manageToken: string; fileKey: string; name: string; maxSeconds: number; onCreated?: () => void;
}): HTMLElement {
  const ttl = select(TTL_OPTIONS.filter(([s]) => s <= opts.maxSeconds), 600, 'AI link lifetime');
  const fetches = select(FETCH_OPTIONS, 3, 'Maximum fetches');
  const out = h('div', { class: 'ai-out' });
  const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    btn.disabled = true;
    try {
      const link = await api.createAiLink(opts.id, opts.manageToken, Number(ttl.value), Number(fetches.value));
      out.replaceChildren(
        linkField('AI link', aiLink(link.token, opts.fileKey, opts.name), `dies after ${fetches.selectedOptions[0].text} or ${ttl.selectedOptions[0].text}`, 'warn'),
        h('p', { class: 'hint' },
          'Paste this into ChatGPT, Claude, Gemini, etc. Your server decrypts the file for whoever fetches this URL, so the AI provider sees the content. ',
          'Nobody else sees it: the key is never stored or logged, and the link stops working once it is used up.'),
      );
      opts.onCreated?.();
    } catch (e) {
      out.replaceChildren(errorBox((e as Error).message));
    } finally {
      btn.disabled = false;
    }
  } }, 'Create AI link');

  return h('section', { class: 'card ai-panel' },
    h('h3', {}, 'Share with an AI'),
    h('p', { class: 'hint' }, 'A short-lived URL any AI can read directly, even without running JavaScript.'),
    h('div', { class: 'row wrap' },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Lifetime'), ttl),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Fetch limit'), fetches),
      btn),
    out,
  );
}
