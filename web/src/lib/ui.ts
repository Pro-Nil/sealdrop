// Tiny DOM helpers. Text always goes through textContent, never innerHTML.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function $(sel: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function formatWhen(ts: number | null, now = Date.now()): string {
  if (ts === null) return 'never';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [[86400_000, 'day'], [3600_000, 'hour'], [60_000, 'minute']];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      const s = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff > 0 ? `in ${s}` : `${s} ago`;
    }
  }
  return diff > 0 ? 'in under a minute' : 'just now';
}

export function toast(msg: string, kind: 'ok' | 'err' = 'ok'): void {
  let host = document.querySelector('.toasts');
  if (!host) { host = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => t.remove(), 3500);
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed: select the text and copy it manually', 'err');
  }
}

/** A read-only link field with a copy button. */
export function linkField(label: string, value: string, note?: string, tone?: 'warn' | 'danger'): HTMLElement {
  const input = h('input', { class: 'mono', readonly: true, value, 'aria-label': label, onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
  return h('div', { class: `linkfield${tone ? ` ${tone}` : ''}` },
    h('div', { class: 'linkfield-head' }, h('span', { class: 'label' }, label), note ? h('span', { class: 'hint' }, note) : null),
    h('div', { class: 'row' }, input, h('button', { class: 'btn', type: 'button', onclick: () => copy(value) }, 'Copy')),
  );
}

export function progressBar(): { el: HTMLElement; set: (f: number, label?: string) => void } {
  const fill = h('div', { class: 'progress-fill' });
  const text = h('div', { class: 'progress-label' });
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  return {
    el: h('div', { class: 'progress-wrap' }, bar, text),
    set(f, label) {
      const pct = Math.max(0, Math.min(100, Math.round(f * 100)));
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      if (label !== undefined) text.textContent = label;
    },
  };
}

export function errorBox(msg: string): HTMLElement {
  return h('div', { class: 'notice err', role: 'alert' }, msg);
}
