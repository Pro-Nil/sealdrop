import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ID_RE } from './tokens.ts';

/** Ciphertext chunks on disk: <dataDir>/blobs/<fileId>/<index>. Only ever encrypted bytes. */
export class BlobStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'blobs');
  }

  private dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid id');
    return join(this.root, id);
  }

  private path(id: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('invalid index');
    return join(this.dir(id), String(index));
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async write(id: string, index: number, data: Buffer): Promise<void> {
    await mkdir(this.dir(id), { recursive: true });
    const final = this.path(id, index);
    const tmp = `${final}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, final);
  }

  async size(id: string, index: number): Promise<number | null> {
    try {
      return (await stat(this.path(id, index))).size;
    } catch {
      return null;
    }
  }

  read(id: string, index: number): Promise<Buffer> {
    return readFile(this.path(id, index));
  }

  stream(id: string, index: number): ReadStream {
    return createReadStream(this.path(id, index));
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
