import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_KINDS, applyRedactions, detectPII, parseTerms } from './pii.ts';

test('finds common personal data', () => {
  const text = 'Mail jane.doe@example.com or call +91 98765 43210. Card 4111 1111 1111 1111. PAN ABCDE1234F. Aadhaar 2345 6789 0123.';
  const kinds = detectPII(text, DEFAULT_KINDS).map((f) => f.kind);
  assert.deepEqual(kinds, ['EMAIL', 'PHONE', 'CARD', 'PAN', 'AADHAAR']);
});

test('ignores short numbers and invalid cards', () => {
  const f = detectPII('Invoice 12345, total 250.00, card 1234 5678 9012 3456', DEFAULT_KINDS);
  assert.ok(!f.some((x) => x.kind === 'CARD'));
  assert.ok(!f.some((x) => x.text === '12345'));
});

test('custom terms are case-insensitive and win over patterns', () => {
  const text = 'Alex Morgan lives at 12 Main Road. ALEX signed.';
  const f = detectPII(text, DEFAULT_KINDS, parseTerms('alex morgan, Main Road, alex'));
  assert.equal(applyRedactions(text, f), '[REDACTED] lives at 12 [REDACTED]. [REDACTED] signed.');
});

test('redaction labels include the kind', () => {
  const text = 'a@b.co';
  assert.equal(applyRedactions(text, detectPII(text, DEFAULT_KINDS)), '[REDACTED EMAIL]');
});
