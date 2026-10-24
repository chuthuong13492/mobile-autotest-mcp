/**
 * Report model and verdict assembly (RPT-001; FR-034, FR-049; data model §PR verdict rules).
 *
 * Each plan test case gets one outcome from the results that name it: any `failed` → failed; otherwise the most
 * indeterminate of `timed_out`, `infra_error`, `cancelled`, `blocked`, `not_run`; otherwise `passed` (flaky when
 * any pass needed a retry); `skipped` only when nothing else ran. A case with no result is `not_run`: a test that
 * never executed is never listed as passed. The verdict comes from `computeVerdict` (CORE-005).
 */
import {
  computeVerdict,
  isMandatory,
  type CoverageDecision,
  type FailureAnalysis,
  type Limitation,
  type PrVerdict,
  type RequirementSet,
  type RunState,
  type TestOutcome,
  type TestPlan,
  type TestResult,
} from '@autotest/core';

export interface ReportRun {
  readonly id: string;
  readonly state: RunState;
  readonly partial: boolean;
  readonly limitations: readonly Limitation[];
}

export interface ReportInput {
  readonly plan: TestPlan;
  readonly requirements: RequirementSet;
  readonly coverage: CoverageDecision;
  /** A usable approval existed for a `needs_review` decision (the runs were authorized with it). */
  readonly needsReviewApproved: boolean;
  readonly runs: readonly ReportRun[];
  readonly results: readonly TestResult[];
  readonly analyses: readonly FailureAnalysis[];
  readonly narrative?: string;
  /** Limitations from outside the runs (for example a broken audit chain, OPS-007). */
  readonly extraLimitations?: readonly Limitation[];
}

export interface CaseRow {
  readonly testCaseId: string;
  readonly title: string;
  readonly requirementRefs: readonly string[];
  readonly priority: string;
  readonly riskTier: string;
  readonly mandatory: boolean;
  readonly automation: string;
  readonly eligibility: string;
  readonly outcome: TestOutcome;
  readonly flaky: boolean;
  readonly resultIds: readonly string[];
  readonly analysis?: {
    readonly resultId: string;
    readonly class: string;
    readonly subtype: string;
    readonly strength: string;
    readonly confidence: number;
    readonly inference: string;
  };
}

export interface ReportModel {
  readonly verdict: PrVerdict;
  readonly verdictRule: 1 | 2 | 3 | 4 | 5;
  readonly summary: {
    readonly planId: string;
    readonly planVersion: number;
    readonly planHash: string;
    readonly coverageDecisionId: string;
    readonly gateDecision: string;
    readonly runs: readonly { readonly id: string; readonly state: RunState; readonly partial: boolean }[];
  };
  readonly cases: readonly CaseRow[];
  readonly traceability: readonly {
    readonly requirementId: string;
    readonly title: string;
    readonly riskTier: string;
    readonly cases: readonly { readonly testCaseId: string; readonly outcome: TestOutcome }[];
  }[];
  readonly plannedVsExecuted: {
    readonly planned: number;
    readonly executed: number;
    readonly notRun: number;
    readonly blocked: number;
  };
  readonly failures: readonly {
    readonly testCaseIds: readonly string[];
    readonly resultId: string;
    readonly name: string;
    readonly outcome: TestOutcome;
    readonly messageExcerpt?: string;
    readonly analysis?: CaseRow['analysis'];
  }[];
  readonly attention: readonly string[];
  readonly limitations: readonly Limitation[];
  readonly metrics: CoverageDecision['metrics'];
  readonly narrative?: string;
}

const INDETERMINATE_ORDER: readonly TestOutcome[] = ['timed_out', 'infra_error', 'cancelled', 'blocked', 'not_run'];

/** The single outcome of a case from the results that name it (see module comment). */
export function caseOutcome(results: readonly TestResult[]): { outcome: TestOutcome; flaky: boolean } {
  if (results.length === 0) return { outcome: 'not_run', flaky: false };
  if (results.some((r) => r.outcome === 'failed')) return { outcome: 'failed', flaky: false };
  const worst = INDETERMINATE_ORDER.find((o) => results.some((r) => r.outcome === o));
  if (worst) return { outcome: worst, flaky: false };
  if (results.some((r) => r.outcome === 'passed'))
    return { outcome: 'passed', flaky: results.some((r) => r.outcome === 'passed' && r.flaky) };
  return { outcome: 'skipped', flaky: false };
}

const EXECUTED: readonly TestOutcome[] = ['passed', 'failed'];

export function buildReportModel(i: ReportInput): ReportModel {
  const analysisByResult = new Map(i.analyses.map((a) => [a.resultId, a]));
  const resultsByCase = new Map<string, TestResult[]>();
  for (const r of i.results)
    for (const tc of r.testCaseIds) resultsByCase.set(tc, [...(resultsByCase.get(tc) ?? []), r]);

  const cases: CaseRow[] = i.plan.testCases.map((tc) => {
    const rs = resultsByCase.get(tc.id) ?? [];
    const { outcome, flaky } = caseOutcome(rs);
    const failing =
      rs.find((r) => r.outcome === outcome && analysisByResult.has(r.id)) ?? rs.find((r) => analysisByResult.has(r.id));
    const a = failing ? analysisByResult.get(failing.id) : undefined;
    return {
      testCaseId: tc.id,
      title: tc.title,
      requirementRefs: tc.requirementRefs,
      priority: tc.priority,
      riskTier: tc.riskTier,
      mandatory: isMandatory(tc),
      automation: tc.automation,
      eligibility: tc.eligibility,
      outcome,
      flaky,
      resultIds: rs.map((r) => r.id),
      ...(a
        ? {
            analysis: {
              resultId: a.resultId,
              class: a.class,
              subtype: a.subtype,
              strength: a.strength,
              confidence: a.confidence,
              inference: a.inference,
            },
          }
        : {}),
    };
  });

  const verdict = computeVerdict({
    gateDecision: i.coverage.decision,
    needsReviewApproved: i.needsReviewApproved,
    authorizedRunExists: i.runs.length > 0,
    runStates: i.runs.map((r) => r.state),
    cases: cases.map((c) => ({
      testCaseId: c.testCaseId,
      priority: c.priority as 'must' | 'should' | 'could',
      riskTier: c.riskTier as 'R0' | 'R1' | 'R2' | 'R3',
      outcome: c.outcome,
      flaky: c.flaky,
      ...(c.analysis ? { failureClass: c.analysis.class as FailureAnalysis['class'] } : {}),
    })),
  });

  const limitations: Limitation[] = [
    ...i.runs.flatMap((r) => r.limitations),
    ...i.runs
      .filter((r) => r.partial)
      .map((r) => ({ code: 'run_partial', message: `run ${r.id} ended ${r.state} with partial results` })),
    ...cases
      .filter((c) => c.eligibility !== 'eligible')
      .map((c) => ({
        code: 'case_not_executable',
        message: `${c.testCaseId} is ${c.automation} (${c.eligibility}); it was not run`,
      })),
    ...(i.runs.length === 0
      ? [{ code: 'no_runs', message: 'no run of this plan hash is included in the report' }]
      : []),
    ...(i.extraLimitations ?? []),
  ];

  return {
    verdict: verdict.verdict,
    verdictRule: verdict.rule,
    summary: {
      planId: i.plan.id,
      planVersion: i.plan.version,
      planHash: i.plan.planHash,
      coverageDecisionId: i.coverage.id,
      gateDecision: i.coverage.decision,
      runs: i.runs.map((r) => ({ id: r.id, state: r.state, partial: r.partial })),
    },
    cases,
    traceability: i.requirements.requirements.map((req) => ({
      requirementId: req.id,
      title: req.title,
      riskTier: req.riskTier,
      cases: cases
        .filter((c) => c.requirementRefs.includes(req.id))
        .map((c) => ({ testCaseId: c.testCaseId, outcome: c.outcome })),
    })),
    plannedVsExecuted: {
      planned: cases.length,
      executed: cases.filter((c) => EXECUTED.includes(c.outcome)).length,
      notRun: cases.filter((c) => c.outcome === 'not_run').length,
      blocked: cases.filter((c) => c.outcome === 'blocked').length,
    },
    failures: i.results
      .filter((r) => r.outcome !== 'passed' && r.outcome !== 'skipped' && r.outcome !== 'not_run')
      .slice(0, 200)
      .map((r) => {
        const a = analysisByResult.get(r.id);
        return {
          testCaseIds: r.testCaseIds,
          resultId: r.id,
          name: r.name,
          outcome: r.outcome,
          ...(r.messageExcerpt ? { messageExcerpt: r.messageExcerpt } : {}),
          ...(a
            ? {
                analysis: {
                  resultId: a.resultId,
                  class: a.class,
                  subtype: a.subtype,
                  strength: a.strength,
                  confidence: a.confidence,
                  inference: a.inference,
                },
              }
            : {}),
        };
      }),
    attention: verdict.attention,
    limitations,
    metrics: i.coverage.metrics,
    ...(i.narrative ? { narrative: i.narrative } : {}),
  };
}
