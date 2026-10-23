/**
 * The independent coverage gate (COV-001 – COV-003; FR-017 – FR-020; ADR-0005).
 *
 *   any blocker → fail;  else any review finding → needs_review;  else pass
 *
 * `pass` means only that coverage criteria are met — it never authorizes execution (ADR-0006 §4). The gate reads
 * persisted entities only; `plan.display` is never consulted, so presentational text cannot influence a decision.
 */
import type {
  CoverageDecisionValue,
  CoverageMetrics,
  GateFinding,
  RequirementVerificationStatus,
} from '@autotest/core';
import { checkExceptions } from './exceptions.ts';
import { computeMetrics } from './metrics.ts';
import { blockerFindings } from './rules/blockers.ts';
import { reviewFindings } from './rules/review.ts';
import { requirementStatuses } from './status.ts';
import type { GateInput } from './types.ts';

export interface GateResult {
  readonly decision: CoverageDecisionValue;
  readonly findings: GateFinding[];
  readonly metrics: CoverageMetrics;
  readonly requirementStatus: { requirementId: string; status: RequirementVerificationStatus }[];
}

const SEVERITY_ORDER = { blocker: 0, review: 1, info: 2 } as const;

export function evaluateGate(input: GateInput): GateResult {
  const { plan, requirementSet: set } = input;
  const exceptions = checkExceptions(plan.exceptions, {
    requirementSet: set,
    targets: input.targets,
    approvedExceptions: input.approvedExceptions,
    now: input.now,
    exceptionMaxDays: input.config.exceptionMaxDays,
  });
  const excepted = (id: string) => exceptions.some((e) => e.valid && e.exception.requirementRefs.includes(id));
  const metrics = computeMetrics(plan, set, input.run);
  const findings = [
    ...blockerFindings(plan, set, exceptions),
    ...reviewFindings({
      plan,
      set,
      config: input.config,
      metrics,
      targets: input.targets,
      ...(input.changedFiles ? { changedFiles: input.changedFiles } : {}),
      excepted,
    }),
  ]
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] ||
        (a.f.ruleId < b.f.ruleId ? -1 : a.f.ruleId > b.f.ruleId ? 1 : a.i - b.i),
    )
    .map(({ f }) => f);
  const decision: CoverageDecisionValue = findings.some((f) => f.severity === 'blocker')
    ? 'fail'
    : findings.some((f) => f.severity === 'review')
      ? 'needs_review'
      : 'pass';
  return { decision, findings, metrics, requirementStatus: requirementStatuses(plan, set, exceptions, input.run) };
}
