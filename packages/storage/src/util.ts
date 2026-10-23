/** Small helpers shared by the SQLite repositories. */
import { PortError } from '@autotest/core';

/** Parses a stored JSON document through its schema; anything invalid is an integrity failure (fail closed). */
export const parseDoc = <T>(schema: { parse(v: unknown): T }, doc: string, what: string): T => {
  try {
    return schema.parse(JSON.parse(doc));
  } catch {
    throw new PortError('integrity', `${what}: stored document failed validation`);
  }
};

/** Normalizes Date → RFC 3339 without milliseconds (the contracts' Timestamp format). */
export const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
