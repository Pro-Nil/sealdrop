import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Everything the server knows about a file. None of it reveals the content, name or type. */
export interface FileRow {
  id: string;
  manage_hash: string;
  status: 'uploading' | 'ready';
  created_at: number;
  expires_in: number | null;
  expires_at: number | null;
  max_views: number | null;
  views: number;
  burn_at: number | null;
  size_enc: number;
  chunk_count: number;
  meta: string;
  pw_wrap: string | null;
}

export interface AiLinkRow {
  id: string;
  token_hash: string;
  file_id: string;
  created_at: number;
  expires_at: number;
  max_fetches: number;
  fetches: number;
}

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      manage_hash TEXT NOT NULL,
      status      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      expires_in  INTEGER,
      expires_at  INTEGER,
      max_views   INTEGER,
      views       INTEGER NOT NULL DEFAULT 0,
      burn_at     INTEGER,
      size_enc    INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      meta        TEXT NOT NULL,
      pw_wrap     TEXT
    );

    CREATE TABLE IF NOT EXISTS view_sessions (
      token_hash TEXT PRIMARY KEY,
      file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_links (
      id          TEXT PRIMARY KEY,
      token_hash  TEXT NOT NULL UNIQUE,
      file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      max_fetches INTEGER NOT NULL,
      fetches     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS ai_links_file ON ai_links(file_id);
    CREATE INDEX IF NOT EXISTS view_sessions_file ON view_sessions(file_id);
  `);
  return db;
}

export function getFile(db: Db, id: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

/** A file that exists, finished uploading, and has not expired or burned. */
export function isLive(f: FileRow, now: number): boolean {
  return f.status === 'ready' && (f.expires_at === null || f.expires_at > now) && (f.burn_at === null || f.burn_at > now);
}
