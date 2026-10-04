// Per-device conveniences. Storage can be unavailable (private mode, blocked site data),
// so every access is guarded and the app works without it.

export interface SavedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  createdAt: number;
  expiresAt: number | null;
  maxViews: number | null;
  hasPassword: boolean;
  privateLink: string;
  manageLink: string;
}

const FILES = 'sealdrop.files.v1';
const SECRET = 'sealdrop.uploadSecret';

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(k: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch { /* storage unavailable */ }
}

export const store = {
  files: (): SavedFile[] => read<SavedFile[]>(FILES, []),
  addFile(f: SavedFile) { write(FILES, [f, ...this.files().filter((x) => x.id !== f.id)]); },
  removeFile(id: string) { write(FILES, this.files().filter((x) => x.id !== id)); },
  secret: (): string => read<string>(SECRET, ''),
  setSecret(s: string | null) { write(SECRET, s); },
};
