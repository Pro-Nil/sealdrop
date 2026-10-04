import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// /r/ (AI links) stays crawlable on purpose: some AI fetchers honour robots.txt and would
// refuse the link. Those responses carry X-Robots-Tag: noindex so they are never indexed.
const ROBOTS = 'User-agent: *\nDisallow: /f/\nDisallow: /m/\nDisallow: /api/\n';

export async function webRoutes(app: FastifyInstance, webDir: string | null): Promise<void> {
  app.get('/robots.txt', async (_req, reply) => reply.type('text/plain').send(ROBOTS));
  if (!webDir) return;

  await app.register(fastifyStatic, {
    root: webDir,
    index: false,
    wildcard: true,
    setHeaders(res, path) {
      // Vite fingerprints assets, so they can be cached forever; pages never are.
      res.header('cache-control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  const page = (file: string) => async (_req: FastifyRequest, reply: FastifyReply) => reply.sendFile(file);

  app.get('/', page('index.html'));
  app.get('/f/:id', page('f.html'));
  app.get('/m', page('m.html'));
  app.get('/m/:id', page('m.html'));
}
