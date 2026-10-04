import type { Db } from './db.ts';
import type { BlobStore } from './storage.ts';

const STALE_UPLOAD_MS = 24 * 3600_000;

/** Deletes expired, burned and abandoned files, plus dead sessions and AI links. Returns files removed. */
export async function runCleanup(db: Db, blobs: BlobStore, now: number): Promise<number> {
  const dead = db.prepare(`
    SELECT id FROM files
    WHERE (expires_at IS NOT NULL AND expires_at <= ?)
       OR (burn_at IS NOT NULL AND burn_at <= ?)
       OR (status = 'uploading' AND created_at <= ?)
  `).all(now, now, now - STALE_UPLOAD_MS) as { id: string }[];

  const del = db.prepare('DELETE FROM files WHERE id = ?');
  for (const { id } of dead) {
    del.run(id); // cascades to sessions and AI links
    await blobs.remove(id);
  }
  db.prepare('DELETE FROM view_sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM ai_links WHERE expires_at <= ?').run(now);
  return dead.length;
}
