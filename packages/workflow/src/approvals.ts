/**
 * Approval creation shared by the CLI (AL2) and the MCP elicitation path (AL1) — ADR-0006 §3.
 *
 * An approval copies its scope from the request, binds the plan hash, the server environment and the current
 * policy version, and gets the per-scope defaults: plan execution 24 h / 3 uses (the run plus retries of the same
 * plan and target set), device actions and publication 1 h / 1 use, coverage exceptions until the exception's own
 * expiry (at most 30 days) / 1 use. The request becomes `fulfilled`, and `approval.created` is audited.
 */
import { toolError, type Approval, type ApprovalRequest, type AssuranceLevel, type ToolError } from '@autotest/core';
import type { WorkflowPorts } from './ports.ts';

const HOUR = 3_600_000;
export const APPROVAL_DEFAULTS: Readonly<
  Record<ApprovalRequest['scope']['kind'], { readonly ttlMs: number; readonly maxUses: number }>
> = {
  plan_execution: { ttlMs: 24 * HOUR, maxUses: 3 },
  device_action: { ttlMs: HOUR, maxUses: 1 },
  github_publish: { ttlMs: HOUR, maxUses: 1 },
  coverage_exception: { ttlMs: 30 * 24 * HOUR, maxUses: 1 },
};

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface GrantInput {
  readonly request: ApprovalRequest;
  readonly source: 'elicitation' | 'cli';
  readonly assurance: AssuranceLevel;
  readonly approver: { readonly osUser: string };
  readonly environment: string;
  readonly policyVersion: string;
  readonly actor: 'agent' | 'cli';
}

/** Creates the approval for an open request. Returns a tool error when the request is not open or has expired. */
export async function grantApproval(
  ports: WorkflowPorts,
  g: GrantInput,
): Promise<{ ok: true; approval: Approval } | { ok: false; error: ToolError }> {
  const now = ports.clock.now();
  const req = g.request;
  if (req.status !== 'open' || now.getTime() >= Date.parse(req.expiresAt))
    return {
      ok: false,
      error: toolError('E_APPROVAL_EXPIRED', `request ${req.id} is ${req.status === 'open' ? 'expired' : req.status}`, [
        'Ask the agent to open a new request',
      ]),
    };
  const d = APPROVAL_DEFAULTS[req.scope.kind];
  const planHash =
    typeof req.scope.params['planHash'] === 'string' ? (req.scope.params['planHash'] as string) : undefined;
  // A coverage-exception approval never outlives the exception itself (ADR-0006 §3).
  let capByException = Number.POSITIVE_INFINITY;
  if (req.scope.kind === 'coverage_exception' && planHash) {
    const exception = (await ports.plans.getByHash(planHash))?.exceptions.find(
      (e) => e.id === req.scope.params['exceptionId'],
    );
    if (!exception)
      return { ok: false, error: toolError('E_NOT_FOUND', 'the exception this request names no longer exists', []) };
    capByException = Date.parse(exception.expiresAt);
  }
  const expiresAt = new Date(Math.min(now.getTime() + d.ttlMs, capByException));
  const approval = {
    id: ports.ids.newId('appr'),
    schemaVersion: 1,
    requestId: req.id,
    scope: req.scope,
    ...(planHash ? { planHash } : {}),
    environment: g.environment,
    policyVersion: g.policyVersion,
    source: g.source,
    assuranceLevel: g.assurance,
    approver: { osUser: g.approver.osUser.slice(0, 128) },
    createdAt: iso(now),
    expiresAt: iso(expiresAt),
    maxUses: d.maxUses,
    uses: 0,
    state: 'approved',
  } as Approval;
  await ports.approvals.putApproval(approval);
  await ports.approvals.putRequest({ ...req, status: 'fulfilled' });
  await ports.audit.append({
    ts: iso(now),
    actor: g.actor,
    kind: 'approval.created',
    subjectRefs: [approval.id, req.id],
    data: { approvalId: approval.id, source: g.source, assurance: g.assurance, scopeDigest: req.scope.digest },
  });
  return { ok: true, approval };
}
