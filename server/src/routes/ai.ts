// AI links: short-lived URLs that any fetcher (ChatGPT, Claude, curl…) can read as a plain file.
//
// URL: /r/<linkToken>/<fileKey>/<name>
// The file key rides in the path, so THIS server sees it for the duration of one request.
// It is never stored or logged: it lives in memory only while the response streams.
// The link token is stored only as a hash and dies after its TTL or fetch limit.

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decryptChunk, decryptMeta, fromB64u, importFileKey, type FileMeta } from '../../../shared/format.ts';
import { HttpError, intInRange, rateLimit, requireManage, type Ctx } from '../context.ts';
import { getFile, isLive, type AiLinkRow } from '../db.ts';
import { TOKEN_RE, hashToken, newId, newToken } from '../tokens.ts';

// Types a browser would execute or render as active content are served as plain text.
const ACTIVE_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
  'text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript',
]);

export function safeContentType(type: string): string {
  const t = type.toLowerCase().trim();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(t)) return 'application/octet-stream';
  if (ACTIVE_TYPES.has(t)) return 'text/plain; charset=utf-8';
  if (t.startsWith('text/') || t === 'application/json') return `${t}; charset=utf-8`;
  return t;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function gone(reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .header('content-type', 'text/plain; charset=utf-8')
    .header('cache-control', 'no-store')
    .send('This link has expired, reached its fetch limit, or never existed.\n');
}

export function aiRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, blobs, config } = ctx;

  app.post('/api/files/:id/ai-links', async (req, reply) => {
    const file = requireManage(ctx, req, (req.params as { id: string }).id);
    const now = config.now();
    if (!isLive(file, now)) throw new HttpError(409, 'File is not available');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ttl = intInRange(b.ttlSeconds, 60, config.maxAiLinkSeconds, 'ttlSeconds');
    const maxFetches = intInRange(b.maxFetches, 1, 100, 'maxFetches');

    let expiresAt = now + ttl * 1000;
    if (file.expires_at !== null) expiresAt = Math.min(expiresAt, file.expires_at);
    const id = newId();
    const token = newToken();
    db.prepare(`INSERT INTO ai_links (id, token_hash, file_id, created_at, expires_at, max_fetches) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, hashToken(token), file.id, now, expiresAt, maxFetches);
    reply.code(201);
    return { id, token, expiresAt, maxFetches };
  });

  app.delete('/api/files/:id/ai-links/:linkId', async (req, reply) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const file = requireManage(ctx, req, id);
    db.prepare('DELETE FROM ai_links WHERE id = ? AND file_id = ?').run(linkId, file.id);
    reply.code(204);
  });

  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    rateLimit(ctx, req, 'ai', 120, 60_000);
    const { token, key } = req.params as { token: string; key: string };
    const now = config.now();
    if (!TOKEN_RE.test(token) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return gone(reply);

    const link = db.prepare('SELECT * FROM ai_links WHERE token_hash = ?').get(hashToken(token)) as AiLinkRow | undefined;
    if (!link || link.expires_at <= now || link.fetches >= link.max_fetches) return gone(reply);
    const file = getFile(db, link.file_id);
    if (!file || !isLive(file, now)) return gone(reply);

    let cryptoKey: CryptoKey;
    let meta: FileMeta;
    try {
      cryptoKey = await importFileKey(fromB64u(key));
      meta = await decryptMeta(cryptoKey, fromB64u(file.meta));
    } catch {
      return gone(reply); // wrong key: indistinguishable from a dead link
    }
    if (meta.chunkCount !== file.chunk_count) return gone(reply);

    // Only real downloads spend a fetch; HEAD probes are free.
    if (req.method === 'GET') {
      const res = db.prepare('UPDATE ai_links SET fetches = fetches + 1 WHERE id = ? AND fetches < max_fetches').run(link.id);
      if (res.changes !== 1) return gone(reply);
    }

    reply
      .header('content-type', safeContentType(meta.type))
      .header('content-length', meta.size)
      .header('content-disposition', contentDisposition(meta.name))
      .header('cache-control', 'no-store, private')
      .header('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('content-security-policy', "default-src 'none'; sandbox");

    if (req.method === 'HEAD') return reply.send();

    const fileId = file.id;
    const count = file.chunk_count;
    async function* plaintext() {
      for (let i = 0; i < count; i++) {
        const ct = new Uint8Array(await blobs.read(fileId, i));
        yield Buffer.from(await decryptChunk(cryptoKey, i, i === count - 1, ct));
      }
    }
    return reply.send(Readable.from(plaintext()));
  };

  for (const url of ['/r/:token/:key', '/r/:token/:key/:name']) {
    app.get(url, serve); // Fastify answers HEAD through the GET route.
  }
}
