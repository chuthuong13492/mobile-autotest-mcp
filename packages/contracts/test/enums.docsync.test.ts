import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_REASONS,
  ApprovalState,
  FAILURE_SUBTYPES,
  FailureClass,
  PrVerdict,
  RUN_STATES,
  STATUS_CATEGORY_BY_STATE,
  TERMINAL_RUN_STATES,
  TEST_OUTCOMES,
} from '@autotest/contracts';
import { firstCellCodes, readDoc, section } from './docs.ts';

const dm = readDoc('docs/data-model-and-artifacts.md');

describe('CON-001 enums match docs/data-model-and-artifacts.md', () => {
  it('run lifecycle states, terminal set and status categories', () => {
    const table = section(dm, '### Run lifecycle');
    const rows = [...table.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \|[^|]*\| `([a-z]+)` \|$/gm)];
    expect(rows.map((r) => r[1]).sort()).toEqual([...RUN_STATES].sort());
    for (const [, state, kind, category] of rows) {
      expect(STATUS_CATEGORY_BY_STATE[state as keyof typeof STATUS_CATEGORY_BY_STATE]).toBe(category);
      expect(kind!.includes('terminal') && !kind!.includes('non-')).toBe(
        (TERMINAL_RUN_STATES as readonly string[]).includes(state!),
      );
    }
  });

  it('state diagram uses only canonical states', () => {
    const diagram = /```mermaid\nstateDiagram-v2\n([\s\S]*?)```/.exec(dm)?.[1] ?? '';
    const used = new Set([...diagram.matchAll(/([a-z_]+) --> ([a-z_]+)/g)].flatMap((m) => [m[1], m[2]]));
    expect([...used].sort()).toEqual([...RUN_STATES].sort());
  });

  it('per-test outcomes', () => {
    expect(firstCellCodes(section(dm, '### Per-test outcome')).sort()).toEqual([...TEST_OUTCOMES].sort());
  });

  it('failure classes and subtypes', () => {
    const rows = [...section(dm, '### Failure classification').matchAll(/^\| `([a-z_]+)` \| ([^|]+) \|/gm)];
    expect(rows.map((r) => r[1]).sort()).toEqual([...FailureClass.options].sort());
    for (const [, cls, subtypes] of rows) {
      const docSubs = [...subtypes!.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
      expect(docSubs).toEqual([...FAILURE_SUBTYPES[cls as keyof typeof FAILURE_SUBTYPES]]);
    }
  });

  it('approval states', () => {
    const text = section(dm, '### Approval states');
    const states = new Set([...text.matchAll(/`([^`]+)`/g)].flatMap((m) => m[1]!.split(/[^a-z_]+/).filter(Boolean)));
    for (const s of ApprovalState.options) expect(states.has(s)).toBe(true);
  });

  it('execution authorization reasons', () => {
    const text = section(dm, '### Execution authorization result');
    const listed = [...text.matchAll(/^- `([a-z_]+)`$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...AUTHORIZATION_REASONS]);
  });

  it('PR verdicts in rule table', () => {
    const verdicts = new Set(
      [...section(dm, '### PR verdict rules').matchAll(/\| `(pass|fail|inconclusive|blocked)` \|$/gm)].map((m) => m[1]),
    );
    expect([...verdicts].sort()).toEqual([...PrVerdict.options].sort());
  });
});
