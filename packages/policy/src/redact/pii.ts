/**
 * Privacy-preserving log helpers (POL-005; NFR-011): coordinates are coarsened to one decimal place, and e-mail
 * addresses and phone numbers are replaced by salted, truncated hashes that keep log lines correlatable without
 * identifying anyone.
 */
import { createHash } from 'node:crypto';

/** Rounds a latitude/longitude to 1 decimal place (~11 km), as a string for logging. */
export function coarsenCoordinate(value: number): string {
  if (!Number.isFinite(value)) return 'NaN';
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** `pii:<12 hex>` from a salted SHA-256; the salt is per data root so hashes do not correlate across installs. */
export function hashPii(value: string, salt: string): string {
  return `pii:${createHash('sha256').update(`${salt}\0${value.trim().toLowerCase()}`).digest('hex').slice(0, 12)}`;
}

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g;
/** International-format phone numbers only (leading +), to avoid hashing timestamps and counters. */
const PHONE = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}\b/g;

/** Replaces e-mail addresses and international phone numbers in a log line by their hashes. */
export function hashPiiInText(text: string, salt: string): string {
  return text.replace(EMAIL, (m) => hashPii(m, salt)).replace(PHONE, (m) => hashPii(m.replace(/[^\d+]/g, ''), salt));
}
