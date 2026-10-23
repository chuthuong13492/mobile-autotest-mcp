/**
 * Requirement verification status (COV-002; test-planning §Requirement verification status). Rows are evaluated
 * top to bottom and the first match wins. After a run, the relevant cases are the requirement's mandatory cases, or
 * all of its cases when none is mandatory. An unexecuted or blocked test never contributes to `passing` (FR-039).
 */
import {
  isMandatory,
  type RequirementSet,
  type RequirementVerificationStatus,
  type TestOutcome,
  type TestPlan,
} from '@autotest/core';
import type { ExceptionCheck, RunData } from './types.ts';

const INDETERMINATE: ReadonlySet<TestOutcome> = new Set(['timed_out', 'infra_error', 'cancelled']);

export function requirementStatuses(
  plan: TestPlan,
  set: RequirementSet,
  exceptions: readonly ExceptionCheck[],
  run?: RunData,
): { requirementId: string; status: RequirementVerificationStatus }[] {
  return set.requirements.map((r) => {
    const valid = exceptions.filter((e) => e.valid && e.exception.requirementRefs.includes(r.id));
    const elsewhereNotRun = run
      ? valid.some(
          (e) => e.exception.reason === 'covered_elsewhere' && !run.executedTargets.has(e.evidenceTargetId ?? ''),
        )
      : false;
    const cases = plan.testCases.filter((c) => c.requirementRefs.includes(r.id));
    const status = ((): RequirementVerificationStatus => {
      if (valid.length > 0 && !elsewhereNotRun) return 'excepted';
      if (cases.length === 0) return elsewhereNotRun ? 'unverified' : 'unmapped';
      if (!cases.some((c) => c.eligibility === 'eligible')) return 'mapped';
      if (!run) return 'eligible';
      const flagged = cases.filter(isMandatory);
      const relevant = (flagged.length ? flagged : cases).map((c) => run.outcomes.get(c.id) ?? 'not_run');
      if (relevant.includes('failed')) return 'failing';
      if (relevant.some((o) => INDETERMINATE.has(o)) || elsewhereNotRun) return 'unverified';
      if (relevant.some((o) => o === 'blocked' || o === 'not_run')) return 'blocked';
      if (relevant.every((o) => o === 'passed')) return 'passing';
      return 'executed';
    })();
    return { requirementId: r.id, status };
  });
}
