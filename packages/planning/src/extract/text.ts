/** Text helpers for requirement extraction: normalization and the observable / vague-term lexicons (GR-02). */
import { normalizeText } from '@autotest/core';

export const DEFAULT_VAGUE_TERMS = [
  'works',
  'correctly',
  'properly',
  'as expected',
  'is fine',
  'no issues',
  'looks good',
] as const;
export const DEFAULT_OBSERVABLE_VERBS = [
  'shows',
  'hides',
  'returns',
  'navigates',
  'emits',
  'equals',
  'contains',
  'is disabled',
] as const;

/** NFC, CRLF → LF, collapsed spaces/tabs, trimmed (the hashing normalization), plus newlines collapsed to spaces. */
export function normalizeLine(text: string): string {
  return normalizeText(text)
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (terms: readonly string[]) =>
  terms.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map(escape).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
    : undefined;

/** An observable result names a quoted value, a number or an observable verb (GR-02). */
export function isObservable(text: string, verbs: readonly string[] = DEFAULT_OBSERVABLE_VERBS): boolean {
  if (/["'“”‘’][^"'“”‘’]+["'“”‘’]/.test(text) || /\d/.test(text)) return true;
  return wordRe(verbs)?.test(text) ?? false;
}

export function containsVagueTerm(text: string, terms: readonly string[] = DEFAULT_VAGUE_TERMS): boolean {
  return wordRe(terms)?.test(text) ?? false;
}
