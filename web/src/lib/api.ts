import type { PasswordWrap } from '../../../shared/format.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ServerConfig {
  uploadSecretRequired: boolean;
  maxFileBytes: number;
  maxTempSeconds: number;
  maxAiLinkSeconds: number;
  viewSessionSeconds: number;
}

export interface FileInfo {
  id: string;
  status: 'uploading' | 'ready';
  createdAt: number;
  expiresAt: number | null;
  maxViews: number | null;
  views: number;
  sizeEnc: number;
  chunkCount: number;
  meta: string;
  pwWrap: PasswordWrap | null;
}

export interface PeekInfo {
  pwWrap: PasswordWrap | null;
  expiresAt: number | null;
  maxViews: number | null;
  views: number;
  sizeEnc: number;
}

export interface OpenInfo extends FileInfo {
  session: string;
  sessionExpiresAt: number;
}

export interface AiLinkInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  maxFetches: number;
  fetches: number;
  active: boolean;
}

export interface ManageInfo extends FileInfo {
  live: boolean;
  aiLinks: AiLinkInfo[];
}

export type ChunkAuth = { session: string } | { manageToken: string };

async function call<T>(method: string, url: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(url, { method, headers, body, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

export const api = {
  config: () => call<ServerConfig>('GET', '/api/config'),

  checkSecret: (secret: string) => call<{ ok: true }>('POST', '/api/auth/check', { headers: { 'x-upload-secret': secret } }),

  createFile: (secret: string, body: {
    sizeEnc: number; chunkCount: number; meta: string; expiresIn: number | null; maxViews: number | null; pwWrap: PasswordWrap | null;
  }) => call<{ id: string; manageToken: string }>('POST', '/api/files', { json: body, headers: { 'x-upload-secret': secret } }),

  putChunk: (id: string, manageToken: string, index: number, data: Uint8Array<ArrayBuffer>) =>
    call<void>('PUT', `/api/files/${id}/chunks/${index}`, {
      body: data, headers: { ...bearer(manageToken), 'content-type': 'application/octet-stream' },
    }),

  complete: (id: string, manageToken: string) =>
    call<{ ok: true; expiresAt: number | null }>('POST', `/api/files/${id}/complete`, { headers: bearer(manageToken) }),

  peek: (id: string) => call<PeekInfo>('GET', `/api/files/${id}/peek`),

  open: (id: string) => call<OpenInfo>('POST', `/api/files/${id}/open`),

  async chunk(id: string, index: number, auth: ChunkAuth): Promise<Uint8Array<ArrayBuffer>> {
    const headers = 'session' in auth ? { 'x-view-session': auth.session } : bearer(auth.manageToken);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`/api/files/${id}/chunks/${index}`, { headers, credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'File is no longer available' : `Download failed (${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (attempt >= 3 || (e instanceof ApiError && e.status < 500)) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  },

  manage: (id: string, manageToken: string) => call<ManageInfo>('GET', `/api/files/${id}/manage`, { headers: bearer(manageToken) }),

  deleteFile: (id: string, manageToken: string) => call<void>('DELETE', `/api/files/${id}`, { headers: bearer(manageToken) }),

  createAiLink: (id: string, manageToken: string, ttlSeconds: number, maxFetches: number) =>
    call<{ id: string; token: string; expiresAt: number; maxFetches: number }>('POST', `/api/files/${id}/ai-links`, {
      json: { ttlSeconds, maxFetches }, headers: bearer(manageToken),
    }),

  revokeAiLink: (id: string, manageToken: string, linkId: string) =>
    call<void>('DELETE', `/api/files/${id}/ai-links/${linkId}`, { headers: bearer(manageToken) }),
};
