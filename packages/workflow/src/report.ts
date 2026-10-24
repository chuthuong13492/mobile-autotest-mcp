/**
 * TL-17 use case (RPT-004): the PR test report for one plan hash and its terminal runs.
 *
 * Runs must belong to the plan hash and be terminal (`E_REPORT_NOT_READY` otherwise); their failures are analyzed
 * first (ANL-003). The report record is content-addressed: the same plan, decision, runs, results, analyses and
 * narrative give the same `reportHash`, and generating again returns the stored report. Markdown, JSON and the
 * merged JUnit file are written under the first run's `reports/<reportId>/` and indexed as that run's artifacts
 * (artifact URIs are per run). With no runs, the report is `blocked` and has no artifact files.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { toJUnit } from '@autotest/adapter-sdk';
import {
  digest,
  isTerminal,
  toolError,
  type ArtifactRef,
  type EvidenceArtifact,
  type PRReport,
  type Run,
  type TestResult,
  type ToolInput,
  type ToolOutput,
} from '@autotest/core';
import { runPaths } from '@autotest/execution';
import { verifyAuditFiles } from '@autotest/storage';
import { buildReportModel, renderJson, renderMarkdown, type ReportModel } from '@autotest/reporting';
import { analyzeRun } from './analysis.ts';
import { fail, ok, type UseCaseResult } from './result.ts';
import { syncRun, type RunDeps } from './run.ts';

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const PREVIEW_CHARS = 12_000;

export function artifactRef(a: EvidenceArtifact): ArtifactRef {
  return {
    artifactId: a.id,
    kind: a.kind,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    mimeType: a.mimeType,
    quarantined: a.quarantined,
    uri: `autotest://runs/${a.runId}/artifacts/${a.id}`,
  };
}

function junitOf(model: ReportModel, results: readonly TestResult[]): string {
  const byTarget = new Map<string, TestResult[]>();
  for (const r of results) byTarget.set(r.targetId, [...(byTarget.get(r.targetId) ?? []), r]);
  return toJUnit({
    name: `${model.summary.planId} v${model.summary.planVersion}`,
    suites: [...byTarget.keys()].sort().map((targetId) => ({
      name: targetId,
      cases: byTarget.get(targetId)!.map((r) => ({
        classname: targetId,
        name: r.name,
        outcome: r.outcome,
        ...(r.failureKind ? { failureKind: r.failureKind } : {}),
        ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
        ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
        ...(r.messageExcerpt ? { messageExcerpt: r.messageExcerpt } : {}),
      })),
    })),
  });
}

export async function generateReport(
  deps: RunDeps,
  input: ToolInput<'generate_pr_test_report'>,
): Promise<UseCaseResult<ToolOutput<'generate_pr_test_report'>>> {
  const { ports } = deps;
  if (!deps.policy.ok)
    return fail(toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', ['Run `autotest doctor`']));
  const plan = await ports.plans.getByHash(input.planHash);
  if (!plan || plan.id !== input.planId)
    return fail(
      (await ports.plans.get(input.planId))
        ? toolError('E_PLAN_HASH_MISMATCH', 'no version of this plan has that planHash', [])
        : toolError('E_PLAN_NOT_FOUND', `plan ${input.planId} does not exist`, []),
    );
  const set = await ports.requirements.get(plan.requirementSetId);
  const coverage =
    set &&
    (await ports.decisions.findCurrent({
      planHash: plan.planHash,
      requirementSetHash: set.requirementSetHash,
      gatePolicyVersion: deps.policy.policy.gatePolicyVersion,
    }));
  if (!set || !coverage)
    return fail(
      toolError('E_COVERAGE_MISSING', 'no current coverage decision for this plan', ['Call validate_test_coverage']),
    );

  const runs: Run[] = [];
  for (const id of [...new Set(input.runIds)]) {
    const run = await syncRun(deps, id);
    if (!run) return fail(toolError('E_RUN_NOT_FOUND', `run ${id} does not exist`, []));
    if (run.planHash !== plan.planHash)
      return fail(
        toolError('E_VALIDATION', `run ${id} ran a different plan hash`, ['Report each plan version separately'], {
          issues: [{ pointer: '/runIds', message: 'run of another plan hash' }],
        }),
      );
    if (!isTerminal(run.state))
      return fail(
        toolError('E_REPORT_NOT_READY', `run ${id} is still ${run.state}`, [
          'Poll get_run_status until it is terminal',
        ]),
      );
    runs.push(run);
  }
  const results: TestResult[] = [];
  const analyses = [];
  for (const run of runs) {
    results.push(...(await ports.results.list(run.id, { offset: 0, limit: 100_000 })).items);
    analyses.push(...(await analyzeRun(deps, run)));
  }
  const model = buildReportModel({
    plan,
    requirements: set,
    coverage,
    needsReviewApproved: coverage.decision === 'needs_review' && runs.length > 0,
    runs: runs.map((r) => ({ id: r.id, state: r.state, partial: r.partial, limitations: r.limitations })),
    results,
    analyses,
    ...(input.narrative ? { narrative: input.narrative } : {}),
    extraLimitations: auditLimitation(deps.dataRoot),
  });

  const content = {
    prContextId: set.prContextId,
    planId: plan.id,
    planHash: plan.planHash,
    coverageDecisionId: coverage.id,
    runIds: runs.map((r) => r.id),
    verdict: model.verdict,
    verdictRule: model.verdictRule,
    metrics: coverage.metrics,
    sections: {
      summary: model.summary,
      cases: [...model.cases],
      traceability: model.traceability,
      plannedVsExecuted: model.plannedVsExecuted,
      failures: model.failures,
      attention: model.attention,
    },
    limitations: [...model.limitations],
    ...(input.narrative ? { narrative: input.narrative } : {}),
  };
  const reportHash = digest({ content, formats: [...input.formats].sort() });
  const now = ports.clock.now();
  const reportId = ports.ids.newId('rpt');
  const markdown = renderMarkdown(model);
  const first = runs[0];
  // Artifact ids are minted first so the stored record names its own files.
  const formats = first
    ? (
        [
          { format: 'markdown', kind: 'report', name: 'report.md', mime: 'text/markdown' },
          { format: 'json', kind: 'report', name: 'report.json', mime: 'application/json' },
          { format: 'junit', kind: 'junit', name: 'junit.xml', mime: 'application/xml' },
        ] as const
      )
        .filter((f) => input.formats.includes(f.format))
        .map((f) => ({ ...f, id: ports.ids.newId('art') }))
    : [];
  const stored = await ports.reports.put({
    id: reportId,
    schemaVersion: 1,
    createdAt: iso(now),
    ...content,
    artifacts: Object.fromEntries(formats.map((f) => [f.format, f.id])),
    reportHash,
  } as PRReport);

  const refs: ArtifactRef[] = [];
  if (stored.id === reportId && first) {
    // A new report: write and index its files. A repeat returns the stored report and its artifacts.
    const dir = path.join(runPaths(deps.dataRoot, first.id).dir, 'reports', reportId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of formats) {
      const text =
        f.format === 'markdown' ? markdown : f.format === 'json' ? renderJson(stored) : junitOf(model, results);
      const data = Buffer.from(text, 'utf8');
      fs.writeFileSync(path.join(dir, f.name), data, { mode: 0o600 });
      const a: EvidenceArtifact = {
        id: f.id,
        runId: first.id,
        kind: f.kind,
        relativePath: `reports/${reportId}/${f.name}`,
        mimeType: f.mime,
        sizeBytes: data.length,
        sha256: `sha256:${createHash('sha256').update(data).digest('hex')}`,
        redaction: { applied: false, rulesetVersion: 'redact-1', findingsCount: 0 },
        quarantined: false,
        provenance: { producer: 'autotest' },
        truncated: false,
      };
      await ports.artifacts.put(a);
      refs.push(artifactRef(a));
    }
    await ports.audit.append({
      ts: iso(now),
      actor: 'agent',
      kind: 'report.generated',
      subjectRefs: [reportId, plan.id, ...runs.map((r) => r.id)],
      data: { reportId, reportHash, verdict: model.verdict, verdictRule: model.verdictRule },
    });
  } else {
    for (const id of Object.values(stored.artifacts)) {
      const a = id ? await ports.artifacts.get(id) : undefined;
      if (a) refs.push(artifactRef(a));
    }
  }

  return ok({
    reportId: stored.id,
    verdict: stored.verdict,
    verdictRule: stored.verdictRule,
    reportHash: stored.reportHash as `sha256:${string}`,
    artifacts: refs.slice(0, 3),
    markdownPreview: renderMarkdown(model, { maxChars: PREVIEW_CHARS }),
    plannedVsExecuted: model.plannedVsExecuted,
    limitations: [...model.limitations],
  });
}

/** A broken audit chain does not change the verdict, but every later report says so (operations §4, OPS-007). */
function auditLimitation(dataRoot: string): { code: string; message: string }[] {
  const audit = verifyAuditFiles(dataRoot);
  return audit.ok
    ? []
    : [
        {
          code: 'audit_chain_broken',
          message: `the local audit log fails verification (${audit.problem} at ${audit.file}:${audit.line}); see \`autotest doctor --audit\``,
        },
      ];
}
