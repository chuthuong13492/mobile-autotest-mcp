import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createCursorCodec, paginate } from '@autotest/core';

const key = new Uint8Array(32).fill(7);
const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const codec = createCursorCodec(key, clockAt('2026-10-23T01:00:00Z'));
const pos = { tool: 'get_run_results', snapshotId: 'run_x:final', filterDigest: 'sha256:f', offset: 50 };

describe('MCP-002 HMAC cursors', () => {
  it('round-trips and binds tool, filter, snapshot and expiry', () => {
    const c = codec.mint(pos);
    expect(c).toMatch(/^cur_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(codec.open(c, { tool: pos.tool, filterDigest: pos.filterDigest })).toEqual({
      ok: true,
      snapshotId: 'run_x:final',
      offset: 50,
    });
    expect(codec.open(c, { tool: 'inspect_test_inventory', filterDigest: pos.filterDigest })).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(codec.open(c, { tool: pos.tool, filterDigest: 'sha256:other' })).toEqual({ ok: false, reason: 'mismatch' });
    const later = createCursorCodec(key, clockAt('2026-10-23T02:00:01Z'));
    expect(later.open(c, { tool: pos.tool, filterDigest: pos.filterDigest })).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects forged and malformed cursors', () => {
    const c = codec.mint(pos);
    const [payload, mac] = c.slice(4).split('.') as [string, string];
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), offset: 0 }),
    ).toString('base64url');
    expect(codec.open(`cur_${tampered}.${mac}`, pos)).toEqual({ ok: false, reason: 'forged' });
    const other = createCursorCodec(new Uint8Array(32).fill(8), clockAt('2026-10-23T01:00:00Z'));
    expect(other.open(c, pos)).toEqual({ ok: false, reason: 'forged' });
    for (const bad of ['', 'cur_', 'cur_eyJ...', 'abc.def', `cur_${payload}`, `${c}x`])
      expect(codec.open(bad, pos).ok).toBe(false);
    expect(() => createCursorCodec(new Uint8Array(16), clockAt('2026-10-23T01:00:00Z'))).toThrow(RangeError);
  });
});

describe('MCP-002 paginate', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ i, text: 'x'.repeat(900) }));
  const render = (page: readonly { i: number }[], meta: { nextCursor: string | null; truncated: boolean }) => ({
    items: page,
    ...meta,
  });
  const base = { codec, tool: 't', limit: 50, filter: { a: 1 }, snapshotId: 's1', items, render };

  it('shrinks a page to the cap, marks it truncated and continues with a cursor', () => {
    const first = paginate(base);
    if (!first.ok) throw new Error('unexpected');
    expect(JSON.stringify(first.value).length).toBeLessThanOrEqual(20_000);
    expect(first.value.truncated).toBe(true);
    expect(first.value.items.length).toBeGreaterThan(0);
    const second = paginate({ ...base, cursor: first.value.nextCursor! });
    if (!second.ok) throw new Error('unexpected');
    expect(second.value.items[0]!.i).toBe(first.value.items.length);
  });

  it('rejects cursors for another filter or snapshot, and items bigger than the cap', () => {
    const first = paginate(base);
    if (!first.ok) throw new Error('unexpected');
    expect(paginate({ ...base, filter: { a: 2 }, cursor: first.value.nextCursor! })).toMatchObject({
      ok: false,
      error: { error: { code: 'E_CURSOR_INVALID' } },
    });
    expect(paginate({ ...base, snapshotId: 's2', cursor: first.value.nextCursor! })).toMatchObject({
      ok: false,
      error: { error: { code: 'E_CURSOR_INVALID' } },
    });
    expect(paginate({ ...base, items: [{ i: 0, text: 'y'.repeat(30_000) }] })).toMatchObject({
      ok: false,
      error: { error: { code: 'E_INTERNAL' } },
    });
    expect(paginate({ ...base, items: [] })).toEqual({
      ok: true,
      value: { items: [], nextCursor: null, truncated: false },
    });
  });

  it('property: following cursors returns every item exactly once, in order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3000 }), { maxLength: 120 }),
        fc.integer({ min: 1, max: 60 }),
        (sizes, limit) => {
          const its = sizes.map((n, i) => ({ i, text: 'z'.repeat(n) }));
          const seen: number[] = [];
          let cursor: string | undefined;
          for (let guard = 0; guard < 500; guard++) {
            const r = paginate({ ...base, items: its, limit, ...(cursor ? { cursor } : {}) });
            if (!r.ok) return false;
            seen.push(...r.value.items.map((x) => x.i));
            if (!r.value.nextCursor) break;
            cursor = r.value.nextCursor;
          }
          return JSON.stringify(seen) === JSON.stringify(its.map((x) => x.i));
        },
      ),
      { numRuns: 100 },
    );
  });
});
