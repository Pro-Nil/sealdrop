import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Secret required to upload. null only when ALLOW_PUBLIC_UPLOADS=true. */
  uploadSecret: string | null;
  maxFileBytes: number;
  /** How long a viewer may keep downloading chunks after opening a file. */
  viewSessionSeconds: number;
  maxTempSeconds: number;
  maxAiLinkSeconds: number;
  trustProxy: boolean;
  /** Built frontend (dist/web). null disables static serving (dev / tests). */
  webDir: string | null;
  cleanupIntervalMs: number;
  now: () => number;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowPublic = env.ALLOW_PUBLIC_UPLOADS === 'true';
  const uploadSecret = env.UPLOAD_SECRET?.trim() || null;
  if (!uploadSecret && !allowPublic) {
    throw new Error('UPLOAD_SECRET is required (or set ALLOW_PUBLIC_UPLOADS=true to let anyone upload).');
  }
  if (uploadSecret && uploadSecret.length < 16) throw new Error('UPLOAD_SECRET must be at least 16 characters.');

  const webDir = resolve(env.WEB_DIR ?? 'dist/web');
  return {
    // SERVER_PORT is what Pterodactyl sets for the server's allocation.
    port: int(env, 'PORT', int(env, 'SERVER_PORT', 3000)),
    host: env.HOST ?? '0.0.0.0',
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    uploadSecret,
    maxFileBytes: int(env, 'MAX_FILE_MB', 2048) * 1024 * 1024,
    viewSessionSeconds: int(env, 'VIEW_SESSION_SECONDS', 3600),
    maxTempSeconds: int(env, 'MAX_TEMP_DAYS', 365) * 86400,
    maxAiLinkSeconds: int(env, 'MAX_AI_LINK_HOURS', 24) * 3600,
    trustProxy: env.TRUST_PROXY !== 'false',
    webDir: existsSync(webDir) ? webDir : null,
    cleanupIntervalMs: 60_000,
    now: Date.now,
  };
}
