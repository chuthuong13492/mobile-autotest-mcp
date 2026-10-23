/**
 * Identifier generation (CORE-001; data model §2).
 *
 * - Opaque handles: `<prefix>_<ULID>`, monotonic within a millisecond so IDs from one generator sort by creation.
 * - Sequential domain IDs: `REQ-001`, `REQ-001.AC-01`, `TC-001`, … assigned deterministically.
 * - Test-target IDs: `TT-<adapterId>-<first 12 hex of sha256(path + "#" + selector)>`, stable across inventories.
 */
import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface IdGeneratorOptions {
  /** Milliseconds since epoch; injected for tests. */
  readonly now?: () => number;
  /** Source of `n` random bytes; injected for tests. */
  readonly random?: (n: number) => Uint8Array;
}

/** A handle generator; `newId('run')` → `run_01J…`. */
export interface IdGenerator {
  newId(prefix: string): string;
}

const HANDLE_PREFIX = /^[a-z]{2,8}$/;

/** Creates a monotonic ULID handle generator (48-bit ms timestamp + 80-bit randomness, Crockford base32). */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((n: number) => randomBytes(n));
  let lastTime = -1;
  let lastRandom: Uint8Array = new Uint8Array(10);

  return {
    newId(prefix: string): string {
      if (!HANDLE_PREFIX.test(prefix)) throw new Error(`invalid handle prefix: ${prefix}`);
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffffffff)
        throw new Error('timestamp out of ULID range');
      if (time === lastTime) {
        lastRandom = incrementRandom(lastRandom);
      } else {
        lastTime = time;
        lastRandom = Uint8Array.from(random(10));
      }
      return `${prefix}_${encodeTime(time)}${encodeRandom(lastRandom)}`;
    },
  };
}

function encodeTime(time: number): string {
  let out = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits → 16 base32 chars, most significant bits first.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(bits & 31n)]! + out;
    bits >>= 5n;
  }
  return out;
}

function incrementRandom(bytes: Uint8Array): Uint8Array {
  const next = Uint8Array.from(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 255) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID randomness overflow within one millisecond');
}

/** Formats a sequential ID, e.g. `formatSeqId('REQ', 7)` → `REQ-007`. */
export function formatSeqId(prefix: string, n: number, width = 3): string {
  if (!Number.isInteger(n) || n < 1 || String(n).length > width)
    throw new Error(`sequence ${n} out of range for width ${width}`);
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

/** Next sequential ID after the highest existing one with the same prefix (gaps are never reused). */
export function nextSeqId(prefix: string, existing: Iterable<string>, width = 3): string {
  const re = new RegExp(`^${prefix}-(\\d{${width}})$`);
  let max = 0;
  for (const id of existing) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return formatSeqId(prefix, max + 1, width);
}

/** Acceptance-criterion ID scoped to its requirement: `acId('REQ-001', 2)` → `REQ-001.AC-02`. */
export function acId(requirementId: string, n: number): string {
  if (!/^REQ-\d{3}$/.test(requirementId)) throw new Error(`invalid requirement id: ${requirementId}`);
  return `${requirementId}.${formatSeqId('AC', n, 2)}`;
}

/** Normalizes a workspace-relative path to POSIX form without a leading `./`. Rejects absolute or escaping paths. */
export function normalizeRelPath(p: string): string {
  const posix = p.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) throw new Error(`path must be relative: ${p}`);
  const parts: string[] = [];
  for (const seg of posix.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error(`path escapes the workspace: ${p}`);
    parts.push(seg);
  }
  if (parts.length === 0) throw new Error('empty path');
  return parts.join('/');
}

/** Stable test-target ID (data model §2). */
export function targetId(adapterId: string, relPath: string, selector = ''): string {
  if (!/^[a-z0-9-]+$/.test(adapterId)) throw new Error(`invalid adapter id: ${adapterId}`);
  const digest = createHash('sha256')
    .update(`${normalizeRelPath(relPath)}#${selector}`, 'utf8')
    .digest('hex');
  return `TT-${adapterId}-${digest.slice(0, 12)}`;
}
