import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ENC_CHUNK_SIZE } from '../../shared/format.ts';
import { runCleanup } from './cleanup.ts';
import type { Config } from './config.ts';
import { RateLimiter, type Ctx } from './context.ts';
import { openDb } from './db.ts';
import { aiRoutes } from './routes/ai.ts';
import { fileRoutes } from './routes/files.ts';
import { webRoutes } from './routes/web.ts';
import { BlobStore } from './storage.ts';

// The app pages load nothing from other origins: no CDNs, analytics or fonts.
// 'wasm-unsafe-eval' lets pdf.js decode some image formats; it does not allow JS eval.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface App {
  app: FastifyInstance;
  ctx: Ctx;
  cleanup: () => Promise<number>;
}

export async function buildApp(config: Config): Promise<App> {
  await mkdir(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, 'sealdrop.db'));
  const blobs = new BlobStore(config.dataDir);
  await blobs.init();
  const ctx: Ctx = { db, blobs, config, limiter: new RateLimiter() };

  // No request logging at all: URLs can carry AI-link keys.
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    // Trust only the first N hops (the reverse proxy we connect through), never client-sent ones.
    trustProxy: config.trustProxy === false ? false : (_addr: string, hop: number) => hop < (config.trustProxy as number),
  });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: ENC_CHUNK_SIZE }, (_req, data, done) => {
    done(null, data);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', APP_CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('cross-origin-resource-policy')) reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    reply.header('x-frame-options', 'DENY');
    return payload;
  });

  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) console.error('[sealdrop] internal error:', err.message);
    reply.code(status).send({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'Not found' });
  });

  fileRoutes(app, ctx);
  aiRoutes(app, ctx);
  await webRoutes(app, config.webDir);

  const cleanup = () => runCleanup(db, blobs, config.now());
  if (config.cleanupIntervalMs > 0) {
    const timer = setInterval(() => {
      ctx.limiter.prune(config.now());
      cleanup().catch((e) => console.error('[sealdrop] cleanup failed:', e.message));
    }, config.cleanupIntervalMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.addHook('onClose', async () => db.close());

  return { app, ctx, cleanup };
}
