import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomFillSync } from 'node:crypto';
import {
  CHUNK_SIZE, chunkCountFor, decryptChunk, decryptMeta, encryptChunk, encryptMeta, encryptedSizeFor,
  fromB64u, generateFileKey, importFileKey, randomBytes, toB64u, wrapFileKey,
} from '../../shared/format.ts';
import { buildApp, type App } from '../src/app.ts';
import type { Config } from '../src/config.ts';

const big = (n: number) => randomFillSync(new Uint8Array(n));
const SECRET = 'test-upload-secret-123';
let dir: string;
let clock: number;
let built: App;

async function freshApp(overrides: Partial<Config> = {}): Promise<App> {
  if (built) await built.app.close();
  dir = await mkdtemp(join(tmpdir(), 'sealdrop-'));
  clock = 1_700_000_000_000;
  built = await buildApp({
    port: 0, host: '127.0.0.1', dataDir: dir, uploadSecret: SECRET, maxFileBytes: 20 * 1024 * 1024,
    viewSessionSeconds: 3600, maxTempSeconds: 30 * 86400, maxAiLinkSeconds: 86400, trustProxy: false,
    webDir: null, cleanupIntervalMs: 0, now: () => clock, ...overrides,
  });
  return built;
}

interface Uploaded { id: string; manageToken: string; rawKey: Uint8Array<ArrayBuffer>; plain: Uint8Array<ArrayBuffer> }

async function upload(
  plain: Uint8Array<ArrayBuffer>,
  opts: { name?: string; type?: string; expiresIn?: number | null; maxViews?: number | null; pwWrap?: unknown } = {},
): Promise<Uploaded> {
  const { app } = built;
  const rawKey = generateFileKey();
  const key = await importFileKey(rawKey);
  const chunkCount = chunkCountFor(plain.length);
  const meta = await encryptMeta(key, {
    v: 1, name: opts.name ?? 'note.txt', type: opts.type ?? 'text/plain', size: plain.length, chunkCount,
  });
  const create = await app.inject({
    method: 'POST', url: '/api/files', headers: { 'x-upload-secret': SECRET },
    payload: {
      sizeEnc: encryptedSizeFor(plain.length), chunkCount, meta: toB64u(meta),
      expiresIn: opts.expiresIn ?? null, maxViews: opts.maxViews ?? null, pwWrap: opts.pwWrap ?? null,
    },
  });
  assert.equal(create.statusCode, 201, create.body);
  const { id, manageToken } = create.json();
  for (let i = 0; i < chunkCount; i++) {
    const part = plain.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const ct = await encryptChunk(key, i, i === chunkCount - 1, part);
    const put = await app.inject({
      method: 'PUT', url: `/api/files/${id}/chunks/${i}`,
      headers: { authorization: `Bearer ${manageToken}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(ct),
    });
    assert.equal(put.statusCode, 204, put.body);
  }
  const done = await app.inject({ method: 'POST', url: `/api/files/${id}/complete`, headers: { authorization: `Bearer ${manageToken}` } });
  assert.equal(done.statusCode, 200, done.body);
  return { id, manageToken, rawKey, plain };
}

async function openAndDecrypt(u: Uploaded): Promise<Uint8Array> {
  const { app } = built;
  const open = await app.inject({ method: 'POST', url: `/api/files/${u.id}/open` });
  assert.equal(open.statusCode, 200, open.body);
  const info = open.json();
  const key = await importFileKey(u.rawKey);
  const meta = await decryptMeta(key, fromB64u(info.meta));
  const out = new Uint8Array(meta.size);
  for (let i = 0; i < info.chunkCount; i++) {
    const r = await app.inject({ method: 'GET', url: `/api/files/${u.id}/chunks/${i}`, headers: { 'x-view-session': info.session } });
    assert.equal(r.statusCode, 200);
    const pt = await decryptChunk(key, i, i === info.chunkCount - 1, new Uint8Array(r.rawPayload));
    out.set(pt, i * CHUNK_SIZE);
  }
  return out;
}

async function makeAiLink(u: Uploaded, body = { ttlSeconds: 600, maxFetches: 2 }): Promise<string> {
  const r = await built.app.inject({
    method: 'POST', url: `/api/files/${u.id}/ai-links`, headers: { authorization: `Bearer ${u.manageToken}` }, payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return `/r/${r.json().token}/${toB64u(u.rawKey)}/file`;
}

describe('sealdrop API', () => {
  before(() => freshApp());
  beforeEach(() => freshApp());
  after(async () => {
    await built.app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('rejects uploads without the upload secret', async () => {
    const r = await built.app.inject({ method: 'POST', url: '/api/files', payload: { sizeEnc: 16, chunkCount: 1, meta: 'x' } });
    assert.equal(r.statusCode, 401);
  });

  test('multi-chunk upload round-trips, server only holds ciphertext', async () => {
    const plain = big(CHUNK_SIZE * 2 + 1234);
    const u = await upload(plain);
    assert.deepEqual(await openAndDecrypt(u), plain);

    const files = await readdir(join(dir, 'blobs', u.id));
    assert.deepEqual(files.sort(), ['0', '1', '2']);
    // The database row contains no name/type in the clear.
    const row = JSON.stringify(built.ctx.db.prepare('SELECT * FROM files').all());
    assert.ok(!row.includes('note.txt') && !row.includes('text/plain'));
  });

  test('empty files work', async () => {
    const u = await upload(new Uint8Array(0));
    assert.equal((await openAndDecrypt(u)).length, 0);
  });

  test('chunks need a view session or manage token', async () => {
    const u = await upload(randomBytes(100));
    const r = await built.app.inject({ method: 'GET', url: `/api/files/${u.id}/chunks/0` });
    assert.equal(r.statusCode, 404);
    const owner = await built.app.inject({ method: 'GET', url: `/api/files/${u.id}/chunks/0`, headers: { authorization: `Bearer ${u.manageToken}` } });
    assert.equal(owner.statusCode, 200);
  });

  test('burn after N views', async () => {
    const u = await upload(randomBytes(100), { maxViews: 2 });
    await openAndDecrypt(u);
    await openAndDecrypt(u); // last view still downloads fine
    const third = await built.app.inject({ method: 'POST', url: `/api/files/${u.id}/open` });
    assert.equal(third.statusCode, 404);

    clock += 3601_000; // session window over → cleanup deletes the ciphertext
    assert.equal(await built.cleanup(), 1);
    await assert.rejects(readdir(join(dir, 'blobs', u.id)));
  });

  test('temporary files expire, permanent ones stay', async () => {
    const temp = await upload(randomBytes(10), { expiresIn: 600 });
    const perm = await upload(randomBytes(10));
    clock += 601_000;
    assert.equal((await built.app.inject({ method: 'POST', url: `/api/files/${temp.id}/open` })).statusCode, 404);
    assert.equal(await built.cleanup(), 1);
    assert.equal((await built.app.inject({ method: 'POST', url: `/api/files/${perm.id}/open` })).statusCode, 200);
  });

  test('password wrap is stored and served without spending a view', async () => {
    const fileKey = generateFileKey();
    const pwWrap = await wrapFileKey(fileKey, randomBytes(32), 'pw');
    const u = await upload(randomBytes(10), { pwWrap, maxViews: 1 });
    const w = await built.app.inject({ method: 'GET', url: `/api/files/${u.id}/peek` });
    assert.deepEqual(w.json().pwWrap, pwWrap);
    assert.equal(w.json().maxViews, 1);
    await built.app.inject({ method: 'GET', url: `/api/files/${u.id}/peek` });
    assert.equal((await built.app.inject({ method: 'POST', url: `/api/files/${u.id}/open` })).statusCode, 200);
  });

  test('AI link serves plaintext with the right type and respects fetch limit', async () => {
    const text = new TextEncoder().encode('hello from a private pdf');
    const u = await upload(text, { name: 'report.pdf', type: 'application/pdf' });
    const url = await makeAiLink(u);

    const head = await built.app.inject({ method: 'HEAD', url });
    assert.equal(head.statusCode, 200);
    const r1 = await built.app.inject({ method: 'GET', url });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.headers['content-type'], 'application/pdf');
    assert.match(String(r1.headers['content-disposition']), /report\.pdf/);
    assert.match(String(r1.headers['x-robots-tag']), /noindex/);
    assert.equal(r1.body, 'hello from a private pdf');
    assert.equal((await built.app.inject({ method: 'GET', url })).statusCode, 200);
    assert.equal((await built.app.inject({ method: 'GET', url })).statusCode, 404, 'third fetch is refused');
  });

  test('AI link: multi-chunk stream, wrong key, expiry, revoke', async () => {
    const plain = big(CHUNK_SIZE + 77);
    const u = await upload(plain, { type: 'application/octet-stream' });
    const url = await makeAiLink(u, { ttlSeconds: 60, maxFetches: 10 });
    const ok = await built.app.inject({ method: 'GET', url });
    assert.deepEqual(new Uint8Array(ok.rawPayload), plain);

    const wrongKey = url.replace(toB64u(u.rawKey), toB64u(generateFileKey()));
    assert.equal((await built.app.inject({ method: 'GET', url: wrongKey })).statusCode, 404);

    clock += 61_000;
    assert.equal((await built.app.inject({ method: 'GET', url })).statusCode, 404, 'expired');

    const url2 = await makeAiLink(u);
    const list = await built.app.inject({ method: 'GET', url: `/api/files/${u.id}/manage`, headers: { authorization: `Bearer ${u.manageToken}` } });
    const active = list.json().aiLinks.find((l: { active: boolean }) => l.active);
    await built.app.inject({ method: 'DELETE', url: `/api/files/${u.id}/ai-links/${active.id}`, headers: { authorization: `Bearer ${u.manageToken}` } });
    assert.equal((await built.app.inject({ method: 'GET', url: url2 })).statusCode, 404, 'revoked');
  });

  test('AI link never serves HTML/SVG as active content', async () => {
    const u = await upload(new TextEncoder().encode('<script>alert(1)</script>'), { name: 'x.html', type: 'text/html' });
    const r = await built.app.inject({ method: 'GET', url: await makeAiLink(u) });
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(String(r.headers['content-security-policy']), /sandbox/);
  });

  test('owner can delete; wrong manage token cannot', async () => {
    const u = await upload(randomBytes(10));
    const bad = await built.app.inject({ method: 'DELETE', url: `/api/files/${u.id}`, headers: { authorization: `Bearer ${'A'.repeat(43)}` } });
    assert.equal(bad.statusCode, 404);
    const good = await built.app.inject({ method: 'DELETE', url: `/api/files/${u.id}`, headers: { authorization: `Bearer ${u.manageToken}` } });
    assert.equal(good.statusCode, 204);
    assert.equal((await built.app.inject({ method: 'POST', url: `/api/files/${u.id}/open` })).statusCode, 404);
    await assert.rejects(readdir(join(dir, 'blobs', u.id)));
  });

  test('rejects wrong chunk sizes and oversized files', async () => {
    const r = await built.app.inject({
      method: 'POST', url: '/api/files', headers: { 'x-upload-secret': SECRET },
      payload: { sizeEnc: encryptedSizeFor(21 * 1024 * 1024), chunkCount: chunkCountFor(21 * 1024 * 1024), meta: toB64u(randomBytes(40)) },
    });
    assert.equal(r.statusCode, 413);

    const c = await built.app.inject({
      method: 'POST', url: '/api/files', headers: { 'x-upload-secret': SECRET },
      payload: { sizeEnc: encryptedSizeFor(10), chunkCount: 1, meta: toB64u(randomBytes(40)) },
    });
    const { id, manageToken } = c.json();
    const put = await built.app.inject({
      method: 'PUT', url: `/api/files/${id}/chunks/0`,
      headers: { authorization: `Bearer ${manageToken}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(5),
    });
    assert.equal(put.statusCode, 400);
    const done = await built.app.inject({ method: 'POST', url: `/api/files/${id}/complete`, headers: { authorization: `Bearer ${manageToken}` } });
    assert.equal(done.statusCode, 400);
  });

  test('security headers are present', async () => {
    const r = await built.app.inject({ method: 'GET', url: '/api/config' });
    assert.match(String(r.headers['content-security-policy']), /default-src 'self'/);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
});
