import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_SIZE, TAG_SIZE, chunkCountFor, decryptChunk, decryptMeta, encryptChunk, encryptMeta,
  encryptedSizeFor, fromB64u, generateFileKey, importFileKey, isValidLayout, randomBytes, toB64u,
  unwrapFileKey, wrapFileKey,
} from './format.ts';

test('base64url round-trips', () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const b = randomBytes(n);
    assert.deepEqual(fromB64u(toB64u(b)), b);
  }
  assert.throws(() => fromB64u('a+b/'));
});

test('layout math', () => {
  assert.equal(chunkCountFor(0), 1);
  assert.equal(chunkCountFor(CHUNK_SIZE), 1);
  assert.equal(chunkCountFor(CHUNK_SIZE + 1), 2);
  assert.equal(encryptedSizeFor(0), TAG_SIZE);
  assert.ok(isValidLayout(encryptedSizeFor(CHUNK_SIZE * 3 + 5), 4));
  assert.ok(!isValidLayout(encryptedSizeFor(CHUNK_SIZE * 3 + 5), 3));
  assert.ok(!isValidLayout(5, 1));
});

test('chunk round-trip and tamper detection', async () => {
  const key = await importFileKey(generateFileKey());
  const plain = randomBytes(1000);
  const ct = await encryptChunk(key, 3, true, plain);
  assert.deepEqual(await decryptChunk(key, 3, true, ct), plain);

  await assert.rejects(decryptChunk(key, 2, true, ct), 'reordering is detected');
  await assert.rejects(decryptChunk(key, 3, false, ct), 'truncation (last flag) is detected');
  const bad = ct.slice(); bad[10] ^= 1;
  await assert.rejects(decryptChunk(key, 3, true, bad), 'bit flips are detected');
  const other = await importFileKey(generateFileKey());
  await assert.rejects(decryptChunk(other, 3, true, ct), 'wrong key is detected');
});

test('metadata round-trip', async () => {
  const key = await importFileKey(generateFileKey());
  const meta = { v: 1 as const, name: 'résumé.pdf', type: 'application/pdf', size: 10, chunkCount: 1 };
  assert.deepEqual(await decryptMeta(key, await encryptMeta(key, meta)), meta);
  const lying = { ...meta, chunkCount: 5 };
  await assert.rejects(decryptMeta(key, await encryptMeta(key, lying)));
});

test('password wrap needs both link secret and password', async () => {
  const fileKey = generateFileKey();
  const secret = randomBytes(32);
  const wrap = await wrapFileKey(fileKey, secret, 'correct horse');
  assert.deepEqual(await unwrapFileKey(wrap, secret, 'correct horse'), fileKey);
  await assert.rejects(unwrapFileKey(wrap, secret, 'wrong'));
  await assert.rejects(unwrapFileKey(wrap, randomBytes(32), 'correct horse'));
});
