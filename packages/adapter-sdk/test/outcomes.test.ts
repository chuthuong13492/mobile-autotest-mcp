import { describe, expect, it } from 'vitest';
import {
  countOutcomes,
  excerpt,
  fillNotRun,
  mapRunnerState,
  mergeAttempts,
  type NormalizedResult,
  type ParseDiagnostic,
} from '@autotest/adapter-sdk';

const r = (name: string, outcome: NormalizedResult['outcome'], targetId = 'TT-x-000000000001'): NormalizedResult => ({
  targetId,
  name,
  outcome,
  rawStatus: outcome,
});

describe('ADP-002 outcome helpers', () => {
  it('maps known states through the table and unknown ones to infra_error with a diagnostic', () => {
    const d: ParseDiagnostic[] = [];
    const table = {
      success: { outcome: 'passed' as const },
      failure: { outcome: 'failed' as const, failureKind: 'assertion' as const },
    };
    expect(mapRunnerState('failure', table, d)).toEqual({ outcome: 'failed', failureKind: 'assertion' });
    expect(mapRunnerState('toString', table, d)).toEqual({ outcome: 'infra_error' });
    expect(mapRunnerState('flaked?', table, d)).toEqual({ outcome: 'infra_error' });
    expect(d.map((x) => x.code)).toEqual(['unknown_runner_state', 'unknown_runner_state']);
  });

  it('merges attempts: failed-then-passed is passed and flaky; a not_run retry keeps the earlier outcome', () => {
    const merged = mergeAttempts([
      [r('a', 'failed'), r('b', 'passed'), r('c', 'failed')],
      [r('a', 'passed'), r('b', 'not_run'), r('c', 'failed')],
    ]);
    expect(merged.map((m) => [m.name, m.outcome, m.flaky, m.attemptNo])).toEqual([
      ['a', 'passed', true, 2],
      ['b', 'passed', false, 1],
      ['c', 'failed', false, 2],
    ]);
  });

  it('accounts for every planned target and counts outcomes', () => {
    const all = fillNotRun(['TT-x-000000000001', 'TT-x-000000000002'], [r('a', 'passed')]);
    expect(all.map((x) => [x.targetId, x.outcome])).toEqual([
      ['TT-x-000000000001', 'passed'],
      ['TT-x-000000000002', 'not_run'],
    ]);
    expect(countOutcomes(all)).toEqual({ passed: 1, not_run: 1 });
    expect(excerpt('x'.repeat(3000))).toHaveLength(2048);
    expect(excerpt(undefined)).toBeUndefined();
  });
});
