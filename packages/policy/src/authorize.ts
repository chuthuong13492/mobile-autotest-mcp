/**
 * Execution authorization evaluator (AUTH-003; FR-022, SR-008; ADR-0006 §4; architecture §6; T-18).
 *
 * `authorizeExecution` is pure and total: every input is explicit, nothing is read from disk or the network, and
 * any missing or unknown input denies. `execution` calls it when a run is created and again at dispatch (RUN-002);
 * `exec` independently re-validates every spawn (ADR-0014). A coverage `pass` is necessary but never sufficient.
 *
 * Checks (all evaluated, so the decision lists every reason):
 * 1. the plan exists, its stored hash equals the recomputed hash, and both equal the requested hash; it is the
 *    latest version of the plan;
 * 2. a coverage decision exists and is current (plan hash, requirement-set hash, gate policy version);
 * 3. `pass`, or `needs_review` with a usable approval at the required assurance; `fail` always denies;
 * 4. policy is loaded; the workspace is allowlisted, executable (not a read-only reference) and matches the plan's
 *    repository; the targets are eligible plan targets; devices and the environment are allowlisted;
 * 5. every target's adapter-resolved command passed the executable/argument policy (dry run);
 * 6. prerequisites are satisfied;
 * 7. nothing cancels or supersedes the request.
 */
import {
  computePlanHash,
  digest,
  ExecutionAuthorizationDecision,
  type Approval,
  type AuthorizationReason,
  type CoverageDecision,
  type TestPlan,
} from '@autotest/contracts';
import { NO_AL3, planExecutionScope, selectApproval, type Al3Verifier } from './approvals.ts';
import type { LoadedPolicy } from './config.ts';
import type { ResolvedWorkspace } from './paths.ts';
import type { PolicyEnvironment } from './tiers.ts';

export interface ExecutionRequest {
  readonly planId: string;
  readonly planHash: string;
  /** Test case ids (`TC-NNN`) and/or TestTarget ids (`TT-…`) selected for the run; must not be empty. */
  readonly targets: readonly string[];
  readonly deviceIds: readonly string[];
  /** e.g. `local:<hostId>`; must equal the server's own environment. */
  readonly environment: string;
}

export interface DeviceAllowance {
  readonly deviceId: string;
  /** Allowlisted and currently usable by this server (leased or owned). */
  readonly allowed: boolean;
}

export interface AuthorizationInputs {
  /** Minted by the caller (`authz_<ULID>`), so the evaluator stays pure. */
  readonly decisionId: string;
  readonly phase: 'create' | 'dispatch';
  readonly runId?: string;
  readonly now: Date;
  readonly request: ExecutionRequest;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment } | undefined;
  readonly policy: LoadedPolicy | undefined;
  /** The stored plan snapshot for `request.planId` at the requested version (loaded by the caller). */
  readonly plan: TestPlan | undefined;
  /** Highest stored version of the plan id. */
  readonly latestPlanVersion: number | undefined;
  /** Hash of the newest requirement set for the PR; a newer one makes the decision stale. */
  readonly currentRequirementSetHash: string | undefined;
  readonly coverage: CoverageDecision | undefined;
  /** Candidate approvals for the plan-execution scope (any state; verification filters them). */
  readonly approvals: readonly Approval[];
  readonly al3?: Al3Verifier;
  /** The workspace resolved by the caller through policy (`findWorkspace`); undefined when not allowlisted. */
  readonly workspace: ResolvedWorkspace | undefined;
  readonly devices: readonly DeviceAllowance[];
  /** Dry-run `validateSpec` outcome per TestTarget id. */
  readonly commands: readonly { readonly targetId: string; readonly ok: boolean }[] | undefined;
  readonly prerequisites: { readonly satisfied: boolean } | undefined;
  /** Required at dispatch: whether cancellation was requested for the run. */
  readonly cancellation?: { readonly requested: boolean };
}

export interface AuthorizationOutcome {
  readonly decision: ExecutionAuthorizationDecision;
  /** The approval that satisfied check 3 (to be consumed at run creation), if one was needed. */
  readonly approvalId?: string;
  /** TestTarget ids the request resolves to. */
  readonly resolvedTargets: readonly string[];
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Evaluates ADR-0006 §4. Never throws for bad input: malformed or missing input yields `denied`. */
export function authorizeExecution(input: AuthorizationInputs): AuthorizationOutcome {
  const reasons = new Set<AuthorizationReason>();
  let approvalId: string | undefined;
  let resolvedTargets: string[] = [];
  let recomputed: string | undefined;

  try {
    const { request, plan, policy, coverage } = input;

    // 1. Plan integrity and currency.
    if (!plan) reasons.add('unknown_state');
    else {
      recomputed = safeHash(plan);
      if (
        plan.id !== request.planId ||
        recomputed === undefined ||
        plan.planHash !== recomputed ||
        request.planHash !== recomputed
      )
        reasons.add('plan_hash_mismatch');
      const latest = input.latestPlanVersion;
      if (!Number.isInteger(latest) || (latest as number) < plan.version) reasons.add('unknown_state');
      else if ((latest as number) > plan.version) reasons.add('superseded');
    }

    // 4a. Policy and environment.
    if (!policy) reasons.add('policy_unavailable');
    const env = input.serverEnvironment;
    if (!env || (env.kind !== 'local' && env.kind !== 'ci')) reasons.add('unknown_state');
    else if (request.environment !== env.id || !request.environment.startsWith(`${env.kind}:`))
      reasons.add('environment_not_allowed');

    // 2–3. Coverage decision and approval.
    if (!coverage) reasons.add('coverage_missing');
    else if (plan && policy) {
      const stale =
        coverage.planHash !== request.planHash ||
        coverage.planId !== plan.id ||
        coverage.requirementSetHash !== plan.requirementSetHash ||
        coverage.gatePolicyVersion !== policy.gatePolicyVersion ||
        input.currentRequirementSetHash === undefined ||
        input.currentRequirementSetHash !== plan.requirementSetHash;
      if (stale) reasons.add('coverage_stale');
      if (coverage.decision === 'fail') reasons.add('coverage_failed');
      else if (coverage.decision !== 'pass' && coverage.decision !== 'needs_review') reasons.add('unknown_state');
    }

    // 4b. Workspace, targets, devices.
    const ws = input.workspace;
    if (!ws || typeof ws.id !== 'string' || typeof ws.realPath !== 'string' || ws.readOnlyReference !== false)
      reasons.add('workspace_not_allowed');
    else if (plan && !repositoryMatches(plan, ws)) reasons.add('workspace_not_allowed');
    if (plan) {
      const resolved = resolvePlanTargets(plan, request.targets);
      if (!resolved) reasons.add('target_not_eligible');
      else resolvedTargets = resolved;
    }
    if (!Array.isArray(input.devices) || !Array.isArray(request.deviceIds)) reasons.add('unknown_state');
    for (const id of request.deviceIds) {
      if (!input.devices.some((d) => d.deviceId === id && d.allowed === true)) reasons.add('device_not_allowed');
    }

    if (coverage?.decision === 'needs_review' && plan && policy && env) {
      const expected = planExecutionScope({
        planHash: request.planHash,
        environment: request.environment,
        targetIds: resolvedTargets,
      });
      const sel = selectApproval(
        input.approvals,
        {
          scope: expected,
          planHash: request.planHash,
          environment: request.environment,
          policyVersion: policy.policyVersion,
        },
        {
          now: input.now,
          environmentKind: env.kind,
          overrides: policy.config.approvals.minAssurance,
          al3: input.al3 ?? NO_AL3,
        },
      );
      if (sel.approval) approvalId = sel.approval.id;
      else for (const r of sel.reasons) reasons.add(r);
    }

    // 5. Dry-run command policy for every resolved target.
    if (!Array.isArray(input.commands)) reasons.add('command_denied');
    else {
      for (const t of resolvedTargets) {
        const c = input.commands.find((x) => x.targetId === t);
        if (c?.ok !== true) reasons.add('command_denied');
      }
    }

    // 6–7. Prerequisites, cancellation.
    if (input.prerequisites?.satisfied !== true) reasons.add('prerequisite_missing');
    const cancel = input.cancellation?.requested;
    if (cancel === true) reasons.add('cancelled');
    else if (cancel !== false && (input.phase === 'dispatch' || input.cancellation !== undefined))
      reasons.add('unknown_state');
    if (input.phase !== 'create' && input.phase !== 'dispatch') reasons.add('unknown_state');
  } catch {
    // A malformed input object must never become an authorization.
    reasons.add('unknown_state');
  }

  const ordered = [...reasons].sort();
  const decision = ExecutionAuthorizationDecision.parse({
    id: input.decisionId,
    schemaVersion: 1,
    ...(input.runId ? { runId: input.runId } : {}),
    phase: input.phase,
    result: ordered.length === 0 ? 'authorized' : 'denied',
    reasons: ordered,
    inputsDigest: inputsDigest(input, recomputed, resolvedTargets),
    evaluatedAt: iso(input.now),
  });
  return { decision, resolvedTargets, ...(approvalId && decision.result === 'authorized' ? { approvalId } : {}) };
}

function safeHash(plan: TestPlan): string | undefined {
  try {
    return computePlanHash(plan);
  } catch {
    return undefined;
  }
}

function repositoryMatches(plan: TestPlan, ws: ResolvedWorkspace): boolean {
  if (!ws.github)
    return (
      plan.repository.localPath === undefined ||
      plan.repository.localPath === ws.realPath ||
      plan.repository.localPath === ws.configuredPath
    );
  const r = plan.repository;
  return (
    r.host === ws.github.host &&
    (r.owner ?? null) === (ws.github.owner ?? null) &&
    (r.name ?? null) === (ws.github.name ?? null)
  );
}

/** All eligible TestTarget ids of a plan, sorted: the default selection when a request names no targets. */
export function defaultPlanTargets(plan: TestPlan): string[] {
  return [
    ...new Set(
      plan.testCases.filter((c) => c.eligibility === 'eligible' && c.targetRef !== null).map((c) => c.targetRef!),
    ),
  ].sort();
}

/**
 * Resolves the requested refs to TestTarget ids. A `TC-` ref must be an eligible case with a target; a `TT-` ref
 * must be the target of at least one eligible case. Returns undefined when any ref fails or nothing is selected.
 * Shared by `request_approval` and `run_tests`, so approval scopes and authorization agree on the target set.
 */
export function resolvePlanTargets(plan: TestPlan, refs: readonly string[]): string[] | undefined {
  if (refs.length === 0) return undefined;
  const eligible = plan.testCases.filter((c) => c.eligibility === 'eligible' && c.targetRef !== null);
  const out = new Set<string>();
  for (const ref of refs) {
    const tt = ref.startsWith('TC-')
      ? eligible.find((c) => c.id === ref)?.targetRef
      : eligible.some((c) => c.targetRef === ref)
        ? ref
        : undefined;
    if (!tt) return undefined;
    out.add(tt);
  }
  return [...out].sort();
}

/** Digest of exactly what the decision was based on (no secrets, no free text), for audit and replay checks. */
function inputsDigest(
  i: AuthorizationInputs,
  recomputedPlanHash: string | undefined,
  resolvedTargets: readonly string[],
): `sha256:${string}` {
  const safe = (f: () => unknown) => {
    try {
      return f() ?? null;
    } catch {
      return null;
    }
  };
  return digest({
    phase: i.phase,
    runId: i.runId ?? null,
    request: safe(() => ({
      ...i.request,
      targets: [...i.request.targets].sort(),
      deviceIds: [...i.request.deviceIds].sort(),
    })),
    serverEnvironment: safe(() => i.serverEnvironment),
    policyVersion: safe(() => i.policy?.policyVersion),
    gatePolicyVersion: safe(() => i.policy?.gatePolicyVersion),
    plan: safe(() => i.plan && { id: i.plan.id, version: i.plan.version, storedHash: i.plan.planHash }),
    recomputedPlanHash: recomputedPlanHash ?? null,
    latestPlanVersion: safe(() => i.latestPlanVersion),
    currentRequirementSetHash: safe(() => i.currentRequirementSetHash),
    coverage: safe(
      () =>
        i.coverage && {
          id: i.coverage.id,
          decision: i.coverage.decision,
          planHash: i.coverage.planHash,
          gatePolicyVersion: i.coverage.gatePolicyVersion,
        },
    ),
    approvals: safe(() =>
      i.approvals.map((a) => ({ id: a.id, state: a.state, uses: a.uses })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    ),
    workspace: safe(
      () =>
        i.workspace && {
          id: i.workspace.id,
          realPath: i.workspace.realPath,
          readOnlyReference: i.workspace.readOnlyReference,
        },
    ),
    resolvedTargets: [...resolvedTargets],
    devices: safe(() =>
      [...i.devices]
        .map((d) => ({ deviceId: d.deviceId, allowed: d.allowed }))
        .sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
    ),
    commands: safe(
      () =>
        i.commands &&
        [...i.commands]
          .map((c) => ({ targetId: c.targetId, ok: c.ok }))
          .sort((a, b) => (a.targetId < b.targetId ? -1 : 1)),
    ),
    prerequisites: safe(() => i.prerequisites),
    cancellation: safe(() => i.cancellation),
  });
}
