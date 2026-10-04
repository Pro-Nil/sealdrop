import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 128-bit public identifier (22 base64url chars). */
export function newId(): string {
  return randomBytes(16).toString('base64url');
}

/** 256-bit bearer secret (43 base64url chars). Only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqualHash(token: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
