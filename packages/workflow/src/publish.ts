/**
 * TL-18 `publish_github_report` (GH-005; ADR-0013; SR-009; T-06). Every write is P3:
 * - publication must be enabled in `config.yaml` (`github.publication.enabled` and the mechanism listed);
 * - the report must belong to a PR fetched from GitHub (owner, name, number and head SHA known);
 * - a usable `github_publish` approval must exist for exactly this scope: host, repo, PR, head SHA, report hash and
 *   the sorted mechanism set (one approval per publication; `autotest approve`, AL2 locally). It is consumed by the
 *   write. Approving `check_run` also covers its documented fallback, a commit status, used when the checks API is
 *   unavailable to the credential (a `gh` user token cannot create check runs).
 * `dryRun` returns what would be written without an approval and without any write.
 */
import {
  digest,
  PortError,
  toolError,
  type PRContext,
  type PRReport,
  type PublishMechanism,
  type ToolError,
  type ToolInput,
  type ToolOutput,
} from '@autotest/core';
import {
  publishCheckRun,
  publishCommitStatus,
  upsertComment,
  type GitHubClient,
  type PrTarget,
  type PublishResult,
} from '@autotest/github';
import {
  githubPublishScope,
  NO_AL3,
  selectApproval,
  type PolicyEnvironment,
  type PolicyLoadResult,
} from '@autotest/policy';
import { COMMENT_MAX_CHARS, renderMarkdown, type ReportModel } from '@autotest/reporting';
import type { WorkflowPorts } from './ports.ts';
import { fail, ok, type UseCaseResult } from './result.ts';

export interface PublishDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
  /** GitHub client for a host (throws a GitHubError when GitHub cannot be used). */
  readonly github?: (host: string) => GitHubClient;
}

export interface PublicationTarget {
  readonly report: PRReport;
  readonly context: PRContext;
  readonly pr: PrTarget & { readonly host: string };
  readonly mechanisms: readonly PublishMechanism[];
  readonly scope: ReturnType<typeof githubPublishScope>;
}

const ORDER: readonly PublishMechanism[] = ['comment', 'check_run', 'commit_status'];
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Resolves the report, its GitHub PR and the approval scope; shared by `request_approval` and the publish tool. */
export async function publicationTarget(
  ports: WorkflowPorts,
  reportId: string,
  mechanisms: readonly PublishMechanism[],
): Promise<{ ok: true; target: PublicationTarget } | { ok: false; error: ToolError }> {
  const report = await ports.reports.get(reportId);
  if (!report)
    return {
      ok: false,
      error: toolError('E_NOT_FOUND', `report ${reportId} does not exist`, ['Call generate_pr_test_report']),
    };
  const context = await ports.prContexts.get(report.prContextId);
  const r = context?.repository;
  const headSha = context?.head?.sha;
  if (!context || context.source !== 'github' || !r?.owner || !r.name || !context.number || !headSha)
    return {
      ok: false,
      error: toolError(
        'E_VALIDATION',
        'this report is not for a pull request fetched from GitHub',
        ['Use get_pr_context with source "github", then plan, run and report again'],
        { issues: [{ pointer: '/reportId', message: 'report of a manual PR context' }] },
      ),
    };
  const sorted = ORDER.filter((m) => mechanisms.includes(m));
  const pr = { host: r.host, owner: r.owner, name: r.name, number: context.number, headSha };
  const scope = githubPublishScope({
    host: pr.host,
    owner: pr.owner,
    name: pr.name,
    pr: pr.number,
    headSha,
    reportHash: report.reportHash,
    mechanism: sorted.join('+'),
  });
  return { ok: true, target: { report, context, pr, mechanisms: sorted, scope } };
}

/** The report model as stored in `PRReport.sections` (written by RPT-004). */
function modelOf(report: PRReport): ReportModel {
  return {
    ...(report.sections as unknown as Omit<ReportModel, 'verdict' | 'verdictRule' | 'limitations' | 'metrics'>),
    verdict: report.verdict,
    verdictRule: report.verdictRule as ReportModel['verdictRule'],
    limitations: report.limitations,
    metrics: report.metrics,
    ...(report.narrative ? { narrative: report.narrative } : {}),
  };
}

const CONCLUSION = { pass: 'success', fail: 'failure', inconclusive: 'neutral', blocked: 'action_required' } as const;
const STATE = { pass: 'success', fail: 'failure', inconclusive: 'error', blocked: 'error' } as const;

async function annotations(ports: WorkflowPorts, report: PRReport, model: ReportModel) {
  const plan = await ports.plans.getByHash(report.planHash);
  const inventory = plan && (await ports.inventories.get(plan.inventoryId));
  const pathOfCase = (tc: string) => {
    const ref = plan?.testCases.find((c) => c.id === tc)?.targetRef;
    return inventory?.targets.find((t) => t.id === ref)?.path;
  };
  return model.failures.flatMap((f) => {
    const p = f.testCaseIds.map(pathOfCase).find(Boolean);
    if (!p) return [];
    const why = f.analysis
      ? ` — ${f.analysis.strength === 'supported' ? 'likely' : 'possibly'} ${f.analysis.class}/${f.analysis.subtype}`
      : '';
    return [
      {
        path: p,
        title: `${f.name.slice(0, 200)}: ${f.outcome}`,
        message: `${f.outcome}${why}\n${(f.messageExcerpt ?? '').slice(0, 2000)}`,
      },
    ];
  });
}

export async function publishReport(
  deps: PublishDeps,
  input: ToolInput<'publish_github_report'>,
): Promise<UseCaseResult<ToolOutput<'publish_github_report'>>> {
  const { ports } = deps;
  if (!deps.policy.ok)
    return fail(toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', ['Run `autotest doctor`']));
  const pub = deps.policy.policy.config.github.publication;
  const notEnabled = input.mechanisms.filter((m) => !pub.enabled || !pub.mechanisms.includes(m));
  if (notEnabled.length)
    return fail(
      toolError('E_POLICY_DENIED', `publication is not enabled for: ${notEnabled.join(', ')}`, [
        'GitHub is read-only by default: set github.publication.enabled: true and list the mechanisms in ~/.autotest/config.yaml',
      ]),
    );
  const t = await publicationTarget(ports, input.reportId, input.mechanisms);
  if (!t.ok) return fail(t.error);
  const { report, pr, scope, mechanisms } = t.target;
  const model = modelOf(report);
  const verdict = report.verdict;
  const comment = renderMarkdown(model, { maxChars: COMMENT_MAX_CHARS - 200 });

  if (input.dryRun)
    return ok({
      reportId: report.id,
      scopeDigest: scope.digest as `sha256:${string}`,
      dryRun: true,
      results: mechanisms.map((mechanism) => ({
        mechanism,
        status: 'would_publish' as const,
        remoteId: null,
        url: null,
        errorCode: null,
      })),
    });

  if (!deps.github) return fail(toolError('E_CAPABILITY_UNAVAILABLE', 'GitHub access is not configured', []));
  const now = ports.clock.now();
  let candidates = await ports.approvals.listByScopeDigest(scope.digest);
  if (input.approvalId) candidates = candidates.filter((a) => a.id === input.approvalId);
  const sel = selectApproval(
    candidates,
    { scope, environment: deps.serverEnvironment.id, policyVersion: deps.policy.policy.policyVersion },
    {
      now,
      environmentKind: deps.serverEnvironment.kind,
      overrides: deps.policy.policy.config.approvals.minAssurance,
      al3: NO_AL3,
    },
  );
  if (!sel.approval)
    return fail(
      toolError(
        'E_APPROVAL_REQUIRED',
        'publishing needs a human approval for exactly this report, PR head and mechanisms',
        [
          `Call request_approval with scope {kind: "github_publish", publish: {reportId: "${report.id}", mechanisms: ${JSON.stringify(mechanisms)}}}, then a human runs autotest approve`,
        ],
        { scopeDigest: scope.digest, reasons: [...sel.reasons] },
      ),
    );
  try {
    const consumed = await ports.approvals.consume(sel.approval.id, now);
    await ports.audit.append({
      ts: iso(now),
      actor: 'server',
      kind: 'approval.consumed',
      subjectRefs: [consumed.id, report.id],
      data: { approvalId: consumed.id, uses: consumed.uses },
    });
  } catch (e) {
    if (e instanceof PortError && e.code === 'not_usable')
      return fail(toolError('E_APPROVAL_EXHAUSTED', 'the approval was already used', ['Request a new approval']));
    throw e;
  }

  const client = deps.github(pr.host);
  const results: { mechanism: PublishMechanism; r: PublishResult }[] = [];
  for (const mechanism of mechanisms) {
    if (mechanism === 'comment')
      results.push({ mechanism, r: await upsertComment(client, pr, report.planId, comment) });
    if (mechanism === 'check_run') {
      const r = await publishCheckRun(client, pr, {
        externalId: report.id,
        conclusion: CONCLUSION[verdict],
        title: `AutoTest: ${verdict.toUpperCase()} (rule ${report.verdictRule})`,
        summary: comment,
        annotations: await annotations(ports, report, model),
      });
      results.push({ mechanism, r });
      // The documented fallback for an unavailable checks API, covered by the check_run approval (ADR-0013).
      if (r.status === 'unavailable' && !mechanisms.includes('commit_status'))
        results.push({
          mechanism: 'commit_status',
          r: await publishCommitStatus(client, pr, {
            state: STATE[verdict],
            description: `AutoTest: ${verdict} (check runs unavailable)`,
          }),
        });
    }
    if (mechanism === 'commit_status')
      results.push({
        mechanism,
        r: await publishCommitStatus(client, pr, {
          state: STATE[verdict],
          description: `AutoTest: ${verdict}, rule ${report.verdictRule}`,
        }),
      });
  }

  const out: ToolOutput<'publish_github_report'>['results'] = [];
  for (const { mechanism, r } of results) {
    const status =
      r.status === 'created' ? 'published' : r.status === 'updated' || r.status === 'skipped' ? r.status : 'failed';
    out.push({ mechanism, status, remoteId: r.remoteId, url: r.url, errorCode: r.errorCode });
    await ports.publications.put({
      id: ports.ids.newId('pub'),
      reportId: report.id,
      mechanism,
      scopeDigest: scope.digest,
      remoteId: r.remoteId,
      status,
      createdAt: iso(ports.clock.now()),
    });
    if (status === 'published' || status === 'updated')
      await ports.audit.append({
        ts: iso(ports.clock.now()),
        actor: 'server',
        kind: 'github.write',
        subjectRefs: [report.id, `${pr.owner}/${pr.name}#${pr.number}`],
        data: { mechanism, remoteId: r.remoteId ?? 'none', status, scopeDigest: scope.digest },
      });
  }
  return ok({ reportId: report.id, scopeDigest: scope.digest as `sha256:${string}`, dryRun: false, results: out });
}

/** A stable digest of what a publication would write (for logs and tests; never the content itself). */
export const publicationDigest = (t: PublicationTarget) =>
  digest({ scope: t.scope.digest, reportHash: t.report.reportHash });
