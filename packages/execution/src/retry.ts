/**
 * Bounded retry selection (RUN-005; FR-028; ADR-0007 §9). After an attempt, only targets with a retryable result
 * run again, up to `maxAttempts`:
 * - `flaky`: a test failure (assertion, exception or crash) may be flaky, so its target is re-run once more;
 * - `infrastructure`: `infra_error` (runner stopped, no result) is an environment failure and is re-run.
 * Load errors, blocked, skipped, cancelled and timed-out results are deterministic or deliberate and never retried.
 * A pass on a later attempt after a failure is labelled `flaky` when attempts are merged (`mergeAttempts`).
 */
import type { NormalizedResult } from '@autotest/adapter-sdk';
import type { TestTarget } from '@autotest/core';

export type RetryClass = 'flaky' | 'infrastructure';
export const DEFAULT_RETRY_ON: readonly RetryClass[] = ['flaky', 'infrastructure'];

/** The retry class a result qualifies for, if any. */
export function retryClassOf(r: NormalizedResult): RetryClass | undefined {
  if (r.outcome === 'failed' && r.failureKind !== 'load_error') return 'flaky';
  if (r.outcome === 'infra_error') return 'infrastructure';
  return undefined;
}

/** Targets (in their original order) that have at least one result retryable under `retryOn`. */
export function selectRetryTargets(
  results: readonly NormalizedResult[],
  targets: readonly TestTarget[],
  retryOn: readonly RetryClass[],
): TestTarget[] {
  const retry = new Set<string>();
  for (const r of results) {
    const c = retryClassOf(r);
    if (c && retryOn.includes(c)) retry.add(r.targetId);
  }
  return targets.filter((t) => retry.has(t.id));
}
