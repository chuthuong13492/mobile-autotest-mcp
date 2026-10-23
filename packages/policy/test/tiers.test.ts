import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '@autotest/contracts';
import {
  ALWAYS_PROHIBITED,
  DEFAULT_MIN_ASSURANCE,
  checkAssuranceOverrides,
  compareAssurance,
  minAssurance,
  tierFor,
} from '@autotest/policy';

const DOCS = path.resolve(import.meta.dirname, '../../../docs');
const read = (f: string) => fs.readFileSync(path.join(DOCS, f), 'utf8');
const section = (text: string, heading: string) => {
  const start = text.indexOf(heading);
  const next = text.indexOf('\n#', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
};
const expandTl = (cell: string): string[] =>
  [...cell.matchAll(/TL-(\d{2})(?:\s*[–-]\s*TL-(\d{2}))?/g)].flatMap((m) => {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return Array.from({ length: b - a + 1 }, (_, i) => `TL-${String(a + i).padStart(2, '0')}`);
  });

describe('POL-006 docs-sync: threat model tier table', () => {
  const table = section(read('security-threat-model.md'), '## Permission tiers and approval matrix');
  const rows = Object.fromEntries(
    table
      .split('\n')
      .filter((l) => /^\| \*\*P\d\*\*/.test(l))
      .map((l) => {
        const cells = l.split('|').map((c) => c.trim());
        return [cells[1]!.replace(/\*/g, ''), expandTl(cells[3]!)];
      }),
  );

  it('every tool tier in contracts matches the canonical table', () => {
    for (const tier of ['P0', 'P1', 'P2', 'P3'] as const) {
      const fromContracts = TOOLS.filter((t) => (t.tier as readonly string[]).includes(tier))
        .map((t) => t.id)
        .sort();
      expect(fromContracts, tier).toEqual([...new Set(rows[tier])].sort());
    }
  });

  it('the always-prohibited list matches the doc bullets', () => {
    const bullets = section(read('security-threat-model.md'), '### Always prohibited')
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(ALWAYS_PROHIBITED.length);
    ALWAYS_PROHIBITED.forEach((p, i) => expect(bullets[i]).toContain(p.summary));
  });
});

describe('POL-006 docs-sync: ADR-0006 minimum assurance table', () => {
  const table = section(read('architecture-decisions/ADR-0006.md'), '### 2. Minimum assurance by action');
  const cellsOf = (label: string) => {
    const line = table.split('\n').find((l) => l.startsWith(`| ${label}`));
    expect(line, label).toBeDefined();
    return line!
      .split('|')
      .map((c) => c.trim())
      .slice(2, 4);
  };
  const level = (cell: string) =>
    /^Not allowed/.test(cell) ? 'not_allowed' : /^none/.test(cell) ? 'none' : (/AL\d/.exec(cell)?.[0] ?? '?');
  const rows: [string, keyof typeof DEFAULT_MIN_ASSURANCE][] = [
    ['Execute a `needs_review` plan', 'plan_execution'],
    ['Coverage exception', 'coverage_exception'],
    ['P2 device action on a non-owned', 'device_action'],
    ['P3 GitHub publication', 'github_publish'],
  ];
  for (const [label, scope] of rows) {
    it(`${scope} defaults match the ADR row`, () => {
      const [local, ci] = cellsOf(label);
      expect([level(local!), level(ci!)]).toEqual([
        DEFAULT_MIN_ASSURANCE[scope].local,
        DEFAULT_MIN_ASSURANCE[scope].ci,
      ]);
    });
  }
  it('the P3 row allows pre-authorization; owned device actions need none', () => {
    expect(cellsOf('P3 GitHub publication').join()).toMatch(/pre-authorization/i);
    expect(minAssurance('github_publish', 'ci').preauthSatisfies).toBe(true);
    expect(minAssurance('plan_execution', 'local').preauthSatisfies).toBe(false);
    expect(cellsOf('P2 action on a run-owned').map(level)).toEqual(['none', 'none']);
    expect(tierFor('manage_simulator', { action: 'erase', owned: true })).toBe('P1');
  });
});

describe('POL-006 tiers and overrides', () => {
  it('tierFor resolves TL-14 by ownership and action, strict when unknown', () => {
    expect(tierFor('run_tests')).toBe('P1');
    expect(tierFor('publish_github_report')).toBe('P3');
    expect(tierFor('get_pr_context')).toBe('P0');
    expect(tierFor('manage_simulator', { action: 'create' })).toBe('P1');
    expect(tierFor('manage_simulator', { action: 'boot', owned: true })).toBe('P1');
    expect(tierFor('manage_simulator', { action: 'boot', owned: false })).toBe('P2');
    expect(tierFor('manage_simulator', { action: 'shutdown' })).toBe('P2');
    expect(tierFor('manage_simulator', { action: 'erase', deviceKind: 'physical', owned: true })).toBe('prohibited');
    expect(tierFor('run_shell' as never)).toBe('prohibited');
  });

  it('overrides are upward-only unless allowWeakApprovals; not_allowed is locked', () => {
    expect(checkAssuranceOverrides({ plan_execution: { local: 'AL3' } }, false)).toEqual([]);
    expect(checkAssuranceOverrides({ plan_execution: { local: 'AL1' } }, false)).toEqual([
      { scopeKind: 'plan_execution', environment: 'local', reason: 'weaker_than_default' },
    ]);
    expect(checkAssuranceOverrides({ plan_execution: { local: 'AL1' } }, true)).toEqual([]);
    expect(checkAssuranceOverrides({ device_action: { ci: 'AL3' } }, true)).toEqual([
      { scopeKind: 'device_action', environment: 'ci', reason: 'locked' },
    ]);
    expect(minAssurance('plan_execution', 'local', { plan_execution: { local: 'AL3' } }).required).toBe('AL3');
    expect(compareAssurance('AL3', 'AL2')).toBeGreaterThan(0);
  });
});
