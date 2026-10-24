/**
 * TL-16 use case (ANL-003): classify a terminal run's failures with ruleset anl-1 and persist the analyses, keyed by
 * run, result and ruleset version (a new ruleset re-analyzes; earlier analyses stay). Inputs per result: its
 * attempts, the redacted message and stderr excerpt, the adapter's failure signals, traceability to the PR's
 * requirements and whether the test file changed in the PR, the same test's outcome in the latest completed
 * baseline run of this plan version (ANL-002; `unknown` without one), and a matching unexpired entry of the
 * known-failure registry. When those inputs change (a baseline run finishes later, an entry is added or expires),
 * the run's analyses are recomputed and replaced.
 */
import type { NormalizedResult } from '@autotest/adapter-sdk';
import { classify, needsAnalysis, RULESET_VERSION } from '@autotest/analysis';
import {
  canonicalize,
  derivedId,
  type FailureAnalysis,
  type KnownFailure,
  type Run,
  type TestOutcome,
  type TestResult,
} from '@autotest/core';
import { readExcerpt } from '@autotest/evidence';
import { runPaths } from '@autotest/execution';
import { readAttemptResults, type RunDeps } from './run.ts';

export async function analyzeRun(deps: RunDeps, run: Run): Promise<FailureAnalysis[]> {
  const { ports } = deps;
  const existing = await ports.analyses.listByRun(run.id, RULESET_VERSION);
  const todo = (await ports.results.list(run.id, { offset: 0, limit: 100_000 })).items.filter(needsAnalysis);
  if (todo.length === 0) return existing;
  const baseline = await baselineOutcomes(deps, run);
  const now = ports.clock.now().getTime();
  const known = (await ports.knownFailures.list()).filter((k) => Date.parse(k.expiresAt) > now);

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
      baseline: baselineOf(baseline.get(`${r.targetId}\u0000${r.name}`)),
      ...knownFailureOf(known, r),
      artifactsQuarantined: own.some((a) => a.quarantined),
      artifactIds: [...r.artifactRefs],
    });
    return { id: derivedId('fa', `${run.id}#${r.id}#${RULESET_VERSION}`), runId: run.id, resultId: r.id, ...c };
  });
  const key = (xs: readonly FailureAnalysis[]) => canonicalize([...xs].sort((a, b) => a.id.localeCompare(b.id)));
  if (key(analyses) === key(existing)) return existing;
  if (existing.length === 0) await ports.analyses.putMany(analyses, RULESET_VERSION);
  else await ports.analyses.replaceForRun(run.id, RULESET_VERSION, analyses);
  return ports.analyses.listByRun(run.id, RULESET_VERSION);
}

/** Outcomes by `targetId NUL name` in the latest completed baseline run of the same plan version (none for a baseline). */
async function baselineOutcomes(deps: RunDeps, run: Run): Promise<Map<string, TestOutcome>> {
  if (run.baseline) return new Map();
  const runs = (await deps.ports.runs.listByPlanHash(run.planHash)).filter(
    (r) => r.baseline && r.state === 'completed' && r.id !== run.id,
  );
  const latest = runs.at(-1);
  if (!latest) return new Map();
  const results = await deps.ports.results.list(latest.id, { offset: 0, limit: 100_000 });
  return new Map(results.items.map((r) => [`${r.targetId}\u0000${r.name}`, r.outcome]));
}

const baselineOf = (o: TestOutcome | undefined): 'passed' | 'failed' | 'unknown' =>
  o === 'passed' ? 'passed' : o === 'failed' ? 'failed' : 'unknown';

/** `*` matches any run of characters; everything else is literal. */
function nameMatches(pattern: string, name: string): boolean {
  const re = pattern
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${re}$`, 's').test(name);
}

function knownFailureOf(known: readonly KnownFailure[], r: TestResult): { knownFailure?: { id: string } } {
  const hit = known.find((k) => k.targetId === r.targetId && nameMatches(k.namePattern, r.name));
  return hit ? { knownFailure: { id: hit.id } } : {};
}

function attemptOutcomes(attempts: ReturnType<typeof readAttemptResults>, r: TestResult) {
  return attempts.flatMap((a) => {
    const hit = a.results.find((x) => x.targetId === r.targetId && x.name === r.name);
    return hit ? [hit.outcome] : [];
  });
}
