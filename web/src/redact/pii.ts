// Pattern-based detection of personal data. Runs entirely in the browser.
// It is a helper, not a guarantee: the user always reviews the result.

export interface Finding {
  start: number;
  end: number;
  kind: string;
  text: string;
}

interface Detector {
  kind: string;
  label: string;
  re: RegExp;
  check?: (m: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');

function luhn(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

// Order matters: earlier detectors win when matches overlap.
export const DETECTORS: Detector[] = [
  { kind: 'EMAIL', label: 'Emails', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'CARD', label: 'Card numbers', re: /\b\d(?:[ -]?\d){12,18}\b/g, check: luhn },
  { kind: 'AADHAAR', label: 'Aadhaar', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'PAN', label: 'PAN (India)', re: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { kind: 'SSN', label: 'SSN (US)', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: 'IBAN', label: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g },
  {
    kind: 'PHONE', label: 'Phone numbers',
    re: /(?<![\w])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]?\d{2,5}){1,4}(?![\w])/g,
    check: (m) => { const n = digits(m).length; return n >= 10 && n <= 15; },
  },
  { kind: 'IP', label: 'IP addresses', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  { kind: 'DATE', label: 'Dates (e.g. birth dates)', re: /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b/g },
];

export const DEFAULT_KINDS = new Set(DETECTORS.map((d) => d.kind).filter((k) => k !== 'DATE'));

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseTerms(input: string): string[] {
  return input.split(/[,\n]/).map((t) => t.trim()).filter((t) => t.length >= 2);
}

export function detectPII(text: string, kinds: Set<string>, customTerms: string[] = []): Finding[] {
  const found: Finding[] = [];
  const overlaps = (s: number, e: number) => found.some((f) => s < f.end && e > f.start);
  const add = (kind: string, re: RegExp, check?: (m: string) => boolean) => {
    for (const m of text.matchAll(re)) {
      const s = m.index!;
      const e = s + m[0].length;
      if ((!check || check(m[0])) && !overlaps(s, e)) found.push({ start: s, end: e, kind, text: m[0] });
    }
  };
  // Custom terms (names, addresses…) first: the user asked for them explicitly.
  for (const term of customTerms) add('CUSTOM', new RegExp(escapeRe(term), 'gi'));
  for (const d of DETECTORS) if (kinds.has(d.kind)) add(d.kind, new RegExp(d.re.source, d.re.flags), d.check);
  return found.sort((a, b) => a.start - b.start);
}

export function applyRedactions(text: string, findings: Finding[]): string {
  let out = '';
  let pos = 0;
  for (const f of [...findings].sort((a, b) => a.start - b.start)) {
    if (f.start < pos) continue;
    out += text.slice(pos, f.start) + `[REDACTED ${f.kind === 'CUSTOM' ? '' : f.kind + ' '}]`.replace(' ]', ']');
    pos = f.end;
  }
  return out + text.slice(pos);
}
