/**
 * TL-16 use case (ANL-003): classify a terminal run's failures with ruleset anl-1 and persist the analyses, keyed by
 * run, result and ruleset version (a new ruleset re-analyzes; earlier analyses stay). Inputs per result: its
 * attempts, the redacted message and stderr excerpt, the adapter's failure signals, traceability to the PR's
 * requirements and whether the test file changed in the PR. Baselines and the known-failure registry arrive with
 * ANL-002; until then the baseline is `unknown`, so `product_defect` stays a hypothesis.
 */
import type { NormalizedResult } from '@autotest/adapter-sdk';
import { classify, needsAnalysis, RULESET_VERSION } from '@autotest/analysis';
import { derivedId, type FailureAnalysis, type Run, type TestResult } from '@autotest/core';
import { readExcerpt } from '@autotest/evidence';
import { runPaths } from '@autotest/execution';
import { readAttemptResults, type RunDeps } from './run.ts';

export async function analyzeRun(deps: RunDeps, run: Run): Promise<FailureAnalysis[]> {
  const { ports } = deps;
  const existing = await ports.analyses.listByRun(run.id, RULESET_VERSION);
  const results = (await ports.results.list(run.id, { offset: 0, limit: 100_000 })).items.filter(needsAnalysis);
  const done = new Set(existing.map((a) => a.resultId));
  const todo = results.filter((r) => !done.has(r.id));
  if (todo.length === 0) return existing;

  const plan = await ports.plans.getByHash(run.planHash);
  const set = plan && (await ports.requirements.get(plan.requirementSetId));
  const pr = set && (await ports.prContexts.get(set.prContextId));
  const changed = new Set((pr?.changedFiles ?? []).map((f) => f.path));
  const inventory = plan && (await ports.inventories.get(plan.inventoryId));
  const pathOf = new Map((inventory?.targets ?? []).map((t) => [t.id, t.path]));
  const attempts = readAttemptResults(deps.dataRoot, run.id);
  const artifacts = await ports.artifacts.list(run.id);
  const runDir = runPaths(deps.dataRoot, run.id).dir;
  const adapterId = inventory?.targets.find((t) => t.id === run.targets[0])?.adapterId;
  const adapter = adapterId ? deps.registry.get(adapterId) : undefined;

  const analyses: FailureAnalysis[] = todo.map((r) => {
    const own = artifacts.filter((a) => a.attemptNo === r.attemptNo);
    const stderr = own.find((a) => a.kind === 'stderr' && !a.quarantined);
    const normalized: NormalizedResult = {
      targetId: r.targetId,
      name: r.name,
      outcome: r.outcome,
      rawStatus: r.rawStatus,
      ...(r.failureKind ? { failureKind: r.failureKind } : {}),
      ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
      ...(r.messageExcerpt ? { messageExcerpt: r.messageExcerpt } : {}),
    };
    const signals = adapter
      ? adapter.failureSignals([normalized], {
          attemptNo: r.attemptNo,
          targets: [],
          files: {},
          processes: [],
          interrupted: false,
        })
      : [];
    const cases = (plan?.testCases ?? []).filter((c) => r.testCaseIds.includes(c.id));
    const c = classify({
      outcome: r.outcome,
      ...(r.failureKind ? { failureKind: r.failureKind } : {}),
      ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
      flaky: r.flaky,
      attempts: attemptOutcomes(attempts, r),
      text: [r.messageExcerpt ?? '', (stderr && readExcerpt(runDir, stderr, 4096)) ?? ''].join('\n'),
      signals: signals.map((s) => ({ signal: s.signal })),
      mappedToRequirement: cases.some((x) => x.acRefs.length > 0),
      testFileChanged: changed.has(pathOf.get(r.targetId) ?? '\0'),
      baseline: 'unknown',
      artifactsQuarantined: own.some((a) => a.quarantined),
      artifactIds: [...r.artifactRefs],
    });
    return { id: derivedId('fa', `${run.id}#${r.id}#${RULESET_VERSION}`), runId: run.id, resultId: r.id, ...c };
  });
  await ports.analyses.putMany(analyses, RULESET_VERSION);
  return ports.analyses.listByRun(run.id, RULESET_VERSION);
}

function attemptOutcomes(attempts: ReturnType<typeof readAttemptResults>, r: TestResult) {
  return attempts.flatMap((a) => {
    const hit = a.results.find((x) => x.targetId === r.targetId && x.name === r.name);
    return hit ? [hit.outcome] : [];
  });
}
