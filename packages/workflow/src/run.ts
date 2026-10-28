/**
 * Run manager (RUN-001 – RUN-006; ADR-0006 §4, ADR-0007).
 *
 * - `gatherAuthorization` assembles every input of `authorizeExecution` from the stores, the policy and the
 *   adapter (dry-run command validation, prerequisites). Run creation and dispatch use the same function, so both
 *   evaluate exactly the same rules.
 * - `createRun` (TL-09) authorizes, persists the decision and the run **before** answering, writes the run header
 *   and starts dispatch. The approval use is consumed at dispatch, not here.
 * - `dispatchAuthorize` runs inside the detached supervisor: a fresh evaluation plus a comparison of the material
 *   bindings recorded at creation (`bindingDigest`); any change cancels the run (`authorization_invalidated`).
 * - `syncRun` imports the supervisor's event log into the run row and, once terminal, imports the merged results.
 * - `reconcileRuns` applies ADR-0007 §7 on startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  countOutcomes,
  mergeAttempts,
  type AdapterRegistry,
  type HostInfo,
  type NormalizedResult,
  type PlatformAdapter,
  type ProbePort,
} from '@autotest/adapter-sdk';
import {
  derivedId,
  digest,
  isTerminal,
  PortError,
  statusCategoryOf,
  toolError,
  type Approval,
  type AuthorizationReason,
  type CancelReason,
  type ErrorCode,
  type ExecutionAuthorizationDecision,
  type ExecutionSpec,
  type ProcessIdentity,
  type Run,
  type RunState,
  type TestPlan,
  type TestResult,
  type TestTarget,
  type ToolError,
  type ToolInput,
  type ToolOutput,
} from '@autotest/core';
import {
  admit,
  AttemptResultsFile,
  DEFAULT_RETRY_ON,
  importRunEvents,
  readJson,
  readRunFiles,
  requestCancel,
  runPaths,
  selectDispatchable,
  supervisorAlive,
  stopOrphans,
  writeRunHeader,
  type DispatchAuthorization,
  type ExecPort,
  type RunHeader,
} from '@autotest/execution';
import {
  authorizeExecution,
  buildRegistry,
  defaultPlanTargets,
  findWorkspace,
  nodeFsPort,
  planExecutionScope,
  resolvePlanTargets,
  resolveWorkspaces,
  validateSpec,
  type AuthorizationOutcome,
  type FsPort,
  type LoadedPolicy,
  type PolicyEnvironment,
  type PolicyLoadResult,
  type ResolvedWorkspace,
} from '@autotest/policy';
import { createWorkspaceReader } from '@autotest/workspace';
import { prepareBaseline, releaseBaseline, type PreparedBaseline } from './baseline.ts';
import { prepareRunDevice, releaseRunDevices, type RunDevice } from './devices.ts';
import type { CallContext, WorkflowPorts } from './ports.ts';
import { fail, ok, type UseCaseResult } from './result.ts';

export interface RunDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly registry: AdapterRegistry;
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
  readonly dataRoot: string;
  readonly host: HostInfo;
  readonly fs?: FsPort;
  readonly execPort?: ExecPort;
  /** Heartbeat interval written into run headers (default 5 s). */
  readonly heartbeatMs?: number;
  /** Survivor verification window (default 10 min, ADR-0007). */
  readonly cancelVerifyWindowMs?: number;
  /** Toolchain probes for adapter prerequisites (APM-001: pinned Appium versions); absent, adapters get none. */
  readonly probes?: (workspace: ResolvedWorkspace) => ProbePort;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const POLL_AFTER_MS = 2000;

// ------------------------------------------------------------------ authorization inputs

export interface GatheredAuthorization {
  readonly outcome: AuthorizationOutcome;
  readonly plan: TestPlan;
  readonly workspace?: ResolvedWorkspace;
  readonly adapter?: PlatformAdapter;
  /** TestTarget records (from the plan's inventory snapshot) for the resolved targets. */
  readonly targets: readonly TestTarget[];
  /** Attempt-1 specs (built at creation; the header's specs at dispatch). */
  readonly specs: readonly ExecutionSpec[];
  readonly prerequisites: readonly { readonly code: string; readonly message: string }[];
  /** Why the request could not even be assembled (mixed adapters, missing inventory). */
  readonly problem?: ToolError;
}

interface GatherArgs {
  readonly plan: TestPlan;
  readonly refs: readonly string[] | undefined;
  readonly environment: string;
  readonly phase: 'create' | 'dispatch';
  readonly runId: string;
  readonly coverage: boolean;
  /** Dispatch: the specs authorized at creation; create: built from the adapter. */
  readonly specs?: readonly ExecutionSpec[];
  readonly cancellationRequested?: boolean;
  /** ANL-002: a baseline run executes in this worktree root instead of the workspace root. */
  readonly executionRoot?: string;
  /** FL-006: the run's device and whether policy allows this run to use it. */
  readonly device?: {
    readonly deviceId: string;
    readonly platform: 'ios' | 'android';
    readonly address: string;
    readonly allowed: boolean;
  };
}

export async function gatherAuthorization(deps: RunDeps, a: GatherArgs): Promise<GatheredAuthorization> {
  const { ports } = deps;
  const fsp = deps.fs ?? nodeFsPort();
  const now = ports.clock.now();
  const policy: LoadedPolicy | undefined = deps.policy.ok ? deps.policy.policy : undefined;
  const latest = await ports.plans.get(a.plan.id);
  const set = await ports.requirements.get(a.plan.requirementSetId);
  const coverage =
    set && policy
      ? await ports.decisions.findCurrent({
          planHash: a.plan.planHash,
          requirementSetHash: set.requirementSetHash,
          gatePolicyVersion: policy.gatePolicyVersion,
        })
      : undefined;
  const targetIds =
    (a.refs && a.refs.length > 0 ? resolvePlanTargets(a.plan, a.refs) : defaultPlanTargets(a.plan)) ?? [];
  // A tampered or forged approval record fails its integrity check: nothing for this scope is usable (fail closed).
  let approvals: Approval[] = [];
  let approvalIntegrity = true;
  if (targetIds.length > 0)
    try {
      approvals = await ports.approvals.listByScopeDigest(
        planExecutionScope({ planHash: a.plan.planHash, environment: a.environment, targetIds }).digest,
      );
    } catch (e) {
      if (!(e instanceof PortError && e.code === 'integrity')) throw e;
      approvalIntegrity = false;
    }
  const workspace =
    policy && a.plan.repository.localPath
      ? findWorkspace(fsp, resolveWorkspaces(fsp, policy.config.workspaces), a.plan.repository.localPath)
      : undefined;

  const inventory = await ports.inventories.get(a.plan.inventoryId);
  const targets = targetIds
    .map((id) => inventory?.targets.find((t) => t.id === id))
    .filter((t): t is TestTarget => t !== undefined);
  let problem: ToolError | undefined;
  if (targetIds.length > 0 && targets.length !== targetIds.length)
    problem = toolError('E_PLAN_NOT_FOUND', "some plan targets are missing from the plan's inventory snapshot", [
      'Re-run inspect_test_inventory and generate a new plan version',
    ]);
  if (!problem && !approvalIntegrity)
    problem = toolError('E_STORAGE_CORRUPT', 'an approval record for this scope failed its integrity check', [
      'Revoke the affected approval (`autotest approvals`, `autotest revoke`), approve again, and review the audit log',
    ]);
  const adapterIds = [...new Set(targets.map((t) => t.adapterId))];
  if (!problem && adapterIds.length > 1)
    problem = toolError('E_CAPABILITY_UNAVAILABLE', 'one run can use only one platform adapter', [
      'Select targets of one adapter per run_tests call',
    ]);
  const adapter = adapterIds.length === 1 ? deps.registry.get(adapterIds[0]!) : undefined;
  // FL-006: device targets need the run's device, of their platform; a device run needs device targets.
  const deviceTargets = targets.filter((t) => t.requires.device !== 'none');
  if (
    !problem &&
    deviceTargets.length > 0 &&
    (!a.device || deviceTargets.some((t) => !t.platforms.includes(a.device!.platform)))
  )
    problem = toolError(
      'E_VALIDATION',
      'the selected targets run on a device: pass one booted AutoTest device of their platform in `devices`',
      ['Create and boot one with manage_simulator, then call run_tests with devices: [deviceId]'],
      { issues: [{ pointer: '/devices', message: 'device required for integration targets' }] },
    );
  if (!problem && a.device && targets.length > 0 && deviceTargets.length === 0)
    problem = toolError(
      'E_VALIDATION',
      'none of the selected targets runs on a device',
      ['Omit `devices` for host tests'],
      {
        issues: [{ pointer: '/devices', message: 'no device targets selected' }],
      },
    );
  if (!problem && targets.length > 0 && !adapter)
    problem = toolError('E_CAPABILITY_UNAVAILABLE', `adapter ${adapterIds[0]} is not installed in this build`, []);

  // Dry-run command policy (check 5) and prerequisites (check 6).
  const runDir = runPaths(deps.dataRoot, a.runId).dir;
  const execWorkspace = workspace && a.executionRoot ? { ...workspace, realPath: a.executionRoot } : workspace;
  let specs: readonly ExecutionSpec[] = a.specs ?? [];
  let commandsOk = false;
  const missing: { code: string; message: string }[] = [];
  if (!problem && adapter && workspace && policy && targets.length > 0) {
    try {
      if (!a.specs)
        specs = adapter.buildExecution({
          attemptNo: 1,
          targets,
          options: { coverage: a.coverage, timeoutMs: policy.config.execution.defaultTimeoutMs },
          ...(a.device ? { device: { platform: a.device.platform, id: a.device.address } } : {}),
        });
      const registry = buildRegistry(fsp, policy.config.executables);
      commandsOk =
        specs.length > 0 &&
        specs.every(
          (spec) =>
            validateSpec(spec, {
              fs: fsp,
              registry,
              workspaceRoot: execWorkspace!.realPath,
              runDir,
              allowDependencyResolution: policy.config.execution.allowDependencyResolution,
              allowedClasses: ['test_runner'],
            }).ok,
        );
    } catch {
      commandsOk = false;
    }
    if (adapter.prerequisites) {
      const report = await adapter.prerequisites({
        workspace: createWorkspaceReader(execWorkspace!, fsp),
        host: deps.host,
        ...(deps.probes ? { probes: deps.probes(execWorkspace!) } : {}),
      });
      missing.push(...report.missing);
    }
  }
  const outcome = authorizeExecution({
    decisionId: ports.ids.newId('authz'),
    phase: a.phase,
    runId: a.runId,
    now,
    request: {
      planId: a.plan.id,
      planHash: a.plan.planHash,
      targets: targetIds,
      deviceIds: a.device ? [a.device.deviceId] : [],
      environment: a.environment,
    },
    serverEnvironment: deps.serverEnvironment,
    policy,
    plan: a.plan,
    latestPlanVersion: latest?.version,
    currentRequirementSetHash: set?.requirementSetHash,
    coverage,
    approvals,
    workspace,
    devices: a.device ? [{ deviceId: a.device.deviceId, allowed: a.device.allowed }] : [],
    commands: targetIds.map((targetId) => ({ targetId, ok: commandsOk })),
    prerequisites: { satisfied: missing.length === 0 },
    ...(a.phase === 'dispatch' ? { cancellation: { requested: a.cancellationRequested === true } } : {}),
  });
  return {
    outcome,
    plan: a.plan,
    ...(workspace ? { workspace } : {}),
    ...(adapter ? { adapter } : {}),
    targets,
    specs,
    prerequisites: missing,
    ...(problem ? { problem } : {}),
  };
}

/**
 * The material bindings of an authorization: what was authorized, not when or by which decision. Creation records
 * it in the run header; dispatch recomputes it and cancels the run on any difference (RUN-002).
 */
export function bindingDigest(
  g: GatheredAuthorization,
  environment: string,
  policy: PolicyLoadResult,
  baselineCommit?: string,
): string {
  return digest({
    baseline: baselineCommit ?? null,
    planId: g.plan.id,
    planVersion: g.plan.version,
    planHash: g.plan.planHash,
    environment,
    policyVersion: policy.ok ? policy.policy.policyVersion : null,
    workspace: g.workspace ? { id: g.workspace.id, realPath: g.workspace.realPath } : null,
    targets: [...g.outcome.resolvedTargets].sort(),
    specs: g.specs.map((s) => digest(s)),
  });
}

/** The tool error for a denied authorization; the most specific reason wins, all reasons are in `details`. */
export function denialError(
  decision: ExecutionAuthorizationDecision,
  prerequisites: GatheredAuthorization['prerequisites'],
): ToolError {
  const order: readonly [AuthorizationReason, ErrorCode, string][] = [
    ['policy_unavailable', 'E_POLICY_UNAVAILABLE', 'Fix ~/.autotest/config.yaml, then run `autotest doctor`'],
    ['plan_hash_mismatch', 'E_PLAN_HASH_MISMATCH', 'Use the planHash returned by generate_test_plan'],
    ['superseded', 'E_PLAN_HASH_MISMATCH', 'A newer plan version exists: validate and run that version'],
    ['coverage_missing', 'E_COVERAGE_MISSING', 'Call validate_test_coverage first'],
    ['coverage_stale', 'E_COVERAGE_STALE', 'Call validate_test_coverage again for this plan version'],
    ['coverage_failed', 'E_COVERAGE_FAILED', 'Fix the blocker findings and generate a new plan version'],
    // What the request asks for is outside policy: after coverage (fix the gate first), before approvals.
    ['target_not_eligible', 'E_POLICY_DENIED', 'Select eligible targets of this plan (or omit targets)'],
    ['environment_not_allowed', 'E_POLICY_DENIED', 'Omit environment to use this server'],
    ['workspace_not_allowed', 'E_POLICY_DENIED', "Add the plan's workspace to config.yaml (not read-only)"],
    ['device_not_allowed', 'E_POLICY_DENIED', 'Use an allowlisted device'],
    ['command_denied', 'E_POLICY_DENIED', 'Allowlist the executable in config.yaml (`autotest doctor`)'],
    ['approval_required', 'E_APPROVAL_REQUIRED', 'Call request_approval; a human approves with `autotest approve`'],
    ['approval_stale', 'E_APPROVAL_STALE', 'Request a new approval for the current plan hash'],
    ['approval_expired', 'E_APPROVAL_EXPIRED', 'Request a new approval'],
    ['approval_revoked', 'E_APPROVAL_REVOKED', 'Request a new approval'],
    ['approval_exhausted', 'E_APPROVAL_EXHAUSTED', 'Request a new approval'],
    ['assurance_insufficient', 'E_ASSURANCE_INSUFFICIENT', 'Approve with `autotest approve` (AL2)'],
    ['prerequisite_missing', 'E_PREREQUISITE_MISSING', prerequisites[0]?.message ?? 'Resolve the prerequisites'],
  ];
  const hit = order.find(([r]) => decision.reasons.includes(r));
  const [code, next] = hit ? [hit[1], hit[2]] : (['E_POLICY_DENIED', 'See details.reasons'] as const);
  return toolError(code, `execution is not authorized: ${decision.reasons.join(', ')}`, [next], {
    authorizationId: decision.id,
    reasons: [...decision.reasons],
    ...(prerequisites.length ? { prerequisites: prerequisites.map((p) => p.code) } : {}),
  });
}

async function recordDecision(
  deps: RunDeps,
  d: ExecutionAuthorizationDecision,
  actor: 'agent' | 'server',
): Promise<void> {
  await deps.ports.authorizations.put(d);
  await deps.ports.audit.append({
    ts: d.evaluatedAt,
    actor,
    kind: 'authorization.decision',
    subjectRefs: [d.id, ...(d.runId ? [d.runId] : [])],
    data: { phase: d.phase, result: d.result, reasons: [...d.reasons], inputsDigest: d.inputsDigest },
  });
}

// ------------------------------------------------------------------ TL-09 run_tests

export async function createRun(
  deps: RunDeps,
  input: ToolInput<'run_tests'>,
  ctx: CallContext,
): Promise<UseCaseResult<ToolOutput<'run_tests'>>> {
  const { ports } = deps;
  if (!deps.policy.ok)
    return fail(toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', ['Run `autotest doctor`']));
  const policy = deps.policy.policy;
  const exec = policy.config.execution;
  const environment = input.environment === 'local' ? deps.serverEnvironment.id : input.environment;
  const { idempotencyKey, ...request } = input;
  const requestDigest = digest({ ...request, environment });

  if (idempotencyKey) {
    const prior = await ports.runs.findByIdempotencyKey(idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        return fail(
          toolError('E_IDEMPOTENCY_CONFLICT', 'this idempotencyKey was used with a different request', [
            'Use a new idempotencyKey',
          ]),
        );
      return ok({
        runId: prior.id,
        state: 'queued',
        authorizationId: prior.authorizationIds[0]!,
        targetsCount: prior.targets.length,
        queuePosition: 0,
        pollAfterMs: POLL_AFTER_MS,
        limitations: [...prior.limitations],
      });
    }
  }
  if (input.devices.length > 1)
    return fail(
      toolError('E_VALIDATION', 'one device per run', ['Start one run per device'], {
        issues: [{ pointer: '/devices', message: 'at most one device' }],
      }),
    );
  const maxAttempts = input.retry?.maxAttempts ?? 1 + exec.maxRetries;
  if (maxAttempts > 1 + exec.maxRetries)
    return fail(
      toolError('E_POLICY_DENIED', `policy allows at most ${1 + exec.maxRetries} attempts`, [
        'Lower retry.maxAttempts',
      ]),
    );
  const runMs = input.timeouts?.runMs ?? exec.defaultTimeoutMs;
  if (runMs > exec.defaultTimeoutMs)
    return fail(
      toolError('E_POLICY_DENIED', `policy allows run timeouts up to ${exec.defaultTimeoutMs} ms`, [
        'Lower timeouts.runMs or raise execution.defaultTimeoutMs in config.yaml',
      ]),
    );

  const plan = await ports.plans.getByHash(input.planHash);
  if (!plan || plan.id !== input.planId) {
    const anyVersion = await ports.plans.get(input.planId);
    return fail(
      anyVersion
        ? toolError('E_PLAN_HASH_MISMATCH', 'no version of this plan has that planHash', [
            'Use the planHash returned by generate_test_plan',
          ])
        : toolError('E_PLAN_NOT_FOUND', `plan ${input.planId} does not exist`, ['Call generate_test_plan first']),
    );
  }

  const runId = ports.ids.newId('run');
  const coverage = input.evidence?.coverage ?? false;
  // The run directory must exist for the dry run's output-path checks; it is removed again if the run is refused.
  const runDir = runPaths(deps.dataRoot, runId).dir;
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  let baseline: PreparedBaseline | undefined;
  const refuse = async (error: ToolError) => {
    if (baseline && plan.repository.localPath) {
      const ws = findWorkspace(
        nodeFsPort(),
        resolveWorkspaces(nodeFsPort(), policy.config.workspaces),
        plan.repository.localPath,
      );
      if (ws) await releaseBaseline(baselineDeps(deps), { workspaceRoot: ws.realPath, runId });
    }
    fs.rmSync(runDir, { recursive: true, force: true });
    return fail<ToolOutput<'run_tests'>>(error);
  };
  let device: RunDevice | undefined;
  if (input.devices.length === 1) {
    const d = await prepareRunDevice(deviceDepsOf(deps), input.devices[0]!);
    if (!d.ok) return refuse(d.error);
    device = d.device;
  }
  if (input.baseline) {
    const b = await prepareBaseline(baselineDeps(deps), {
      plan,
      runId,
      ...(input.baseline.ref ? { ref: input.baseline.ref } : {}),
      ...(input.targets ? { targets: input.targets } : {}),
    });
    if (!b.ok) return refuse(b.error);
    baseline = b.value;
  }
  const g = await gatherAuthorization(deps, {
    plan,
    refs: baseline ? baseline.targetIds : input.targets,
    environment,
    phase: 'create',
    runId,
    coverage,
    ...(baseline ? { executionRoot: baseline.root } : {}),
    ...(device
      ? { device: { deviceId: device.deviceId, platform: device.platform, address: device.address, allowed: true } }
      : {}),
  });
  await recordDecision(deps, g.outcome.decision, 'agent');
  if (g.problem) return refuse(g.problem);
  if (g.outcome.decision.result !== 'authorized') return refuse(denialError(g.outcome.decision, g.prerequisites));

  const nonTerminal = await ports.runs.listNonTerminal();
  const queued = nonTerminal.filter((r) => r.state === 'queued' && !r.supervisor);
  const admission = admit(queued.length, exec);
  if (!admission.ok) return refuse(admission.error);

  const now = ports.clock.now();
  const header: RunHeader = {
    runId,
    workspaceId: g.workspace!.id,
    authorizationDigest: bindingDigest(g, environment, deps.policy, baseline?.commit) as `sha256:${string}`,
    specs: [...g.specs],
    timeouts: { runMs },
    graceMs: exec.cancelGraceMs,
    heartbeatMs: deps.heartbeatMs ?? 5000,
    cancelVerifyWindowMs: deps.cancelVerifyWindowMs ?? 600_000,
    diskQuotaBytes: exec.runDiskQuotaBytes,
    outputCapBytes: exec.outputCapBytes,
    execution: {
      adapterId: g.adapter!.id,
      targets: [...g.targets],
      coverage,
      maxAttempts,
      retryOn: [...DEFAULT_RETRY_ON],
      ...(device ? { device: { platform: device.platform, id: device.address } } : {}),
    },
    ...(baseline ? { baseline: { commit: baseline.commit, dir: 'baseline' as const } } : {}),
  };
  writeRunHeader(deps.dataRoot, header);
  const run: Run = {
    id: runId,
    schemaVersion: 1,
    planId: plan.id,
    planHash: plan.planHash,
    targets: [...g.outcome.resolvedTargets],
    environment,
    devices: device ? [device.deviceId] : [],
    state: 'queued',
    statusCategory: 'pending',
    ...(idempotencyKey ? { idempotencyKey } : {}),
    requestDigest,
    authorizationIds: [g.outcome.decision.id],
    timeouts: { runMs, attemptMs: input.timeouts?.attemptMs ?? runMs, targetMs: input.timeouts?.targetMs ?? runMs },
    retryPolicy: { maxAttempts, retryOn: [...DEFAULT_RETRY_ON] },
    counts: {},
    partial: false,
    limitations: [...(baseline?.limitations ?? [])],
    ...(baseline ? { baseline: { ref: baseline.ref, commit: baseline.commit } } : {}),
    createdAt: iso(now),
  };
  await ports.runs.create(run);
  if (device) await ports.deviceLeases.put({ ...device.lease, runId });
  await ports.audit.append({
    ts: iso(now),
    actor: 'agent',
    kind: 'run.created',
    subjectRefs: [runId, plan.id],
    data: { runId, planHash: plan.planHash, authorizationId: g.outcome.decision.id, toolCallId: ctx.toolCallId },
  });
  await pumpQueue(deps);
  const position = (await ports.runs.listNonTerminal()).filter((r) => r.state === 'queued' && !r.supervisor).length;
  return ok({
    runId,
    state: 'queued',
    authorizationId: g.outcome.decision.id,
    targetsCount: run.targets.length,
    queuePosition: position,
    pollAfterMs: POLL_AFTER_MS,
    limitations: [...run.limitations],
  });
}

/** The device helpers' view of the run dependencies (the device tools see the server's environment). */
export function deviceDepsOf(deps: RunDeps) {
  return {
    ports: deps.ports,
    policy: deps.policy,
    dataRoot: deps.dataRoot,
    hostOs: deps.host.os,
    serverEnvironment: deps.serverEnvironment,
    parentEnv: process.env,
    ...(deps.execPort ? { execPort: deps.execPort } : {}),
  };
}

/** The baseline helpers' view of the run dependencies. */
export function baselineDeps(deps: RunDeps) {
  if (!deps.policy.ok) throw new Error('baseline runs need a loaded policy');
  return {
    ports: deps.ports,
    policy: deps.policy.policy,
    dataRoot: deps.dataRoot,
    adapterFor: (id: string) => deps.registry.get(id),
    ...(deps.fs ? { fs: deps.fs } : {}),
    ...(deps.execPort ? { execPort: deps.execPort } : {}),
  };
}

// ------------------------------------------------------------------ dispatch

/** Starts supervisors for queued runs while slots are free (EXE-004 work-conserving FIFO). */
export async function pumpQueue(deps: RunDeps): Promise<string[]> {
  if (!deps.policy.ok) return [];
  // Refresh runs holding slots first: one that ended since the last poll frees its slot now.
  for (const r of await deps.ports.runs.listNonTerminal()) if (r.supervisor) await syncRun(deps, r.id, { pump: false });
  const all = await deps.ports.runs.listNonTerminal();
  const queued = all.filter((r) => r.state === 'queued' && !r.supervisor);
  if (queued.length === 0) return [];
  const active = all.filter((r) => !(r.state === 'queued' && !r.supervisor));
  const header = (r: Run) =>
    readJson(runPaths(deps.dataRoot, r.id).header, {
      safeParse: (v: unknown) => ({ success: true as const, data: v as RunHeader }),
    });
  const start = selectDispatchable(
    queued.map((r) => ({
      runId: r.id,
      workspaceId: header(r)?.workspaceId ?? '',
      devices: r.devices,
      queuedAt: r.createdAt,
    })),
    active.map((r) => ({ runId: r.id, workspaceId: header(r)?.workspaceId ?? '', devices: r.devices })),
    deps.policy.policy.config.execution,
  );
  const started: string[] = [];
  for (const runId of start) {
    let supervisor: ProcessIdentity;
    try {
      supervisor = await deps.ports.execution.startSupervisor(runId);
    } catch {
      await deps.ports.runs.update(runId, {
        state: 'infra_error',
        statusCategory: 'failed',
        infraReason: 'supervisor_lost',
        endedAt: iso(deps.ports.clock.now()),
      });
      continue;
    }
    await deps.ports.runs.update(runId, { supervisor, startedAt: iso(deps.ports.clock.now()) });
    started.push(runId);
  }
  return started;
}

/**
 * Dispatch-time re-authorization (RUN-002), run by the supervisor. Persists the decision, compares the material
 * bindings with creation and consumes the approval use when one was needed.
 */
/** The canonical baseline worktree of a run ('' when it is missing, which fails the spec checks). */
function baselineRoot(deps: RunDeps, runId: string): string {
  try {
    return fs.realpathSync(path.join(runPaths(deps.dataRoot, runId).dir, 'baseline'));
  } catch {
    return '';
  }
}

export async function dispatchAuthorize(deps: RunDeps, header: RunHeader): Promise<DispatchAuthorization> {
  const { ports } = deps;
  const run = await ports.runs.get(header.runId);
  const plan = run && (await ports.plans.getByHash(run.planHash));
  if (!run || !plan || plan.id !== run.planId)
    return { result: 'denied', reasons: ['unknown_state'], inputsDigest: header.authorizationDigest };
  const g = await gatherAuthorization(deps, {
    plan,
    refs: run.targets,
    environment: run.environment,
    phase: 'dispatch',
    runId: run.id,
    coverage: header.execution?.coverage ?? false,
    specs: header.specs,
    cancellationRequested: fs.existsSync(runPaths(deps.dataRoot, run.id).control),
    ...(header.baseline ? { executionRoot: baselineRoot(deps, run.id) } : {}),
    ...(run.devices[0] && header.execution?.device
      ? {
          device: {
            deviceId: run.devices[0],
            platform: header.execution.device.platform,
            address: header.execution.device.id,
            // The lease still names this run and AutoTest still owns the device.
            allowed: (await ports.deviceLeases.findByDevice(run.devices[0]))?.runId === run.id,
          },
        }
      : {}),
  });
  let decision = g.outcome.decision;
  const binding = bindingDigest(g, run.environment, deps.policy, header.baseline?.commit);
  const reasons = new Set<AuthorizationReason>(decision.reasons);
  if (binding !== header.authorizationDigest) reasons.add('unknown_state');
  if (reasons.size === 0 && g.outcome.approvalId) {
    try {
      const consumed = await ports.approvals.consume(g.outcome.approvalId, ports.clock.now());
      await ports.audit.append({
        ts: iso(ports.clock.now()),
        actor: 'server',
        kind: 'approval.consumed',
        subjectRefs: [consumed.id, run.id],
        data: { approvalId: consumed.id, uses: consumed.uses },
      });
    } catch (e) {
      reasons.add(e instanceof PortError && e.code === 'not_usable' ? 'approval_exhausted' : 'unknown_state');
    }
  }
  if (reasons.size !== decision.reasons.length) {
    const ordered = [...reasons].sort();
    decision = { ...decision, result: 'denied', reasons: ordered };
  }
  await recordDecision(deps, decision, 'server');
  await ports.runs.update(run.id, { authorizationIds: [...run.authorizationIds, decision.id] });
  return { result: decision.result, reasons: [...decision.reasons], inputsDigest: binding };
}

// ------------------------------------------------------------------ status, results, cancel

/** Imports the supervisor's files into the run row; once terminal, imports the merged results exactly once. */
export async function syncRun(
  deps: RunDeps,
  runId: string,
  opts: { readonly pump?: boolean } = {},
): Promise<Run | undefined> {
  const { ports } = deps;
  let run = await ports.runs.get(runId);
  if (!run || isTerminal(run.state)) return run;
  let files = readRunFiles(deps.dataRoot, runId);
  if (!files.terminal && run.supervisor && !supervisorRunning(run, files)) {
    // The supervisor died without a terminal record (killed, crashed). Re-read once: it may have just finished.
    files = readRunFiles(deps.dataRoot, runId);
    if (!files.terminal) {
      const lost = await markLost(deps, run, files);
      if (opts.pump !== false) await pumpQueue(deps);
      return lost;
    }
  }
  const imported = importRunEvents(files.events, 0);
  const terminal = files.terminal;
  const state: RunState = terminal?.state ?? imported.state ?? run.state;
  if (state !== run.state || terminal) {
    const patch: Partial<Run> = {
      state,
      statusCategory: statusCategoryOf(state),
      ...((terminal?.cancelReason ?? cancelReasonOf(files.events.events))
        ? { cancelReason: (terminal?.cancelReason ?? cancelReasonOf(files.events.events))! }
        : {}),
      ...(terminal?.infraReason ? { infraReason: terminal.infraReason } : {}),
      ...(imported.limitations.length
        ? { limitations: imported.limitations.map((code) => ({ code, message: code.replace(/_/g, ' ') })) }
        : {}),
      ...(terminal ? { endedAt: terminal.endedAt } : {}),
      // The supervisor appends the terminal state event before it writes terminal.json: a sync in between still
      // records when the run ended (OPS-007 found runs without endedAt, which retention never removed).
      ...(!terminal && isTerminal(state)
        ? { endedAt: terminalEventTs(files.events.events, state) ?? iso(ports.clock.now()) }
        : {}),
    };
    try {
      run = await ports.runs.update(runId, patch, run.state);
    } catch (e) {
      if (!(e instanceof PortError && e.code === 'stale')) throw e;
      run = (await ports.runs.get(runId))!;
    }
    await ports.audit.append({
      ts: iso(ports.clock.now()),
      actor: 'server',
      kind: 'run.transition',
      subjectRefs: [runId],
      data: { runId, from: run.state === state ? 'imported' : run.state, to: state },
    });
  }
  if (isTerminal(run.state)) {
    run = await importResults(deps, run);
    if (opts.pump !== false) await pumpQueue(deps);
  }
  return run;
}

/** The timestamp of the last state event that entered `state`. */
function terminalEventTs(
  events: readonly { t: string; ts?: string; to?: string }[],
  state: RunState,
): string | undefined {
  return [...events].reverse().find((e) => e.t === 'state' && e.to === state)?.ts;
}

/** Supervisor liveness: identity-checked when the identity is known, otherwise by heartbeat freshness. */
function supervisorRunning(run: Run, files: ReturnType<typeof readRunFiles>): boolean {
  const s = run.supervisor!;
  if (s.startTime !== 'unknown') return supervisorAlive(s);
  const last = files.heartbeat?.ts ?? run.startedAt ?? run.createdAt;
  return Date.now() - Date.parse(last) < 30_000;
}

async function markLost(deps: RunDeps, run: Run, files: ReturnType<typeof readRunFiles>): Promise<Run> {
  const stopped = await stopOrphans(files.events, deps.execPort);
  const reason =
    stopped.unverified || run.supervisor?.startTime === 'unknown' ? 'orphan_unverified' : 'supervisor_lost';
  await deps.ports.audit.append({
    ts: iso(deps.ports.clock.now()),
    actor: 'server',
    kind: 'reconciliation.action',
    subjectRefs: [run.id],
    data: { action: reason, runId: run.id },
  });
  const updated = await deps.ports.runs.update(run.id, {
    state: 'infra_error',
    statusCategory: 'failed',
    infraReason: reason,
    endedAt: iso(deps.ports.clock.now()),
  });
  return importResults(deps, updated);
}

function cancelReasonOf(events: readonly { t: string; to?: string; reason?: string }[]): CancelReason | undefined {
  for (const e of events)
    if (e.t === 'state' && e.to === 'cancelling' && e.reason)
      return (['user', 'timeout', 'authorization_invalidated', 'resource_quota'] as const).find((r) => r === e.reason);
  return undefined;
}

/** Reads every attempt's results file in attempt order (missing or invalid files are skipped). */
export function readAttemptResults(dataRoot: string, runId: string): AttemptResultsFile[] {
  const dir = path.join(runPaths(dataRoot, runId).dir, 'attempts');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{1,2}$/.test(n));
  } catch {
    return [];
  }
  return names
    .map(Number)
    .sort((a, b) => a - b)
    .map((n) => readJson(path.join(dir, String(n), 'results.json'), AttemptResultsFile))
    .filter((f): f is AttemptResultsFile => f !== undefined);
}

/** Merges attempts, accounts for every run target, links test cases and stores results with derived ids. */
/**
 * Removes a terminal baseline run's worktree (ANL-002). The supervisor does this when the run ends; the server repeats
 * it on import and `autotest cleanup` on reconcile, so a crashed supervisor never leaves a checkout behind.
 */
export async function finishBaseline(deps: RunDeps, runId: string): Promise<void> {
  const dir = path.join(runPaths(deps.dataRoot, runId).dir, 'baseline');
  if (!deps.policy.ok || !fs.existsSync(dir)) return;
  const header = readJson(runPaths(deps.dataRoot, runId).header, {
    safeParse: (v: unknown) => ({ success: true as const, data: v as RunHeader }),
  });
  const fsp = deps.fs ?? nodeFsPort();
  const ws = resolveWorkspaces(fsp, deps.policy.policy.config.workspaces).workspaces.find(
    (w) => w.id === header?.workspaceId,
  );
  if (ws) await releaseBaseline(baselineDeps(deps), { workspaceRoot: ws.realPath, runId });
  else fs.rmSync(dir, { recursive: true, force: true });
}

export async function importResults(deps: RunDeps, run: Run): Promise<Run> {
  const { ports } = deps;
  if (run.baseline) await finishBaseline(deps, run.id);
  if (run.devices.length) await releaseRunDevices(ports, run.id, run.devices);
  const existing = await ports.results.list(run.id, { offset: 0, limit: 1 });
  if (existing.total > 0) return run;
  const attempts = readAttemptResults(deps.dataRoot, run.id);
  const merged = mergeAttempts(attempts.map((a) => a.results as NormalizedResult[]));
  const targets = new Set(run.targets);
  const seen = new Set(merged.map((r) => r.targetId));
  const missingOutcome = run.state === 'cancelled' ? 'cancelled' : 'not_run';
  const all = [
    ...merged.filter((r) => targets.has(r.targetId)),
    ...run.targets
      .filter((t) => !seen.has(t))
      .map(
        (t) =>
          ({
            targetId: t,
            name: '(target)',
            outcome: missingOutcome,
            rawStatus: 'not_reached',
            flaky: false,
            attemptNo: 1,
          }) as const,
      ),
  ];
  const plan = await ports.plans.getByHash(run.planHash);
  // Each result links the redacted runner output and logs of the attempt that decided it (max 10).
  const artifacts = (await ports.artifacts.list(run.id)).filter(
    (a) => !a.quarantined && (a.kind === 'runner_json' || a.kind === 'stdout' || a.kind === 'stderr'),
  );
  const refsFor = (attemptNo: number) =>
    artifacts
      .filter((a) => a.attemptNo === attemptNo)
      .slice(0, 10)
      .map((a) => a.id);
  const casesFor = (targetId: string) =>
    (plan?.testCases ?? []).filter((c) => c.targetRef === targetId && c.eligibility === 'eligible').map((c) => c.id);
  const results: TestResult[] = all.map((r, i) => ({
    id: derivedId('res', `${run.id}#${i}`),
    runId: run.id,
    attemptNo: r.attemptNo,
    testCaseIds: casesFor(r.targetId),
    targetId: r.targetId,
    name: r.name,
    ...('suitePath' in r && r.suitePath ? { suitePath: r.suitePath } : {}),
    outcome: r.outcome,
    ...('failureKind' in r && r.failureKind ? { failureKind: r.failureKind } : {}),
    ...('blockedReason' in r && r.blockedReason ? { blockedReason: r.blockedReason } : {}),
    ...('durationMs' in r && r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    flaky: r.flaky,
    ...('messageExcerpt' in r && r.messageExcerpt ? { messageExcerpt: r.messageExcerpt } : {}),
    artifactRefs: refsFor(r.attemptNo),
    rawStatus: r.rawStatus,
  }));
  try {
    await ports.results.append(results);
  } catch (e) {
    // Another server imported the same run first: the derived ids collide and that import stands.
    if (!(e instanceof PortError && e.code === 'conflict')) throw e;
  }
  const partial =
    run.state !== 'completed' || attempts.some((a) => a.diagnostics.some((d) => d.code === 'runner_incomplete'));
  return ports.runs.update(run.id, { counts: countOutcomes(results), partial });
}

export async function cancelRun(
  deps: RunDeps,
  runId: string,
  reason: string | undefined,
): Promise<UseCaseResult<ToolOutput<'cancel_test_run'>>> {
  const { ports } = deps;
  let run = await syncRun(deps, runId);
  if (!run) return fail(toolError('E_RUN_NOT_FOUND', `run ${runId} does not exist`, []));
  if (isTerminal(run.state))
    return ok({ runId, state: run.state, alreadyTerminal: true, survivors: [], pollAfterMs: null });
  await ports.audit.append({
    ts: iso(ports.clock.now()),
    actor: 'agent',
    kind: 'run.cancel_requested',
    subjectRefs: [runId],
    data: { runId, reason: 'user', ...(reason ? { note: reason.replace(/[\r\n\t]/g, ' ').slice(0, 200) } : {}) },
  });
  if (run.state === 'queued' && !run.supervisor) {
    // Never started: nothing to terminate, and no approval use was consumed (consumed at dispatch).
    run = await ports.runs.update(
      runId,
      { state: 'cancelled', statusCategory: 'cancelled', cancelReason: 'user', endedAt: iso(ports.clock.now()) },
      'queued',
    );
    await importResults(deps, run);
    await pumpQueue(deps);
    return ok({ runId, state: 'cancelled', alreadyTerminal: false, survivors: [], pollAfterMs: null });
  }
  requestCancel(deps.dataRoot, runId, 'user', run.supervisor, deps.execPort);
  return ok({ runId, state: run.state, alreadyTerminal: false, survivors: [], pollAfterMs: 1000 });
}

// ------------------------------------------------------------------ RUN-006 restart reconciliation

export type ReconcileAction = 'queued' | 'reattach' | 'import_terminal' | 'supervisor_lost' | 'orphan_unverified';

/** ADR-0007 §7, applied to every non-terminal run on startup. Returns the action taken per run. */
export async function reconcileRuns(
  deps: RunDeps,
  opts: { readonly pump?: boolean } = {},
): Promise<Record<string, ReconcileAction>> {
  const { ports } = deps;
  const out: Record<string, ReconcileAction> = {};
  for (const run of await ports.runs.listNonTerminal()) {
    const files = readRunFiles(deps.dataRoot, run.id);
    let action: ReconcileAction;
    if (files.terminal) action = 'import_terminal';
    else if (run.state === 'queued' && !run.supervisor) action = 'queued';
    else if (!run.supervisor || run.supervisor.startTime === 'unknown')
      action = run.supervisor ? 'orphan_unverified' : 'supervisor_lost';
    else {
      if (supervisorAlive(run.supervisor, deps.execPort)) action = 'reattach';
      else {
        // Supervisor gone without a terminal record: stop identity-matched runner children it left behind.
        const stopped = await stopOrphans(files.events, deps.execPort);
        action = stopped.unverified ? 'orphan_unverified' : 'supervisor_lost';
      }
    }
    out[run.id] = action;
    if (action === 'queued' || action === 'reattach') continue;
    await ports.audit.append({
      ts: iso(ports.clock.now()),
      actor: 'server',
      kind: 'reconciliation.action',
      subjectRefs: [run.id],
      data: { action, runId: run.id },
    });
    if (action === 'import_terminal') await syncRun(deps, run.id, { pump: false });
    else {
      const updated = await ports.runs.update(run.id, {
        state: 'infra_error',
        statusCategory: 'failed',
        infraReason: action,
        endedAt: iso(ports.clock.now()),
      });
      await importResults(deps, updated);
    }
  }
  // The CLI reconciles without starting queued runs: only a server dispatches (it can launch supervisors).
  if (opts.pump !== false) await pumpQueue(deps);
  return out;
}
