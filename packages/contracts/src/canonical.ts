/**
 * RFC 8785 JSON Canonicalization Scheme (CORE-002; RL-013). Lives in contracts because the canonical byte form is
 * itself part of the contract (plan hashes, scope digests, policy versions) and must be identical in every package.
 *
 * Objects: properties sorted by UTF-16 code units, recursively; arrays keep order; no whitespace;
 * numbers and strings serialized the ECMAScript way (identical to JSON.stringify for valid input).
 * Input must be I-JSON: NaN/Infinity, lone surrogates, bigint, undefined array members and non-plain objects throw.
 * Object properties whose value is `undefined` are omitted (as JSON.stringify does) so optional fields hash identically
 * whether absent or explicitly undefined.
 */
import { createHash } from 'node:crypto';

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Serializes `value` to its RFC 8785 canonical form. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, at: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(`${at}: non-finite number`);
      return JSON.stringify(value); // ES Number::toString; -0 → "0"
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalizationError(`${at}: lone surrogate`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((v, i) => {
            if (v === undefined) throw new CanonicalizationError(`${at}[${i}]: undefined array member`);
            return serialize(v, `${at}[${i}]`);
          })
          .join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError(`${at}: not a plain object`);
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(); // default sort compares UTF-16 code units, as RFC 8785 requires
      return `{${keys
        .map((k) => {
          if (LONE_SURROGATE.test(k)) throw new CanonicalizationError(`${at}: lone surrogate in key`);
          return `${JSON.stringify(k)}:${serialize(obj[k], `${at}.${k}`)}`;
        })
        .join(',')}}`;
    }
    default:
      throw new CanonicalizationError(`${at}: unsupported type ${typeof value}`);
  }
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `sha256:<hex>` digest of the canonical form of `value` (scope digests, inputsDigest, set hashes). */
export function digest(value: unknown): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

/**
 * Text normalization applied before hashing (data model §Plan hash, step 4):
 * Unicode NFC, CRLF/CR → LF, collapse runs of spaces/tabs to one space, trim the whole text.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
