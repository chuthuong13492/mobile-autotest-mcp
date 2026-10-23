/**
 * Opaque pagination cursors and page fitting (MCP-002; mcp-tool-contracts §2.3–§2.4; T-21).
 *
 * A cursor is `cur_<base64url(payload)>.<base64url(HMAC-SHA256(payload))>` with the payload
 * `{v, tool, snapshotId, filterDigest, offset, exp}`, keyed by a per-install secret held in the data root. A cursor
 * is accepted only for the same tool and the same filter, before it expires; anything else is `E_CURSOR_INVALID`.
 * Pages come from an immutable snapshot, so items never shift between pages.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { digest, toolError, type ToolError } from '@autotest/contracts';
import type { Clock } from './ports.ts';

export const DEFAULT_CURSOR_TTL_MS = 3_600_000;
/** Serialized `structuredContent` cap (NFR-004). */
export const OUTPUT_CAP_CHARS = 20_000;

export interface CursorPosition {
  readonly tool: string;
  readonly snapshotId: string;
  readonly filterDigest: string;
  readonly offset: number;
}

export type CursorOpen =
  | { readonly ok: true; readonly snapshotId: string; readonly offset: number }
  | { readonly ok: false; readonly reason: 'malformed' | 'forged' | 'expired' | 'mismatch' };

export interface CursorCodec {
  mint(position: CursorPosition): string;
  open(cursor: string, expected: { readonly tool: string; readonly filterDigest: string }): CursorOpen;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function createCursorCodec(key: Uint8Array, clock: Clock, ttlMs: number = DEFAULT_CURSOR_TTL_MS): CursorCodec {
  if (key.length < 32) throw new RangeError('cursor key must be at least 32 bytes');
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest();
  return {
    mint(p) {
      const payload = b64(
        JSON.stringify({
          v: 1,
          tool: p.tool,
          snapshotId: p.snapshotId,
          filterDigest: p.filterDigest,
          offset: p.offset,
          exp: clock.now().getTime() + ttlMs,
        }),
      );
      return `cur_${payload}.${b64(mac(payload))}`;
    },
    open(cursor, expected) {
      const m = /^cur_([A-Za-z0-9_-]{1,3000})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
      if (!m) return { ok: false, reason: 'malformed' };
      const given = Buffer.from(m[2]!, 'base64url');
      const want = mac(m[1]!);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: 'forged' };
      let p: {
        v?: unknown;
        tool?: unknown;
        snapshotId?: unknown;
        filterDigest?: unknown;
        offset?: unknown;
        exp?: unknown;
      };
      try {
        p = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      if (
        p.v !== 1 ||
        typeof p.snapshotId !== 'string' ||
        !Number.isInteger(p.offset) ||
        (p.offset as number) < 0 ||
        typeof p.exp !== 'number'
      )
        return { ok: false, reason: 'malformed' };
      if (clock.now().getTime() > p.exp) return { ok: false, reason: 'expired' };
      if (p.tool !== expected.tool || p.filterDigest !== expected.filterDigest)
        return { ok: false, reason: 'mismatch' };
      return { ok: true, snapshotId: p.snapshotId, offset: p.offset as number };
    },
  };
}

export interface PageOptions<T, O> {
  readonly codec: CursorCodec;
  readonly tool: string;
  readonly cursor?: string | undefined;
  readonly limit: number;
  /** Everything that selects items (filters); a cursor only continues the same selection. */
  readonly filter: unknown;
  /** Identity of the immutable item list (e.g. inventory id, or run id plus a final-snapshot marker). */
  readonly snapshotId: string;
  readonly items: readonly T[];
  /** Builds the tool output for one page. */
  readonly render: (page: readonly T[], meta: { readonly nextCursor: string | null; readonly truncated: boolean }) => O;
  readonly capChars?: number;
}

export type PageResult<O> =
  { readonly ok: true; readonly value: O } | { readonly ok: false; readonly error: ToolError };

/**
 * Selects a page and shrinks it until the rendered output fits the cap. When items had to be dropped, `truncated`
 * is true and `nextCursor` continues right after the last item returned.
 */
export function paginate<T, O>(o: PageOptions<T, O>): PageResult<O> {
  const cap = o.capChars ?? OUTPUT_CAP_CHARS;
  const filterDigest = digest(o.filter ?? null);
  let offset = 0;
  if (o.cursor !== undefined) {
    const c = o.codec.open(o.cursor, { tool: o.tool, filterDigest });
    if (!c.ok)
      return {
        ok: false,
        error: toolError('E_CURSOR_INVALID', `cursor rejected (${c.reason})`, ['Restart paging without a cursor']),
      };
    if (c.snapshotId !== o.snapshotId)
      return {
        ok: false,
        error: toolError('E_CURSOR_INVALID', 'cursor rejected (snapshot changed)', ['Restart paging without a cursor']),
      };
    offset = c.offset;
  }
  const requested = o.items.slice(offset, offset + o.limit);
  const build = (n: number) => {
    const end = offset + n;
    const truncated = n < requested.length;
    const nextCursor =
      end < o.items.length ? o.codec.mint({ tool: o.tool, snapshotId: o.snapshotId, filterDigest, offset: end }) : null;
    return o.render(requested.slice(0, n), { nextCursor, truncated });
  };
  const fits = (n: number) => JSON.stringify(build(n)).length <= cap;
  if (fits(requested.length)) return { ok: true, value: build(requested.length) };
  // Largest n that fits (monotonic in n).
  let lo = 0;
  let hi = requested.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0 && requested.length > 0)
    return {
      ok: false,
      error: toolError('E_INTERNAL', 'a single item exceeds the output cap', [
        'Report this; per-field caps should prevent it',
      ]),
    };
  return { ok: true, value: build(lo) };
}
