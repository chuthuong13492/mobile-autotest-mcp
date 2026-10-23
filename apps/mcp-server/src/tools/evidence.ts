/**
 * TL-15 `collect_test_evidence`, TL-16 `analyze_test_failures`, TL-17 `generate_pr_test_report` (EVD-002, ANL-003,
 * RPT-004). Evidence is ingested by the supervisor while the run is collecting; these tools only read the index.
 * Excerpts come from the redacted copies, never from raw outputs; quarantined artifacts are metadata only.
 */
import { RULESET_VERSION } from '@autotest/analysis';
import { isTerminal, paginate, toolError, type EvidenceArtifact, type FailureAnalysis } from '@autotest/core';
import { readExcerpt } from '@autotest/evidence';
import { runPaths } from '@autotest/execution';
import {
  analyzeRun,
  artifactRef,
  fail,
  generateReport,
  ok,
  syncRun,
  type RunDeps,
  type UseCases,
} from '@autotest/workflow';

export function evidenceUseCases(
  deps: RunDeps,
): Pick<UseCases, 'collect_test_evidence' | 'analyze_test_failures' | 'generate_pr_test_report'> {
  const notFound = (runId: string) => fail(toolError('E_RUN_NOT_FOUND', `run ${runId} does not exist`, []));
  return {
    async collect_test_evidence(input) {
      const run = await syncRun(deps, input.runId);
      if (!run) return notFound(input.runId);
      let items = await deps.ports.artifacts.list(run.id);
      if (input.kinds) items = items.filter((a) => input.kinds!.includes(a.kind));
      if (input.artifactIds) {
        const wanted = new Set(input.artifactIds);
        items = items.filter((a) => wanted.has(a.id));
        const missing = input.artifactIds.find((id) => !items.some((a) => a.id === id));
        if (missing) return fail(toolError('E_NOT_FOUND', `artifact ${missing} is not part of run ${run.id}`, []));
        const q = items.find((a) => a.quarantined);
        if (q && input.include === 'excerpt')
          return fail(
            toolError(
              'E_ARTIFACT_QUARANTINED',
              `artifact ${q.id} is quarantined (${q.quarantineReason ?? 'unknown'})`,
              ['Quarantined content is never returned; inspect the run directory manually if needed'],
            ),
          );
      }
      const runDir = runPaths(deps.dataRoot, run.id).dir;
      const page = paginate({
        codec: deps.ports.cursors,
        tool: 'collect_test_evidence',
        cursor: input.cursor,
        limit: input.limit,
        filter: {
          runId: run.id,
          kinds: input.kinds ?? null,
          ids: input.artifactIds ?? null,
          include: input.include,
          bytes: input.excerptBytes,
        },
        snapshotId: `${run.id}:${items.length}`,
        items,
        capChars: 18_000,
        render: (rows: readonly EvidenceArtifact[], meta) => ({ rows: [...rows], ...meta }),
      });
      if (!page.ok) return fail(page.error);
      return ok({
        runId: run.id,
        partial: !isTerminal(run.state) || run.partial,
        artifacts: page.value.rows.map((a) => ({
          ...artifactRef(a),
          redactionApplied: a.redaction.applied,
          truncated: a.truncated,
          provenance: { producer: a.provenance.producer, toolVersion: a.provenance.toolVersion ?? null },
          excerpt: input.include === 'excerpt' ? (readExcerpt(runDir, a, input.excerptBytes) ?? null) : null,
        })),
        quarantinedCount: items.filter((a) => a.quarantined).length,
        nextCursor: page.value.nextCursor,
        untrustedFields: ['/artifacts/*/excerpt'],
      });
    },

    async analyze_test_failures(input) {
      const run = await syncRun(deps, input.runId);
      if (!run) return notFound(input.runId);
      if (!isTerminal(run.state))
        return fail(
          toolError('E_REPORT_NOT_READY', `run ${run.id} is still ${run.state}`, [
            'Poll get_run_status until it is terminal',
          ]),
        );
      let analyses = await analyzeRun(deps, run);
      if (input.resultIds) analyses = analyses.filter((a) => input.resultIds!.includes(a.resultId));
      const summary: Partial<Record<FailureAnalysis['class'], number>> = {};
      for (const a of analyses) summary[a.class] = (summary[a.class] ?? 0) + 1;
      const page = paginate({
        codec: deps.ports.cursors,
        tool: 'analyze_test_failures',
        cursor: input.cursor,
        limit: input.limit,
        filter: { runId: run.id, resultIds: input.resultIds ?? null },
        snapshotId: `${run.id}:${RULESET_VERSION}`,
        items: analyses,
        capChars: 18_000,
        render: (rows: readonly FailureAnalysis[], meta) => ({ rows: [...rows], ...meta }),
      });
      if (!page.ok) return fail(page.error);
      return ok({
        runId: run.id,
        rulesetVersion: RULESET_VERSION,
        summary,
        analyses: page.value.rows.map((a) => ({
          analysisId: a.id,
          resultId: a.resultId,
          class: a.class,
          subtype: a.subtype,
          strength: a.strength,
          confidence: a.confidence,
          observations: a.observations.map((o) => ({ text: o.text, artifactId: o.artifactRef ?? null })),
          inference: a.inference,
          alternatives: [...a.alternatives],
          nextSteps: [...a.nextSteps],
        })),
        nextCursor: page.value.nextCursor,
      });
    },

    generate_pr_test_report: (input) => generateReport(deps, input),
  };
}
