/**
 * The six coverage metrics (COV-002; FR-048; test-planning §Coverage metrics). Each is `{numerator, denominator,
 * value}` with `value: null` when the denominator is 0 — never shown as 100%. They are deliberately separate:
 * none substitutes for another, and the pass rate is not a coverage metric.
 *
 *   1 requirementCoverage  testable requirements with ≥1 case / testable requirements (exceptions do not count)
 *   2 testCaseCoverage     ACs of testable requirements with ≥1 case / those ACs
 *   3 sourceCodeCoverage   covered / instrumentable changed lines (run data only)
 *   4 platformCoverage     (requirement, in-scope platform) pairs with an eligible case on that platform / pairs
 *                          (a requirement with no declared platforms counts as every in-scope platform)
 *   5 regressionCoverage   R2+ testable requirements with a regression case / R2+ testable requirements
 *   6 executionCoverage    mandatory cases whose final outcome is passed or failed / mandatory cases (run data only)
 */
import {
  isMandatory,
  type CoverageMetric,
  type CoverageMetrics,
  type RequirementSet,
  type TestPlan,
} from '@autotest/core';
import type { RunData } from './types.ts';

export function metric(numerator: number, denominator: number): CoverageMetric {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

const R2PLUS = new Set(['R2', 'R3']);

export function computeMetrics(plan: TestPlan, set: RequirementSet, run?: RunData): CoverageMetrics {
  const testable = set.requirements.filter((r) => r.testable);
  const casesOf = (reqId: string) => plan.testCases.filter((c) => c.requirementRefs.includes(reqId));

  const reqCovered = testable.filter((r) => casesOf(r.id).length > 0).length;
  const acs = testable.flatMap((r) => r.acceptanceCriteria.map((a) => a.id));
  const acCovered = acs.filter((a) => plan.testCases.some((c) => c.acRefs.includes(a))).length;

  let pairs = 0;
  let pairsCovered = 0;
  for (const r of testable) {
    const platforms = r.platforms.length
      ? r.platforms.filter((p) => plan.platformsInScope.includes(p))
      : plan.platformsInScope;
    for (const p of platforms) {
      pairs++;
      if (casesOf(r.id).some((c) => c.eligibility === 'eligible' && c.platforms.includes(p))) pairsCovered++;
    }
  }

  const high = testable.filter((r) => R2PLUS.has(r.riskTier));
  const regressionCovered = high.filter((r) => casesOf(r.id).some((c) => c.technique === 'regression')).length;

  let execution: CoverageMetric | null = null;
  if (run) {
    const mandatory = plan.testCases.filter(isMandatory);
    const executed = mandatory.filter((c) => {
      const o = run.outcomes.get(c.id);
      return o === 'passed' || o === 'failed';
    }).length;
    execution = metric(executed, mandatory.length);
  }

  return {
    requirementCoverage: metric(reqCovered, testable.length),
    testCaseCoverage: metric(acCovered, acs.length),
    sourceCodeCoverage: run?.sourceCoverage
      ? metric(run.sourceCoverage.covered, run.sourceCoverage.instrumentable)
      : null,
    platformCoverage: metric(pairsCovered, pairs),
    regressionCoverage: metric(regressionCovered, high.length),
    executionCoverage: execution,
  };
}
