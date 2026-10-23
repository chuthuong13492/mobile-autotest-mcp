/**
 * PR verdict (CORE-005; data model §PR verdict rules; FR-049). Ordered rules, first match wins:
 *   1 blocked      no authorized run for the current plan hash (gate fail, unapproved needs_review, denied)
 *   2 blocked      every mandatory case is blocked or not_run
 *   3 fail         a mandatory case failed and its class is not environment_failure / pre_existing
 *   4 inconclusive a mandatory case is indeterminate/unexecuted, failed for environment/pre-existing reasons,
 *                  or a run ended in a terminal state other than completed
 *   5 pass         all mandatory cases passed, gate acceptable, runs completed
 * A mandatory case has priority `must` or covers an R2/R3 requirement. When a plan has no mandatory case,
 * every case is treated as mandatory, so a verdict is never decided by an empty set.
 */
import type {
  CoverageDecisionValue,
  FailureClass,
  Priority,
  PrVerdict,
  RiskTier,
  RunState,
  TestOutcome,
} from '@autotest/contracts';

export interface VerdictCase {
  readonly testCaseId: string;
  readonly priority: Priority;
  readonly riskTier: RiskTier;
  /** Final outcome after retries; `not_run` when never executed. */
  readonly outcome: TestOutcome;
  readonly flaky: boolean;
  /** Primary failure class when the case failed and was analyzed. */
  readonly failureClass?: FailureClass;
}

export interface VerdictInput {
  readonly gateDecision: CoverageDecisionValue;
  /** A usable approval at the required level existed for a needs_review decision. */
  readonly needsReviewApproved: boolean;
  /** At least one run for the current plan hash was authorized and created. */
  readonly authorizedRunExists: boolean;
  /** Terminal states of the runs included in the report. */
  readonly runStates: readonly RunState[];
  readonly cases: readonly VerdictCase[];
}

export interface VerdictResult {
  readonly verdict: PrVerdict;
  readonly rule: 1 | 2 | 3 | 4 | 5;
  /** Items the report must list under "Attention" (flaky mandatory passes, non-mandatory failures). */
  readonly attention: readonly string[];
}

const EXCUSED_FAILURE: readonly FailureClass[] = ['environment_failure', 'pre_existing'];
const UNEXECUTED: readonly TestOutcome[] = ['blocked', 'not_run'];
const INDETERMINATE: readonly TestOutcome[] = [
  'timed_out',
  'infra_error',
  'cancelled',
  'skipped',
  'blocked',
  'not_run',
];

export function isMandatory(c: Pick<VerdictCase, 'priority' | 'riskTier'>): boolean {
  return c.priority === 'must' || c.riskTier === 'R2' || c.riskTier === 'R3';
}

export function computeVerdict(input: VerdictInput): VerdictResult {
  const flagged = input.cases.filter(isMandatory);
  const mandatory = flagged.length > 0 ? flagged : input.cases;
  const mandatoryIds = new Set(mandatory.map((c) => c.testCaseId));
  const attention = [
    ...mandatory
      .filter((c) => c.flaky && c.outcome === 'passed')
      .map((c) => `${c.testCaseId}: passed only after retry (flaky)`),
    ...input.cases
      .filter((c) => !mandatoryIds.has(c.testCaseId) && c.outcome === 'failed')
      .map((c) => `${c.testCaseId}: non-mandatory failure`),
  ];

  const gateAcceptable =
    input.gateDecision === 'pass' || (input.gateDecision === 'needs_review' && input.needsReviewApproved);
  if (!input.authorizedRunExists || !gateAcceptable) return { verdict: 'blocked', rule: 1, attention };
  if (mandatory.length === 0 || mandatory.every((c) => UNEXECUTED.includes(c.outcome)))
    return { verdict: 'blocked', rule: 2, attention };
  if (
    mandatory.some(
      (c) => c.outcome === 'failed' && !(c.failureClass !== undefined && EXCUSED_FAILURE.includes(c.failureClass)),
    )
  )
    return { verdict: 'fail', rule: 3, attention };
  if (
    mandatory.some((c) => INDETERMINATE.includes(c.outcome) || c.outcome === 'failed') ||
    input.runStates.length === 0 ||
    input.runStates.some((s) => s !== 'completed')
  )
    return { verdict: 'inconclusive', rule: 4, attention };
  return { verdict: 'pass', rule: 5, attention };
}
