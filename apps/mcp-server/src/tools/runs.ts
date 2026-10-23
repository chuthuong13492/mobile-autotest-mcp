/**
 * TL-09 `run_tests`, TL-10 `get_run_status`, TL-11 `get_run_results`, TL-12 `cancel_test_run` (RUN-001 – RUN-004).
 *
 * The run manager lives in `@autotest/workflow` (`createRun`, `syncRun`, `cancelRun`); these handlers only shape
 * its results into the tool contracts. Status and results always import the supervisor's latest files first.
 * Results are paged from the run's final snapshot (imported once the run is terminal); while a run is still going,
 * `get_run_results` returns no rows and `snapshotFinal: false`.
 */
import { isTerminal, paginate, toolError, type TestOutcome, type TestResult } from '@autotest/core';
import { readRunFiles } from '@autotest/execution';
import { cancelRun, createRun, fail, ok, syncRun, type RunDeps, type UseCases } from '@autotest/workflow';

const RESULTS_FILTER_MAX = 100_000;

export function runUseCases(
  deps: RunDeps,
): Pick<UseCases, 'run_tests' | 'get_run_status' | 'get_run_results' | 'cancel_test_run'> {
  const notFound = (runId: string) =>
    fail(toolError('E_RUN_NOT_FOUND', `run ${runId} does not exist`, ['Use a runId returned by run_tests']));
  return {
    run_tests: (input, ctx) => createRun(deps, input, ctx),

    async get_run_status(input) {
      const run = await syncRun(deps, input.runId);
      if (!run) return notFound(input.runId);
      const files = readRunFiles(deps.dataRoot, run.id);
      const events = files.events.events;
      const summaries = events.flatMap((e) => (e.t === 'attempt.end' ? [e.summary] : []));
      const survivors = files.terminal?.survivors ?? [];
      const terminal = isTerminal(run.state);
      return ok({
        runId: run.id,
        state: run.state,
        statusCategory: run.statusCategory,
        cancelReason: run.cancelReason ?? null,
        infraReason: run.infraReason ?? null,
        progress: {
          attemptsStarted: events.filter((e) => e.t === 'attempt.start').length,
          attemptsFinished: summaries.length,
          testsByOutcome: terminal ? run.counts : (summaries.at(-1) ?? {}),
        },
        survivors: survivors.slice(0, 20).map((pid) => ({ pid, executable: 'runner' })),
        partial: run.partial,
        limitations: [...run.limitations],
        createdAt: run.createdAt,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        pollAfterMs: terminal ? null : 2000,
      });
    },

    async get_run_results(input) {
      const run = await syncRun(deps, input.runId);
      if (!run) return notFound(input.runId);
      const final = isTerminal(run.state);
      const f = input.filter ?? {};
      const all = final
        ? (
            await deps.ports.results.list(run.id, {
              offset: 0,
              limit: RESULTS_FILTER_MAX,
              ...(f.outcomes ? { outcomes: f.outcomes } : {}),
              ...(f.targetId ? { targetId: f.targetId } : {}),
            })
          ).items.filter((r) => !f.flakyOnly || r.flaky)
        : [];
      const page = paginate({
        codec: deps.ports.cursors,
        tool: 'get_run_results',
        cursor: input.cursor,
        limit: input.limit,
        filter: { runId: run.id, ...f },
        snapshotId: `${run.id}:${final ? 'final' : 'open'}`,
        items: all,
        capChars: 18_000,
        render: (rows: readonly TestResult[], meta) => ({ rows: [...rows], ...meta }),
      });
      if (!page.ok) return fail(page.error);
      return ok({
        runId: run.id,
        runState: run.state,
        snapshotFinal: final,
        totals: run.counts as Partial<Record<TestOutcome, number>>,
        results: page.value.rows.map((r) => ({
          resultId: r.id,
          targetId: r.targetId,
          testCaseIds: [...r.testCaseIds],
          name: r.name,
          outcome: r.outcome,
          failureKind: r.failureKind ?? null,
          blockedReason: r.blockedReason ?? null,
          flaky: r.flaky,
          attemptNo: r.attemptNo,
          durationMs: r.durationMs ?? null,
          messageExcerpt: r.messageExcerpt ?? null,
          artifactIds: [...r.artifactRefs],
        })),
        nextCursor: page.value.nextCursor,
        truncated: page.value.truncated,
        untrustedFields: ['/results/*/name', '/results/*/messageExcerpt'],
      });
    },

    cancel_test_run: (input) => cancelRun(deps, input.runId, input.reason),
  };
}
