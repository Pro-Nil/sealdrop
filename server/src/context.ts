import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.ts';
import { getFile, type Db, type FileRow } from './db.ts';
import type { BlobStore } from './storage.ts';
import { ID_RE, TOKEN_RE, safeEqualHash } from './tokens.ts';

export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** One uniform answer for "missing", "expired", "burned" and "wrong token", so nothing leaks. */
export function notFound(): HttpError {
  return new HttpError(404, 'Not found, expired, or no longer available');
}

export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  /** Returns false once `limit` hits happened inside the window. */
  hit(key: string, limit: number, windowMs: number, now: number): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.reset <= now) {
      this.hits.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    cur.count++;
    return cur.count <= limit;
  }

  prune(now: number): void {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
}

export interface Ctx {
  db: Db;
  blobs: BlobStore;
  config: Config;
  limiter: RateLimiter;
}

export function rateLimit(ctx: Ctx, req: FastifyRequest, bucket: string, limit: number, windowMs: number): void {
  if (!ctx.limiter.hit(`${bucket}:${req.ip}`, limit, windowMs, ctx.config.now())) {
    throw new HttpError(429, 'Too many requests, slow down');
  }
}

export function parseId(id: unknown): string {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound();
  return id;
}

export function bearer(req: FastifyRequest): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

export function headerToken(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && TOKEN_RE.test(v) ? v : null;
}

/** Loads a file and checks the owner's manage token. */
export function requireManage(ctx: Ctx, req: FastifyRequest, rawId: unknown): FileRow {
  const id = parseId(rawId);
  const file = getFile(ctx.db, id);
  const token = bearer(req);
  if (!file || !token || !safeEqualHash(token, file.manage_hash)) {
    rateLimit(ctx, req, 'auth-fail', 30, 15 * 60_000);
    throw notFound();
  }
  return file;
}

export function requireUploadSecret(ctx: Ctx, req: FastifyRequest): void {
  const secret = ctx.config.uploadSecret;
  if (secret === null) return;
  const given = req.headers['x-upload-secret'];
  const a = createHash('sha256').update(typeof given === 'string' ? given : '').digest();
  const b = createHash('sha256').update(secret).digest();
  if (!timingSafeEqual(a, b)) {
    rateLimit(ctx, req, 'auth-fail', 30, 15 * 60_000);
    throw new HttpError(401, 'Upload secret is missing or wrong');
  }
}

export function intInRange(v: unknown, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return v;
}

export function optionalInt(v: unknown, min: number, max: number, name: string): number | null {
  return v === null || v === undefined ? null : intInRange(v, min, max, name);
}
