import { describe, expect, it } from 'vitest';
import {
  acId,
  createIdGenerator,
  formatSeqId,
  nextSeqId,
  normalizeRelPath,
  PlanId,
  RunId,
  targetId,
  TestTargetId,
} from '@autotest/core';

describe('CORE-001 identifiers', () => {
  it('mints handles that satisfy the contract regexes', () => {
    const gen = createIdGenerator();
    expect(RunId.safeParse(gen.newId('run')).success).toBe(true);
    expect(PlanId.safeParse(gen.newId('plan')).success).toBe(true);
  });

  it('is monotonic within one millisecond and sortable across time', () => {
    let t = 1_761_177_600_000;
    const gen = createIdGenerator({ now: () => t, random: () => new Uint8Array(10).fill(7) });
    const a = gen.newId('run');
    const b = gen.newId('run');
    t += 1;
    const c = gen.newId('run');
    expect(a < b && b < c).toBe(true);
    expect(a.slice(0, 14)).toBe(b.slice(0, 14));
  });

  it('rejects bad prefixes and out-of-range clocks', () => {
    expect(() => createIdGenerator().newId('RUN')).toThrow();
    expect(() => createIdGenerator({ now: () => -1 }).newId('run')).toThrow();
  });

  it('formats and advances sequential IDs without reusing gaps', () => {
    expect(formatSeqId('REQ', 7)).toBe('REQ-007');
    expect(nextSeqId('TC', ['TC-001', 'TC-004', 'REQ-009'])).toBe('TC-005');
    expect(nextSeqId('TC', [])).toBe('TC-001');
    expect(acId('REQ-002', 3)).toBe('REQ-002.AC-03');
    expect(() => formatSeqId('REQ', 1000)).toThrow();
  });

  it('derives stable test-target IDs from normalized paths', () => {
    const a = targetId('flutter', 'test/widget/badge_test.dart', 'file');
    expect(TestTargetId.safeParse(a).success).toBe(true);
    expect(targetId('flutter', './test//widget/badge_test.dart', 'file')).toBe(a);
    expect(targetId('flutter', 'test\\widget\\badge_test.dart', 'file')).toBe(a);
    expect(targetId('flutter', 'test/widget/badge_test.dart', 'name:x')).not.toBe(a);
  });

  it('refuses absolute or escaping paths', () => {
    expect(() => normalizeRelPath('/etc/passwd')).toThrow();
    expect(() => normalizeRelPath('test/../../x')).toThrow();
    expect(() => normalizeRelPath('C:/x')).toThrow();
  });
});
