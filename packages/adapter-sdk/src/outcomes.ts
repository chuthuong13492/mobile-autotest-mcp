/**
 * Outcome normalization helpers (ADP-002; FR-030; data model §Per-test outcome). Adapters map runner states with an
 * explicit table; any state not in the table becomes `infra_error` with a diagnostic, never a guess. Attempts are
 * merged so a test that failed and later passed ends `passed` with `flaky: true`.
 */
import type { TestOutcome } from '@autotest/core';
import type { NormalizedResult, ParseDiagnostic } from './types.ts';

export interface OutcomeMapping {
  readonly outcome: TestOutcome;
  readonly failureKind?: NormalizedResult['failureKind'];
}

/** Maps a runner state through `table`; unknown states map to `infra_error` and add a diagnostic. */
export function mapRunnerState(
  raw: string,
  table: Readonly<Record<string, OutcomeMapping>>,
  diagnostics: ParseDiagnostic[],
): OutcomeMapping {
  const hit = Object.hasOwn(table, raw) ? table[raw] : undefined;
  if (hit) return hit;
  diagnostics.push({ code: 'unknown_runner_state', message: `unmapped runner state: ${raw.slice(0, 64)}` });
  return { outcome: 'infra_error' };
}

export interface MergedResult extends NormalizedResult {
  readonly flaky: boolean;
  /** The attempt whose outcome is final. */
  readonly attemptNo: number;
}

const key = (r: NormalizedResult) => `${r.targetId}\u0000${r.name}`;

/**
 * Merges attempts in order. The last attempt that ran a test decides its outcome; a test that `failed` on an
 * earlier attempt and `passed` later is `flaky`.
 */
export function mergeAttempts(attempts: readonly (readonly NormalizedResult[])[]): MergedResult[] {
  const merged = new Map<string, MergedResult>();
  attempts.forEach((results, i) => {
    for (const r of results) {
      const prev = merged.get(key(r));
      const failedBefore = prev ? prev.outcome === 'failed' || prev.flaky : false;
      const ran = r.outcome !== 'not_run';
      if (prev && !ran) continue;
      merged.set(key(r), { ...r, attemptNo: i + 1, flaky: r.outcome === 'passed' && failedBefore });
    }
  });
  return [...merged.values()];
}

/** Outcome counts for summaries (`Partial<Record<TestOutcome, number>>`). */
export function countOutcomes(
  results: readonly { readonly outcome: TestOutcome }[],
): Partial<Record<TestOutcome, number>> {
  const out: Partial<Record<TestOutcome, number>> = {};
  for (const r of results) out[r.outcome] = (out[r.outcome] ?? 0) + 1;
  return out;
}

/** Targets with no result become `not_run` (planned but not executed), so every planned target is accounted for. */
export function fillNotRun(targetIds: readonly string[], results: readonly NormalizedResult[]): NormalizedResult[] {
  const seen = new Set(results.map((r) => r.targetId));
  return [
    ...results,
    ...targetIds
      .filter((t) => !seen.has(t))
      .map((t) => ({ targetId: t, name: '(target)', outcome: 'not_run' as const, rawStatus: 'absent' })),
  ];
}

/** Clips runner text for `messageExcerpt` (contract cap 2,048 characters). */
export function excerpt(text: string | undefined, max = 2048): string | undefined {
  if (text === undefined) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
