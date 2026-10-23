import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TEST_OUTCOMES, computeVerdict, isMandatory, type VerdictCase, type VerdictInput } from '@autotest/core';

const must = (outcome: VerdictCase['outcome'], extra: Partial<VerdictCase> = {}): VerdictCase => ({
  testCaseId: 'TC-001',
  priority: 'must',
  riskTier: 'R1',
  outcome,
  flaky: false,
  ...extra,
});
const ok: VerdictInput = {
  gateDecision: 'pass',
  needsReviewApproved: false,
  authorizedRunExists: true,
  runStates: ['completed'],
  cases: [must('passed')],
};

describe('CORE-005 PR verdict table (data model §PR verdict rules)', () => {
  it.each([
    ['rule 1: gate fail', { ...ok, gateDecision: 'fail' }, 'blocked', 1],
    ['rule 1: needs_review without approval', { ...ok, gateDecision: 'needs_review' }, 'blocked', 1],
    ['rule 1: no authorized run', { ...ok, authorizedRunExists: false }, 'blocked', 1],
    [
      'rule 2: all mandatory not_run',
      { ...ok, cases: [must('not_run'), must('blocked', { testCaseId: 'TC-002' })] },
      'blocked',
      2,
    ],
    ['rule 3: mandatory failed, unanalyzed', { ...ok, cases: [must('failed')] }, 'fail', 3],
    [
      'rule 3: mandatory failed, test_defect',
      { ...ok, cases: [must('failed', { failureClass: 'test_defect' })] },
      'fail',
      3,
    ],
    [
      'rule 4: mandatory failed, environment',
      { ...ok, cases: [must('failed', { failureClass: 'environment_failure' })] },
      'inconclusive',
      4,
    ],
    [
      'rule 4: mandatory timed_out',
      { ...ok, cases: [must('passed'), must('timed_out', { testCaseId: 'TC-002' })] },
      'inconclusive',
      4,
    ],
    ['rule 4: run not completed', { ...ok, runStates: ['cancelled'] }, 'inconclusive', 4],
    ['rule 5: all mandatory passed', ok, 'pass', 5],
    ['rule 5: approved needs_review', { ...ok, gateDecision: 'needs_review', needsReviewApproved: true }, 'pass', 5],
  ] as const)('%s', (_n, input, verdict, rule) => {
    const r = computeVerdict(input as VerdictInput);
    expect([r.verdict, r.rule]).toEqual([verdict, rule]);
  });

  it('mandatory = must priority or R2/R3; with none flagged, all cases count', () => {
    expect(isMandatory({ priority: 'could', riskTier: 'R2' })).toBe(true);
    expect(isMandatory({ priority: 'should', riskTier: 'R1' })).toBe(false);
    const r = computeVerdict({ ...ok, cases: [{ ...must('failed'), priority: 'could' }] });
    expect(r.verdict).toBe('fail');
  });

  it('lists flaky mandatory passes and non-mandatory failures under attention', () => {
    const r = computeVerdict({
      ...ok,
      cases: [must('passed', { flaky: true }), { ...must('failed', { testCaseId: 'TC-009' }), priority: 'could' }],
    });
    expect(r.verdict).toBe('pass');
    expect(r.attention).toHaveLength(2);
  });

  it('property: never pass unless every mandatory case passed, the gate was acceptable and all runs completed', () => {
    const caseArb = fc.record({
      testCaseId: fc.constantFrom('TC-001', 'TC-002', 'TC-003'),
      priority: fc.constantFrom('must', 'should', 'could'),
      riskTier: fc.constantFrom('R0', 'R1', 'R2', 'R3'),
      outcome: fc.constantFrom(...TEST_OUTCOMES),
      flaky: fc.boolean(),
      failureClass: fc.option(
        fc.constantFrom('product_defect', 'test_defect', 'environment_failure', 'pre_existing', 'unknown'),
        { nil: undefined },
      ),
    });
    fc.assert(
      fc.property(
        fc.record({
          gateDecision: fc.constantFrom('pass', 'fail', 'needs_review'),
          needsReviewApproved: fc.boolean(),
          authorizedRunExists: fc.boolean(),
          runStates: fc.array(fc.constantFrom('completed', 'cancelled', 'timed_out', 'infra_error'), { maxLength: 3 }),
          cases: fc.array(caseArb, { maxLength: 6 }),
        }),
        (input) => {
          const r = computeVerdict(input as VerdictInput);
          if (r.verdict === 'pass') {
            const flagged = input.cases.filter((c) => isMandatory(c as VerdictCase));
            const mandatory = flagged.length ? flagged : input.cases;
            expect(mandatory.length).toBeGreaterThan(0);
            expect(mandatory.every((c) => c.outcome === 'passed')).toBe(true);
            expect(input.authorizedRunExists).toBe(true);
            expect(
              input.gateDecision === 'pass' || (input.gateDecision === 'needs_review' && input.needsReviewApproved),
            ).toBe(true);
            expect(input.runStates.length > 0 && input.runStates.every((s) => s === 'completed')).toBe(true);
          }
          if (input.gateDecision === 'fail') expect(r.verdict).toBe('blocked');
        },
      ),
      { numRuns: 2000 },
    );
  });
});
