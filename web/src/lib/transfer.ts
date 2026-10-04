// Browser-side encryption and decryption pipelines.

import {
  CHUNK_SIZE, chunkCountFor, decryptChunk, decryptMeta, encryptChunk, encryptMeta, encryptedSizeFor,
  fromB64u, generateFileKey, importFileKey, randomBytes, toB64u, unwrapFileKey, wrapFileKey,
  type FileMeta, type PasswordWrap,
} from '../../../shared/format.ts';
import { ApiError, api, type ChunkAuth } from './api.ts';

const UPLOAD_PARALLEL = 3;
const DOWNLOAD_AHEAD = 3;

const TEXT_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  log: 'text/plain', yml: 'text/plain', yaml: 'text/plain', toml: 'text/plain', ini: 'text/plain', xml: 'text/xml',
  py: 'text/plain', js: 'text/plain', ts: 'text/plain', java: 'text/plain', c: 'text/plain', cpp: 'text/plain',
  go: 'text/plain', rs: 'text/plain', rb: 'text/plain', sh: 'text/plain', sql: 'text/plain', html: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav',
};

export function guessType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXT[ext] ?? 'application/octet-stream';
}

export interface UploadOptions {
  secret: string;
  expiresIn: number | null;
  maxViews: number | null;
  password: string | null;
  onProgress: (fraction: number) => void;
}

export interface UploadResult {
  id: string;
  manageToken: string;
  fileKey: string;
  linkSecret: string | null;
  meta: FileMeta;
  expiresAt: number | null;
}

export async function encryptAndUpload(file: File, opts: UploadOptions): Promise<UploadResult> {
  const rawKey = generateFileKey();
  const key = await importFileKey(rawKey);
  const chunkCount = chunkCountFor(file.size);
  const meta: FileMeta = { v: 1, name: file.name, type: guessType(file), size: file.size, chunkCount };

  let linkSecret: Uint8Array<ArrayBuffer> | null = null;
  let pwWrap: PasswordWrap | null = null;
  if (opts.password) {
    linkSecret = randomBytes(32);
    pwWrap = await wrapFileKey(rawKey, linkSecret, opts.password);
  }

  const { id, manageToken } = await api.createFile(opts.secret, {
    sizeEnc: encryptedSizeFor(file.size),
    chunkCount,
    meta: toB64u(await encryptMeta(key, meta)),
    expiresIn: opts.expiresIn,
    maxViews: opts.maxViews,
    pwWrap,
  });

  let next = 0;
  let doneBytes = 0;
  opts.onProgress(0);
  const worker = async () => {
    while (next < chunkCount) {
      const i = next++;
      const plain = new Uint8Array(await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer());
      const ct = await encryptChunk(key, i, i === chunkCount - 1, plain);
      for (let attempt = 0; ; attempt++) {
        try {
          await api.putChunk(id, manageToken, i, ct);
          break;
        } catch (e) {
          if (attempt >= 4 || (e instanceof ApiError && e.status < 500 && e.status !== 429)) throw e;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      doneBytes += plain.length;
      opts.onProgress(file.size ? doneBytes / file.size : 1);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, chunkCount) }, worker));
  const { expiresAt } = await api.complete(id, manageToken);

  return { id, manageToken, fileKey: toB64u(rawKey), linkSecret: linkSecret && toB64u(linkSecret), meta, expiresAt };
}

// ---------- opening ----------

export async function keyFromPassword(wrap: PasswordWrap, linkSecret: string, password: string): Promise<string> {
  try {
    return toB64u(await unwrapFileKey(wrap, fromB64u(linkSecret), password));
  } catch {
    throw new Error('Wrong password');
  }
}

export interface Opened {
  id: string;
  key: CryptoKey;
  meta: FileMeta;
  chunkCount: number;
  auth: ChunkAuth;
}

export async function openWithKey(id: string, fileKey: string, encMeta: string, chunkCount: number, auth: ChunkAuth): Promise<Opened> {
  let key: CryptoKey;
  let meta: FileMeta;
  try {
    key = await importFileKey(fromB64u(fileKey));
    meta = await decryptMeta(key, fromB64u(encMeta));
  } catch {
    throw new Error('This link is damaged: the decryption key does not match the file.');
  }
  if (meta.chunkCount !== chunkCount) throw new Error('File layout does not match its metadata.');
  return { id, key, meta, chunkCount, auth };
}

/** Streams decrypted chunks in order, fetching a few ahead. Authenticity is checked per chunk. */
export async function eachPlainChunk(
  o: Opened, onChunk: (plain: Uint8Array<ArrayBuffer>, index: number) => Promise<void> | void, onProgress: (f: number) => void,
): Promise<void> {
  const fetchOne = async (i: number) => {
    const ct = await api.chunk(o.id, i, o.auth);
    try {
      return await decryptChunk(o.key, i, i === o.chunkCount - 1, ct);
    } catch {
      throw new Error(`Chunk ${i + 1} failed its integrity check. The file was tampered with or corrupted.`);
    }
  };
  const pending: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let done = 0;
  for (let i = 0; i < o.chunkCount; i++) {
    while (pending.length < DOWNLOAD_AHEAD && i + pending.length < o.chunkCount) pending.push(fetchOne(i + pending.length));
    const plain = await pending.shift()!;
    await onChunk(plain, i);
    done += plain.length;
    onProgress(o.meta.size ? done / o.meta.size : 1);
  }
}

export async function decryptToBlob(o: Opened, onProgress: (f: number) => void): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  await eachPlainChunk(o, (p) => { parts.push(p); }, onProgress);
  return new Blob(parts, { type: o.meta.type });
}

type SavePicker = (opts: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStreamLike> }>;
interface WritableStreamLike { write(d: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }

export function canStreamToDisk(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker === 'function';
}

/** Decrypts straight to disk (Chromium). Returns false if the user cancelled the dialog. */
export async function decryptToDisk(o: Opened, onProgress: (f: number) => void): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  let handle;
  try {
    handle = await picker({ suggestedName: o.meta.name });
  } catch {
    return false;
  }
  const out = await handle.createWritable();
  try {
    await eachPlainChunk(o, (p) => out.write(p), onProgress);
    await out.close();
  } catch (e) {
    await out.abort().catch(() => {});
    throw e;
  }
  return true;
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
