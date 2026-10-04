// Sealdrop encryption format v1. Shared by the browser and the server.
//
// - Every file gets a random 256-bit key K. The server never stores K.
// - The file is split into CHUNK_SIZE plaintext chunks, each sealed with AES-256-GCM.
//   Nonce = [kind][0,0,0][u64 index]. Unique per (K, kind, index); K is never reused.
//   AAD binds the chunk index and an "is last chunk" flag, so chunks cannot be
//   reordered, swapped between positions, or silently truncated.
// - File name, MIME type and size live in an encrypted metadata blob (kind = 1).
// - Optional password: K is wrapped with a key derived from BOTH a random link
//   secret (kept in the URL fragment) and the password (PBKDF2). The server holds
//   only the wrapped key, so it cannot brute-force the password without the link.

export const FORMAT_VERSION = 1;
export const CHUNK_SIZE = 4 * 1024 * 1024;
export const TAG_SIZE = 16;
export const ENC_CHUNK_SIZE = CHUNK_SIZE + TAG_SIZE;
export const KEY_BYTES = 32;
export const MAX_META_BYTES = 4096;
export const PBKDF2_ITERATIONS = 600_000;

const KIND_CHUNK = 0;
const KIND_META = 1;

export interface FileMeta {
  v: 1;
  name: string;
  type: string;
  size: number;
  chunkCount: number;
}

export interface PasswordWrap {
  salt: string;
  iv: string;
  wrapped: string;
  iterations: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------- base64url ----------

export function toB64u(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

// ---------- sizes ----------

export function chunkCountFor(plainSize: number): number {
  return Math.max(1, Math.ceil(plainSize / CHUNK_SIZE));
}

export function encryptedSizeFor(plainSize: number): number {
  return plainSize + chunkCountFor(plainSize) * TAG_SIZE;
}

/** Expected ciphertext length of chunk `index` given the total ciphertext size. */
export function encChunkLength(index: number, chunkCount: number, sizeEnc: number): number {
  return index < chunkCount - 1 ? ENC_CHUNK_SIZE : sizeEnc - (chunkCount - 1) * ENC_CHUNK_SIZE;
}

/** Checks that (sizeEnc, chunkCount) describe a valid v1 layout. */
export function isValidLayout(sizeEnc: number, chunkCount: number): boolean {
  if (!Number.isSafeInteger(sizeEnc) || !Number.isSafeInteger(chunkCount) || chunkCount < 1) return false;
  const plain = sizeEnc - chunkCount * TAG_SIZE;
  return plain >= 0 && chunkCountFor(plain) === chunkCount;
}

// ---------- keys ----------

export function generateFileKey(): Uint8Array<ArrayBuffer> {
  return randomBytes(KEY_BYTES);
}

export function importFileKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error('invalid key length');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function nonce(kind: number, index: number): Uint8Array<ArrayBuffer> {
  const n = new Uint8Array(12);
  n[0] = kind;
  new DataView(n.buffer).setBigUint64(4, BigInt(index));
  return n;
}

function chunkAad(index: number, isLast: boolean): Uint8Array<ArrayBuffer> {
  return encoder.encode(`sealdrop/v1/chunk/${index}/${isLast ? 1 : 0}`);
}

const META_AAD = encoder.encode('sealdrop/v1/meta');

// ---------- chunks ----------

export async function encryptChunk(
  key: CryptoKey, index: number, isLast: boolean, plain: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce(KIND_CHUNK, index), additionalData: chunkAad(index, isLast) }, key, plain,
  );
  return new Uint8Array(ct);
}

export async function decryptChunk(
  key: CryptoKey, index: number, isLast: boolean, cipher: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce(KIND_CHUNK, index), additionalData: chunkAad(index, isLast) }, key, cipher,
  );
  return new Uint8Array(pt);
}

// ---------- metadata ----------

export async function encryptMeta(key: CryptoKey, meta: FileMeta): Promise<Uint8Array<ArrayBuffer>> {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce(KIND_META, 0), additionalData: META_AAD }, key, encoder.encode(JSON.stringify(meta)),
  );
  return new Uint8Array(ct);
}

export async function decryptMeta(key: CryptoKey, cipher: Uint8Array<ArrayBuffer>): Promise<FileMeta> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(KIND_META, 0), additionalData: META_AAD }, key, cipher);
  const m = JSON.parse(decoder.decode(pt));
  if (
    !m || m.v !== 1 || typeof m.name !== 'string' || typeof m.type !== 'string' ||
    !Number.isSafeInteger(m.size) || m.size < 0 || m.chunkCount !== chunkCountFor(m.size)
  ) {
    throw new Error('invalid metadata');
  }
  return m as FileMeta;
}

// ---------- password wrapping ----------

async function deriveWrapKey(
  linkSecret: Uint8Array<ArrayBuffer>, password: string, salt: Uint8Array<ArrayBuffer>, iterations: number,
): Promise<CryptoKey> {
  const pwKey = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const pwBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pwKey, 256),
  );
  const ikm = new Uint8Array(linkSecret.length + pwBits.length);
  ikm.set(linkSecret, 0);
  ikm.set(pwBits, linkSecret.length);
  const hk = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('sealdrop/v1/wrap') },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function wrapFileKey(
  fileKey: Uint8Array<ArrayBuffer>, linkSecret: Uint8Array<ArrayBuffer>, password: string,
): Promise<PasswordWrap> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wk = await deriveWrapKey(linkSecret, password, salt, PBKDF2_ITERATIONS);
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wk, fileKey));
  return { salt: toB64u(salt), iv: toB64u(iv), wrapped: toB64u(wrapped), iterations: PBKDF2_ITERATIONS };
}

/** Throws if the password (or link secret) is wrong. */
export async function unwrapFileKey(
  wrap: PasswordWrap, linkSecret: Uint8Array<ArrayBuffer>, password: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const wk = await deriveWrapKey(linkSecret, password, fromB64u(wrap.salt), wrap.iterations);
  const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(wrap.iv) }, wk, fromB64u(wrap.wrapped));
  return new Uint8Array(raw);
}

export function isPasswordWrap(x: unknown): x is PasswordWrap {
  if (!x || typeof x !== 'object') return false;
  const w = x as Record<string, unknown>;
  return (
    typeof w.salt === 'string' && w.salt.length <= 64 &&
    typeof w.iv === 'string' && w.iv.length <= 32 &&
    typeof w.wrapped === 'string' && w.wrapped.length <= 128 &&
    Number.isSafeInteger(w.iterations) && (w.iterations as number) >= 100_000 && (w.iterations as number) <= 10_000_000
  );
}
