import { describe, expect, it } from 'vitest';
import type { CoverageDecision, FailureAnalysis, RequirementSet, TestPlan, TestResult } from '@autotest/core';
import { buildReportModel, caseOutcome, md, renderMarkdown, type ReportInput } from '@autotest/reporting';

const tc = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Case ${id}`,
  requirementRefs: ['REQ-001'],
  acRefs: ['REQ-001.AC-01'],
  level: 'unit',
  technique: 'positive',
  priority: 'must',
  platforms: ['host'],
  preconditions: [],
  steps: ['run'],
  expectedResults: ['ok'],
  targetRef: 'TT-flutter-aaaaaaaaaaaa',
  automation: 'existing_test',
  eligibility: 'eligible',
  riskTier: 'R1',
  ...over,
});
const plan = (cases = [tc('TC-001'), tc('TC-002')]) =>
  ({
    id: 'plan_01JC0000000000000000000001',
    version: 1,
    planHash: `v1:sha256:${'a'.repeat(64)}`,
    testCases: cases,
  }) as unknown as TestPlan;
const reqs = {
  requirements: [{ id: 'REQ-001', title: 'Badge <b>count</b>', riskTier: 'R1', acceptanceCriteria: [] }],
} as unknown as RequirementSet;
const cov = (decision: 'pass' | 'needs_review' | 'fail' = 'pass') =>
  ({
    id: 'cov_01JC0000000000000000000001',
    decision,
    metrics: {
      requirementCoverage: { numerator: 1, denominator: 1 },
      testCaseCoverage: null,
      sourceCodeCoverage: null,
      platformCoverage: null,
      regressionCoverage: null,
      executionCoverage: null,
    },
  }) as unknown as CoverageDecision;
let n = 0;
const res = (tcIds: string[], outcome: TestResult['outcome'], over: Partial<TestResult> = {}): TestResult => ({
  id: `res_01JC00000000000000000000${String(++n).padStart(2, '0')}`,
  runId: 'run_01JC000000000000000000000A',
  attemptNo: 1,
  testCaseIds: tcIds,
  targetId: 'TT-flutter-aaaaaaaaaaaa',
  name: `test ${n}`,
  outcome,
  flaky: false,
  artifactRefs: [],
  rawStatus: outcome,
  ...over,
});
const run = (state: 'completed' | 'cancelled' = 'completed') => ({
  id: 'run_01JC000000000000000000000A',
  state,
  partial: state !== 'completed',
  limitations: [],
});
const input = (over: Partial<ReportInput>): ReportInput => ({
  plan: plan(),
  requirements: reqs,
  coverage: cov(),
  needsReviewApproved: false,
  runs: [run()],
  results: [],
  analyses: [],
  ...over,
});

describe('RPT-001 verdict assembly: every rule of the verdict table', () => {
  it('rule 1 blocked: no run, a failed gate, or an unapproved needs_review', () => {
    expect(buildReportModel(input({ runs: [] })).verdictRule).toBe(1);
    expect(buildReportModel(input({ coverage: cov('fail') })).verdict).toBe('blocked');
    expect(buildReportModel(input({ coverage: cov('needs_review') })).verdictRule).toBe(1);
  });
  it('rule 2 blocked: every mandatory case unexecuted', () => {
    expect(buildReportModel(input({ results: [] }))).toMatchObject({ verdict: 'blocked', verdictRule: 2 });
  });
  it('rule 3 fail: a mandatory failure not excused by its analysis', () => {
    const r = [res(['TC-001'], 'failed', { failureKind: 'assertion' }), res(['TC-002'], 'passed')];
    expect(buildReportModel(input({ results: r }))).toMatchObject({ verdict: 'fail', verdictRule: 3 });
  });
  it('rule 4 inconclusive: an environment failure, an indeterminate case or a non-completed run', () => {
    const failed = res(['TC-001'], 'failed', { failureKind: 'exception' });
    const env = {
      id: 'fa_01JC0000000000000000000001',
      resultId: failed.id,
      class: 'environment_failure',
      subtype: 'dependency',
      strength: 'supported',
      confidence: 0.85,
      inference: 'x',
    } as FailureAnalysis;
    expect(buildReportModel(input({ results: [failed, res(['TC-002'], 'passed')], analyses: [env] })).verdictRule).toBe(
      4,
    );
    expect(
      buildReportModel(input({ results: [res(['TC-001'], 'passed'), res(['TC-002'], 'timed_out')] })).verdict,
    ).toBe('inconclusive');
    expect(
      buildReportModel(
        input({ runs: [run('cancelled')], results: [res(['TC-001'], 'passed'), res(['TC-002'], 'passed')] }),
      ).verdictRule,
    ).toBe(4);
  });
  it('rule 5 pass, with flaky mandatory passes listed under attention', () => {
    const m = buildReportModel(
      input({
        coverage: cov('needs_review'),
        needsReviewApproved: true,
        results: [res(['TC-001'], 'passed', { flaky: true }), res(['TC-002'], 'passed')],
      }),
    );
    expect(m).toMatchObject({ verdict: 'pass', verdictRule: 5 });
    expect(m.attention).toEqual(['TC-001: passed only after retry (flaky)']);
  });
});

describe('RPT-001 case outcomes', () => {
  it('a case that never executed is never passed; ineligible cases are listed as limitations', () => {
    const m = buildReportModel(
      input({
        plan: plan([
          tc('TC-001'),
          tc('TC-002', { automation: 'new_test_required', eligibility: 'ineligible', targetRef: null }),
        ]),
        results: [res(['TC-001'], 'passed')],
      }),
    );
    expect(m.cases.map((c) => [c.testCaseId, c.outcome])).toEqual([
      ['TC-001', 'passed'],
      ['TC-002', 'not_run'],
    ]);
    expect(m.plannedVsExecuted).toEqual({ planned: 2, executed: 1, notRun: 1, blocked: 0 });
    expect(m.limitations.map((l) => l.code)).toContain('case_not_executable');
  });
  it('aggregates several results of one case', () => {
    expect(caseOutcome([])).toEqual({ outcome: 'not_run', flaky: false });
    expect(caseOutcome([res([], 'passed'), res([], 'failed')]).outcome).toBe('failed');
    expect(caseOutcome([res([], 'passed'), res([], 'infra_error'), res([], 'cancelled')]).outcome).toBe('infra_error');
    expect(caseOutcome([res([], 'passed'), res([], 'skipped')])).toEqual({ outcome: 'passed', flaky: false });
    expect(caseOutcome([res([], 'skipped')]).outcome).toBe('skipped');
  });
});

describe('RPT-002 Markdown', () => {
  it('renders the sections and keeps injected content inert', () => {
    const evil = '<img src=x onerror=alert(1)> [click](javascript:alert(1)) | ### heading\n@everyone';
    const m = buildReportModel(
      input({
        results: [
          res(['TC-001'], 'failed', { failureKind: 'assertion', name: evil, messageExcerpt: 'line ``` break' }),
          res(['TC-002'], 'passed'),
        ],
        narrative: `ok\n${evil}`,
      }),
    );
    const text = renderMarkdown(m);
    for (const h of [
      '# AutoTest report: FAIL',
      '## Traceability',
      '## Test cases',
      '## Failures',
      '## Coverage metrics',
      '## Agent narrative (untrusted)',
    ])
      expect(text).toContain(h);
    expect(text).not.toContain('<img');
    expect(text).not.toContain('](javascript');
    expect(text).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;');
    expect(text).toContain('Badge &lt;b&gt;count&lt;/b&gt;');
    expect(text.match(/```/g)?.length).toBe(2);
    expect(text).toContain('> @everyone');
    expect(md('a|b\nc', true)).toBe('a\\|b c');
  });
  it('is capped for the comment variant', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      tc(`TC-${String(i + 1).padStart(3, '0')}`, { title: 'x'.repeat(150) }),
    );
    const text = renderMarkdown(buildReportModel(input({ plan: plan(many) })), { maxChars: 12_000 });
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).toMatch(/Report truncated/);
  });
});
