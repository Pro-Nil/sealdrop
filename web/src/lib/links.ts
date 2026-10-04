// Everything after '#' stays in the browser: it is never sent to the server.

export interface FileSecrets {
  /** Raw file key (base64url). Present on no-password private links and on manage links. */
  k?: string;
  /** Link secret for password-protected files (base64url). */
  s?: string;
  /** Manage token (manage links only). */
  t?: string;
}

export function parseFragment(hash = location.hash): FileSecrets {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const out: FileSecrets = {};
  for (const k of ['k', 's', 't'] as const) {
    const v = p.get(k);
    if (v && /^[A-Za-z0-9_-]{16,64}$/.test(v)) out[k] = v;
  }
  return out;
}

function fragment(s: FileSecrets): string {
  const p = new URLSearchParams();
  for (const k of ['t', 'k', 's'] as const) if (s[k]) p.set(k, s[k]!);
  return p.toString();
}

export function privateLink(id: string, fileKey: string, linkSecret: string | null): string {
  return `${location.origin}/f/${id}#${linkSecret ? fragment({ s: linkSecret }) : fragment({ k: fileKey })}`;
}

export function manageLink(id: string, manageToken: string, fileKey: string, linkSecret: string | null): string {
  return `${location.origin}/m/${id}#${fragment({ t: manageToken, k: fileKey, s: linkSecret ?? undefined })}`;
}

export function aiLink(token: string, fileKey: string, name: string): string {
  const safe = name.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file';
  return `${location.origin}/r/${token}/${fileKey}/${encodeURIComponent(safe)}`;
}

/** The file id from /f/<id> or /m/<id>. */
export function pathId(): string | null {
  const m = /^\/[fm]\/([A-Za-z0-9_-]{22})\/?$/.exec(location.pathname);
  return m ? m[1] : null;
}
