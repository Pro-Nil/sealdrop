import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app, cleanup } = await buildApp(config);
await cleanup();
await app.listen({ port: config.port, host: config.host });

console.log(`[sealdrop] listening on ${config.host}:${config.port}`);
console.log(`[sealdrop] data: ${config.dataDir}`);
console.log(`[sealdrop] web: ${config.webDir ?? '(not built — run npm run build)'}`);
if (!config.uploadSecret) console.warn('[sealdrop] WARNING: public uploads are enabled; anyone can use your disk.');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}
