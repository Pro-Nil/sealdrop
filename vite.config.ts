import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// In dev, map /f/<id> and /m/<id> to their pages the way the server does in production.
const pageRoutes: Plugin = {
  name: 'sealdrop-page-routes',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/f\/[^/.]+\/?(\?.*)?$/.test(req.url)) req.url = '/f.html';
      else if (req.url && /^\/m(\/[^/.]+)?\/?(\?.*)?$/.test(req.url)) req.url = '/m.html';
      next();
    });
  },
};

export default defineConfig({
  root: 'web',
  plugins: [pageRoutes],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'web/index.html'),
        f: resolve(import.meta.dirname, 'web/f.html'),
        m: resolve(import.meta.dirname, 'web/m.html'),
      },
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:3000', '/r': 'http://localhost:3000' },
  },
});
