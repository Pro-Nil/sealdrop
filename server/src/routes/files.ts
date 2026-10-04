import type { FastifyInstance } from 'fastify';
import {
  MAX_META_BYTES, TAG_SIZE, encChunkLength, fromB64u, isPasswordWrap, isValidLayout,
} from '../../../shared/format.ts';
import {
  HttpError, bearer, headerToken, intInRange, notFound, optionalInt, parseId, rateLimit, requireManage,
  requireUploadSecret, type Ctx,
} from '../context.ts';
import { getFile, isLive, type AiLinkRow, type FileRow } from '../db.ts';
import { hashToken, newId, newToken, safeEqualHash } from '../tokens.ts';

type Body = Record<string, unknown>;

function body(req: { body: unknown }): Body {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'JSON body required');
  return req.body as Body;
}

function publicInfo(f: FileRow) {
  return {
    id: f.id,
    status: f.status,
    createdAt: f.created_at,
    expiresAt: f.expires_at,
    maxViews: f.max_views,
    views: f.views,
    sizeEnc: f.size_enc,
    chunkCount: f.chunk_count,
    meta: f.meta,
    pwWrap: f.pw_wrap ? JSON.parse(f.pw_wrap) : null,
  };
}

export function fileRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, blobs, config } = ctx;

  app.get('/api/config', async () => ({
    uploadSecretRequired: config.uploadSecret !== null,
    maxFileBytes: config.maxFileBytes,
    maxTempSeconds: config.maxTempSeconds,
    maxAiLinkSeconds: config.maxAiLinkSeconds,
    viewSessionSeconds: config.viewSessionSeconds,
  }));

  // Lets the upload page check the secret before encrypting anything.
  app.post('/api/auth/check', async (req) => {
    requireUploadSecret(ctx, req);
    return { ok: true };
  });

  // 1. Create an upload. Nothing here reveals content: sizes, an encrypted meta blob, policy.
  app.post('/api/files', async (req, reply) => {
    rateLimit(ctx, req, 'create', 120, 60 * 60_000);
    requireUploadSecret(ctx, req);
    const b = body(req);

    const chunkCount = intInRange(b.chunkCount, 1, 1_000_000, 'chunkCount');
    const sizeEnc = intInRange(b.sizeEnc, TAG_SIZE, Number.MAX_SAFE_INTEGER, 'sizeEnc');
    if (!isValidLayout(sizeEnc, chunkCount)) throw new HttpError(400, 'Inconsistent size and chunk count');
    if (sizeEnc - chunkCount * TAG_SIZE > config.maxFileBytes) throw new HttpError(413, 'File is larger than this server allows');

    if (typeof b.meta !== 'string') throw new HttpError(400, 'meta required');
    let metaLen: number;
    try { metaLen = fromB64u(b.meta).length; } catch { throw new HttpError(400, 'meta must be base64url'); }
    if (metaLen < TAG_SIZE + 2 || metaLen > MAX_META_BYTES) throw new HttpError(400, 'meta has invalid size');

    const expiresIn = optionalInt(b.expiresIn, 60, config.maxTempSeconds, 'expiresIn');
    const maxViews = optionalInt(b.maxViews, 1, 1000, 'maxViews');
    let pwWrap: string | null = null;
    if (b.pwWrap !== null && b.pwWrap !== undefined) {
      if (!isPasswordWrap(b.pwWrap)) throw new HttpError(400, 'invalid pwWrap');
      const { salt, iv, wrapped, iterations } = b.pwWrap;
      pwWrap = JSON.stringify({ salt, iv, wrapped, iterations });
    }

    const id = newId();
    const manageToken = newToken();
    db.prepare(`INSERT INTO files (id, manage_hash, status, created_at, expires_in, max_views, size_enc, chunk_count, meta, pw_wrap)
                VALUES (?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, hashToken(manageToken), config.now(), expiresIn, maxViews, sizeEnc, chunkCount, b.meta, pwWrap);
    reply.code(201);
    return { id, manageToken };
  });

  // 2. Upload ciphertext chunks (idempotent, so the client can retry).
  app.put('/api/files/:id/chunks/:index', async (req, reply) => {
    const { id, index: rawIndex } = req.params as { id: string; index: string };
    const file = requireManage(ctx, req, id);
    if (file.status !== 'uploading') throw new HttpError(409, 'Upload already completed');
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunk_count) throw new HttpError(400, 'Bad chunk index');
    const data = req.body;
    if (!Buffer.isBuffer(data)) throw new HttpError(415, 'Send chunks as application/octet-stream');
    if (data.length !== encChunkLength(index, file.chunk_count, file.size_enc)) throw new HttpError(400, 'Chunk has the wrong size');
    await blobs.write(file.id, index, data);
    reply.code(204);
  });

  // 3. Seal the upload. Expiry starts now, not when the upload began.
  app.post('/api/files/:id/complete', async (req) => {
    const file = requireManage(ctx, req, (req.params as { id: string }).id);
    if (file.status !== 'uploading') throw new HttpError(409, 'Upload already completed');
    for (let i = 0; i < file.chunk_count; i++) {
      if ((await blobs.size(file.id, i)) !== encChunkLength(i, file.chunk_count, file.size_enc)) {
        throw new HttpError(400, `Chunk ${i} is missing`);
      }
    }
    const now = config.now();
    const expiresAt = file.expires_in === null ? null : now + file.expires_in * 1000;
    db.prepare(`UPDATE files SET status = 'ready', expires_at = ? WHERE id = ?`).run(expiresAt, file.id);
    return { ok: true, expiresAt };
  });

  // Look before opening: policy info and the wrapped key (password files). Does not spend a view.
  app.get('/api/files/:id/peek', async (req) => {
    rateLimit(ctx, req, 'open', 120, 60_000);
    const file = getFile(db, parseId((req.params as { id: string }).id));
    if (!file || !isLive(file, config.now()) || isExhausted(file)) throw notFound();
    return {
      pwWrap: file.pw_wrap ? JSON.parse(file.pw_wrap) : null,
      expiresAt: file.expires_at,
      maxViews: file.max_views,
      views: file.views,
      sizeEnc: file.size_enc,
    };
  });

  // Opening a file spends one view and starts a short download session.
  app.post('/api/files/:id/open', async (req) => {
    rateLimit(ctx, req, 'open', 120, 60_000);
    const id = parseId((req.params as { id: string }).id);
    const now = config.now();
    const session = newToken();
    const sessionExpires = now + config.viewSessionSeconds * 1000;

    db.exec('BEGIN IMMEDIATE');
    try {
      const file = getFile(db, id);
      if (!file || !isLive(file, now) || isExhausted(file)) throw notFound();
      const views = file.views + 1;
      const burnAt = file.max_views !== null && views >= file.max_views ? sessionExpires : file.burn_at;
      db.prepare('UPDATE files SET views = ?, burn_at = ? WHERE id = ?').run(views, burnAt, id);
      db.prepare('INSERT INTO view_sessions (token_hash, file_id, expires_at) VALUES (?, ?, ?)').run(hashToken(session), id, sessionExpires);
      db.exec('COMMIT');
      return { ...publicInfo({ ...file, views, burn_at: burnAt }), session, sessionExpiresAt: sessionExpires };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  // Ciphertext chunk download: needs a view session (viewer) or the manage token (owner).
  app.get('/api/files/:id/chunks/:index', async (req, reply) => {
    const { id: rawId, index: rawIndex } = req.params as { id: string; index: string };
    const id = parseId(rawId);
    const now = config.now();
    const file = getFile(db, id);
    if (!file || file.status !== 'ready' || (file.expires_at !== null && file.expires_at <= now)) throw notFound();

    const session = headerToken(req, 'x-view-session');
    const owner = bearer(req);
    let allowed = false;
    if (session) {
      const row = db.prepare('SELECT expires_at FROM view_sessions WHERE token_hash = ? AND file_id = ?')
        .get(hashToken(session), id) as { expires_at: number } | undefined;
      allowed = !!row && row.expires_at > now;
    } else if (owner) {
      allowed = safeEqualHash(owner, file.manage_hash);
    }
    if (!allowed) throw notFound();

    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= file.chunk_count) throw notFound();
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', encChunkLength(index, file.chunk_count, file.size_enc))
      .header('cache-control', 'no-store');
    return reply.send(blobs.stream(id, index));
  });

  // Owner dashboard data.
  app.get('/api/files/:id/manage', async (req) => {
    const file = requireManage(ctx, req, (req.params as { id: string }).id);
    const now = config.now();
    const links = db.prepare('SELECT * FROM ai_links WHERE file_id = ? ORDER BY created_at DESC').all(file.id) as unknown as AiLinkRow[];
    return {
      ...publicInfo(file),
      live: isLive(file, now) && !isExhausted(file),
      aiLinks: links.map((l) => ({
        id: l.id,
        createdAt: l.created_at,
        expiresAt: l.expires_at,
        maxFetches: l.max_fetches,
        fetches: l.fetches,
        active: l.expires_at > now && l.fetches < l.max_fetches,
      })),
    };
  });

  app.delete('/api/files/:id', async (req, reply) => {
    const file = requireManage(ctx, req, (req.params as { id: string }).id);
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    await blobs.remove(file.id);
    reply.code(204);
  });
}

function isExhausted(f: FileRow): boolean {
  return f.max_views !== null && f.views >= f.max_views;
}

