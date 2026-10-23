import { describe, expect, it } from 'vitest';
import { computeMetrics, metric, requirementStatuses, checkExceptions, type RunData } from '@autotest/coverage-gate';
import { build, NOW, req, tc, TARGET } from './fixtures.ts';

const run = (outcomes: Record<string, string>, executed: string[] = [TARGET.id]): RunData => ({
  outcomes: new Map(Object.entries(outcomes)) as RunData['outcomes'],
  executedTargets: new Set(executed),
});

describe('COV-002 metrics', () => {
  const b = build({
    reqs: [
      req(1, 'R2', 2, { platforms: ['ios', 'android'] }),
      req(2, 'R1'),
      req(3, 'R1', 1, { testable: false, nonTestableReason: 'backend' }),
    ],
    cases: [
      tc(1, 'REQ-001', { technique: 'regression', platforms: ['ios'], priority: 'must' }),
      tc(2, 'REQ-001', {
        acRefs: ['REQ-001.AC-01'],
        platforms: ['android'],
        eligibility: 'ineligible:platform_unavailable',
        targetRef: null,
      }),
    ],
    scope: ['ios', 'android'],
  });

  it('computes each formula with explicit numerators and denominators', () => {
    const m = computeMetrics(b.plan, b.set);
    expect(m.requirementCoverage).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.testCaseCoverage).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    // REQ-001 × {ios, android} + REQ-002 × {ios, android}; only (REQ-001, ios) has an eligible case.
    expect(m.platformCoverage).toEqual({ numerator: 1, denominator: 4, value: 0.25 });
    expect(m.regressionCoverage).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(m.sourceCodeCoverage).toBeNull();
    expect(m.executionCoverage).toBeNull();
  });

  it('null when the denominator is 0; execution counts only passed or failed mandatory cases', () => {
    expect(metric(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
    const none = build({
      reqs: [req(1, 'R1', 1, { testable: false, nonTestableReason: 'n/a' })],
      cases: [tc(1, 'REQ-001')],
    });
    expect(computeMetrics(none.plan, none.set).requirementCoverage?.value).toBeNull();
    // Only TC-001 is mandatory (priority must); a skipped test is not executed.
    expect(computeMetrics(b.plan, b.set, run({ 'TC-001': 'skipped', 'TC-002': 'passed' })).executionCoverage).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(computeMetrics(b.plan, b.set, run({ 'TC-001': 'failed' })).executionCoverage).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(computeMetrics(b.plan, b.set, run({ 'TC-001': 'not_run', 'TC-002': 'blocked' })).executionCoverage).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    });
    expect(
      computeMetrics(b.plan, b.set, { ...run({}), sourceCoverage: { covered: 30, instrumentable: 40 } })
        .sourceCodeCoverage,
    ).toEqual({ numerator: 30, denominator: 40, value: 0.75 });
  });
});

describe('COV-002 requirement status', () => {
  const ctx = { targets: [TARGET], now: NOW, exceptionMaxDays: 30 };
  const status = (cases: ReturnType<typeof tc>[], r?: RunData, exceptions: never[] = [], approved: string[] = []) => {
    const b = build({ reqs: [req(1, 'R1')], cases, exceptions });
    return requirementStatuses(
      b.plan,
      b.set,
      checkExceptions(b.plan.exceptions, { ...ctx, requirementSet: b.set, approvedExceptions: new Set(approved) }),
      r,
    )[0]!.status;
  };
  const elsewhere = {
    id: 'EXC-001',
    requirementRefs: ['REQ-001'],
    reason: 'covered_elsewhere',
    rationale: 'Covered by the integration suite in CI',
    evidenceLink: TARGET.path,
    expiresAt: '2026-11-01T00:00:00Z',
  } as never;

  it('evaluates each row in order', () => {
    expect(status([])).toBe('unmapped');
    expect(status([tc(1, 'REQ-001', { eligibility: 'ineligible:manual' })])).toBe('mapped');
    expect(status([tc(1, 'REQ-001')])).toBe('eligible');
    expect(status([tc(1, 'REQ-001'), tc(2, 'REQ-001')], run({ 'TC-001': 'passed', 'TC-002': 'failed' }))).toBe(
      'failing',
    );
    expect(status([tc(1, 'REQ-001'), tc(2, 'REQ-001')], run({ 'TC-001': 'passed', 'TC-002': 'timed_out' }))).toBe(
      'unverified',
    );
    expect(status([tc(1, 'REQ-001'), tc(2, 'REQ-001')], run({ 'TC-001': 'passed' }))).toBe('blocked');
    expect(status([tc(1, 'REQ-001')], run({ 'TC-001': 'passed' }))).toBe('passing');
    expect(status([tc(1, 'REQ-001'), tc(2, 'REQ-001')], run({ 'TC-001': 'passed', 'TC-002': 'skipped' }))).toBe(
      'executed',
    );
    expect(status([], undefined, [elsewhere], ['EXC-001'])).toBe('excepted');
    expect(status([], run({}, []), [elsewhere], ['EXC-001'])).toBe('unverified');
    expect(status([], run({}, [TARGET.id]), [elsewhere], ['EXC-001'])).toBe('excepted');
    expect(status([], undefined, [elsewhere], [])).toBe('unmapped');
  });

  it('mandatory cases decide when present; an unexecuted test never makes a requirement passing', () => {
    const cases = [tc(1, 'REQ-001', { priority: 'must' }), tc(2, 'REQ-001')];
    expect(status(cases, run({ 'TC-001': 'passed', 'TC-002': 'failed' }))).toBe('passing');
    expect(status(cases, run({ 'TC-002': 'passed' }))).toBe('blocked');
  });
});
