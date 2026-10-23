/**
 * Evidence collection for a finished run (EVD-001), run by the supervisor in the `collecting` state.
 *
 * Candidates per attempt: the supervisor's `stdout-<i>.log`/`stderr-<i>.log` and the adapter's evidence hints
 * (runner JSON, coverage). A merged JUnit file of the run is written first (adapter SDK writer) and ingested like
 * any other output. Every artifact is validated, redacted and indexed; quarantines are audited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergeAttempts, toJUnit, type NormalizedResult } from '@autotest/adapter-sdk';
import { digest, type EvidenceArtifact, type ExecutionSpec } from '@autotest/core';
import { ingestArtifacts, type IngestCandidate } from '@autotest/evidence';
import { readJson, readRunnerOutputs, runPaths, type RunHeader } from '@autotest/execution';
import { createRedactor } from '@autotest/policy';
import type { RunDeps } from './run.ts';
import { readAttemptResults } from './run.ts';

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const MERGED_JUNIT = 'attempts/merged/junit.xml';

/** Writes the run's merged JUnit file from the attempt results (RPT-003's per-run JUnit). */
export function writeMergedJUnit(dataRoot: string, header: RunHeader): boolean {
  const attempts = readAttemptResults(dataRoot, header.runId);
  if (attempts.length === 0) return false;
  const merged = mergeAttempts(attempts.map((a) => a.results as NormalizedResult[]));
  const pathOf = new Map((header.execution?.targets ?? []).map((t) => [t.id, t.path]));
  const suites = [...new Set(merged.map((r) => r.targetId))].sort().map((targetId) => ({
    name: pathOf.get(targetId) ?? targetId,
    cases: merged
      .filter((r) => r.targetId === targetId)
      .map((r) => ({
        classname: pathOf.get(targetId) ?? targetId,
        name: r.name,
        outcome: r.outcome,
        ...(r.failureKind ? { failureKind: r.failureKind } : {}),
        ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.messageExcerpt ? { messageExcerpt: r.messageExcerpt } : {}),
      })),
  }));
  const file = path.join(runPaths(dataRoot, header.runId).dir, MERGED_JUNIT);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, toJUnit({ name: header.runId, suites }), { mode: 0o600 });
  return true;
}

/** Ingests and indexes every attempt's outputs. Throws only on storage failures (→ `infra_error(storage_error)`). */
export async function collectRunEvidence(deps: RunDeps, header: RunHeader): Promise<EvidenceArtifact[]> {
  const { ports } = deps;
  const runDir = runPaths(deps.dataRoot, header.runId).dir;
  const adapter = header.execution ? deps.registry.get(header.execution.adapterId) : undefined;
  const candidates: IngestCandidate[] = [];
  const attemptsDir = path.join(runDir, 'attempts');
  const numbers = (fs.existsSync(attemptsDir) ? fs.readdirSync(attemptsDir) : [])
    .filter((n) => /^\d{1,2}$/.test(n))
    .map(Number)
    .sort((a, b) => a - b);
  for (const attemptNo of numbers) {
    const specs =
      readJson(path.join(attemptsDir, String(attemptNo), 'spec.json'), {
        safeParse: (v: unknown) =>
          Array.isArray(v) ? { success: true as const, data: v as ExecutionSpec[] } : { success: false as const },
      }) ?? [];
    specs.forEach((spec, i) => {
      for (const kind of ['stdout', 'stderr'] as const)
        candidates.push({
          kind,
          rel: `attempts/${attemptNo}/${kind}-${i}.log`,
          mimeType: 'text/plain',
          required: false,
          attemptNo,
          producer: 'supervisor',
          specDigest: digest(spec),
        });
    });
    if (adapter && header.execution) {
      const targets = header.execution.targets;
      const hints = adapter.evidenceHints({
        attemptNo,
        targets,
        files: readRunnerOutputs(runDir, attemptNo),
        processes: [],
        interrupted: false,
      });
      for (const h of hints)
        candidates.push({
          kind: h.kind,
          rel: h.rel,
          mimeType: h.mimeType,
          required: h.required,
          attemptNo,
          producer: adapter.id,
          toolVersion: adapter.version,
        });
    }
  }
  if (writeMergedJUnit(deps.dataRoot, header))
    candidates.push({
      kind: 'junit',
      rel: MERGED_JUNIT,
      mimeType: 'application/xml',
      required: false,
      producer: 'autotest',
    });

  const { artifacts } = ingestArtifacts(candidates, {
    runDir,
    runId: header.runId,
    newId: () => ports.ids.newId('art'),
    redactor: createRedactor(),
  });
  for (const a of artifacts) {
    await ports.artifacts.put(a);
    await ports.audit.append({
      ts: iso(ports.clock.now()),
      actor: 'server',
      kind: a.quarantined ? 'artifact.quarantined' : 'artifact.ingested',
      subjectRefs: [a.id, header.runId],
      data: a.quarantined
        ? { artifactId: a.id, reason: a.quarantineReason ?? 'unknown' }
        : { artifactId: a.id, kind: a.kind, sha256: a.sha256 },
    });
  }
  return [...artifacts];
}
