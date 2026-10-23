/**
 * TL-01 `get_pr_context` (manual mode), TL-04 `extract_requirements` and TL-05 `generate_test_plan` use cases
 * (PLN-001 – PLN-005).
 *
 * - PR text is normalized and redacted before it is stored; the workspace is resolved through policy and recorded as
 *   the context's `repository.localPath`, so later steps can check that inventory and PR come from one workspace.
 * - Requirement sets are content-hashed; identical input for the same PR context returns the existing set.
 * - Plans are normalized against the requirement set and the inventory snapshot; eligibility uses each adapter's
 *   capabilities plus a dry resolution of its executable against policy. A plan with an already-stored hash is
 *   returned unchanged; a new version of `basePlanId` supersedes approvals bound to the previous hash.
 */
import type { AdapterRegistry, HostInfo, PlatformAdapter } from '@autotest/adapter-sdk';
import {
  computeRequirementSetHash,
  toolError,
  type PRContext,
  type RequirementSet,
  type RiskTier,
  type TestPlan,
  type TestTarget,
  type ToolOutput,
} from '@autotest/core';
import { assembleRequirementSet, normalizePlan, parsePrBody, type CapabilityView } from '@autotest/planning';
import {
  buildRegistry,
  findWorkspace,
  nodeFsPort,
  resolveWorkspaces,
  type PolicyLoadResult,
  type ResolvedWorkspace,
} from '@autotest/policy';
import { fail, normalizeManualPr, ok, pageBody, type UseCases, type WorkflowPorts } from '@autotest/workflow';
import { createWorkspaceReader } from '@autotest/workspace';

export interface PlanningDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly registry: AdapterRegistry;
  readonly host: HostInfo;
}

/** Leaves room under the 20,000-character output cap for the rest of the object. */
const LIST_BUDGET_CHARS = 17_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const policyUnavailable = () =>
  fail(
    toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', [
      'Fix ~/.autotest/config.yaml, then run `autotest doctor`.',
    ]),
  );

function resolveWorkspace(deps: PlanningDeps, ref: string): ResolvedWorkspace | undefined {
  if (!deps.policy.ok) return undefined;
  const fsp = nodeFsPort();
  return findWorkspace(fsp, resolveWorkspaces(fsp, deps.policy.policy.config.workspaces), ref);
}

/** Drops items from the end until the JSON of the list fits the budget. */
function fitList<T>(items: readonly T[], budget = LIST_BUDGET_CHARS): T[] {
  const out = [...items];
  while (out.length && JSON.stringify(out).length > budget) out.pop();
  return out;
}

export function planningUseCases(
  deps: PlanningDeps,
): Pick<UseCases, 'get_pr_context' | 'extract_requirements' | 'generate_test_plan'> {
  const { ports } = deps;
  return {
    async get_pr_context(input) {
      if (!deps.policy.ok) return policyUnavailable();
      if (input.source === 'github') {
        if (!input.github || input.manual)
          return fail(
            toolError('E_VALIDATION', 'source github requires `github` and no `manual`', [], {
              issues: [{ pointer: '/github', message: 'required' }],
            }),
          );
        return fail(
          toolError('E_CAPABILITY_UNAVAILABLE', 'GitHub mode is not available in this build (GH-002)', [
            'Use source "manual" and paste the PR body',
          ]),
        );
      }
      if (!input.manual || input.github)
        return fail(
          toolError('E_VALIDATION', 'source manual requires `manual` and no `github`', [], {
            issues: [{ pointer: '/manual', message: 'required' }],
          }),
        );
      const ws = resolveWorkspace(deps, input.workspace);
      if (!ws)
        return fail(
          toolError('E_WORKSPACE_NOT_ALLOWED', 'the workspace is not an allowlisted root', [
            'Add it to `workspaces` in ~/.autotest/config.yaml',
          ]),
        );
      const pr = normalizeManualPr(input.manual);
      if (!pr.body.trim())
        return fail(
          toolError('E_VALIDATION', 'the body is empty after normalization', [], {
            issues: [{ pointer: '/manual/body', message: 'empty' }],
          }),
        );
      const context: PRContext = {
        id: ports.ids.newId('prc'),
        schemaVersion: 1,
        createdAt: iso(ports.clock.now()),
        source: 'manual',
        repository: { ...(ws.github ?? { host: 'local' }), localPath: ws.realPath },
        ...(pr.title ? { title: pr.title } : {}),
        body: pr.body,
        ...(pr.labels.length ? { labels: pr.labels } : {}),
        changedFiles: pr.changedFiles,
        limitations: pr.limitations,
        untrustedFields: ['/title', '/body', '/labels'],
      };
      await ports.prContexts.put(context);
      const page = pageBody(context.body, input.bodyOffset);
      return ok({
        prContextId: context.id,
        source: 'manual',
        repository: context.repository,
        number: null,
        title: context.title ?? null,
        body: page.chunk,
        bodyNextOffset: page.nextOffset,
        labels: context.labels ?? [],
        base: null,
        head: null,
        changedFilesCount: pr.changedFiles.length,
        changedFilesSample: pr.changedFiles.slice(0, 100),
        limitations: context.limitations,
        untrustedFields: ['/title', '/body', '/labels/*', '/changedFilesSample/*/path'],
      });
    },

    async extract_requirements(input) {
      if (!deps.policy.ok) return policyUnavailable();
      const context = await ports.prContexts.get(input.prContextId);
      if (!context) return fail(toolError('E_NOT_FOUND', 'PR context not found', ['Call get_pr_context first']));
      const bad = input.agentRequirements.findIndex((r) => !r.testable && !r.nonTestableReason);
      if (bad >= 0)
        return fail(
          toolError('E_VALIDATION', 'nonTestableReason is required when testable is false', [], {
            issues: [
              { pointer: `/agentRequirements/${bad}/nonTestableReason`, message: 'required when testable is false' },
            ],
          }),
        );
      const cfg = deps.policy.policy.config;
      const gr02 = cfg.coverageGate.rules['GR-02'];
      const assembled = assembleRequirementSet({
        parsed: parsePrBody(context.body, context.title),
        agentRequirements: input.agentRequirements,
        agentAmbiguities: input.agentAmbiguities,
        agentAssumptions: input.agentAssumptions,
        mode: input.mode,
        riskPolicy: { thresholds: cfg.risk.thresholds, defaultFactors: cfg.risk.defaultFactors },
        observableVerbs: gr02.observableVerbs,
        vagueTerms: gr02.vagueTerms,
      });
      const hash = computeRequirementSetHash(assembled);
      let set = await ports.requirements.getByHash(hash, context.id);
      if (!set) {
        set = {
          id: ports.ids.newId('rqs'),
          schemaVersion: 1,
          createdAt: iso(ports.clock.now()),
          prContextId: context.id,
          requirements: assembled.requirements,
          ambiguities: assembled.ambiguities,
          assumptions: assembled.assumptions,
          requirementSetHash: hash,
        } satisfies RequirementSet;
        await ports.requirements.put(set);
      }
      return ok({
        requirementSetId: set.id,
        requirementSetHash: set.requirementSetHash as `sha256:${string}`,
        requirements: fitList(
          set.requirements.map((r) => ({
            id: r.id,
            title: r.title,
            kind: r.kind,
            provenance: r.provenance,
            riskTier: r.riskTier,
            testable: r.testable,
            acIds: r.acceptanceCriteria.map((a) => a.id),
          })),
        ),
        ambiguities: set.ambiguities,
        assumptions: set.assumptions,
        parseReport: { ...assembled.parseReport, discarded: assembled.parseReport.discarded.slice(0, 20) },
        untrustedFields: [
          '/requirements/*/title',
          '/ambiguities/*/text',
          '/assumptions/*/text',
          '/parseReport/discarded/*/excerpt',
        ],
      });
    },

    async generate_test_plan(input) {
      if (!deps.policy.ok) return policyUnavailable();
      const policy = deps.policy.policy;
      const set = await ports.requirements.get(input.requirementSetId);
      if (!set) return fail(toolError('E_NOT_FOUND', 'requirement set not found', ['Call extract_requirements first']));
      const inventory = await ports.inventories.get(input.inventoryId);
      if (!inventory)
        return fail(toolError('E_NOT_FOUND', 'inventory not found', ['Call inspect_test_inventory first']));
      const context = await ports.prContexts.get(set.prContextId);
      const profile = await ports.profiles.get(inventory.profileId);
      if (!context || !profile) return fail(toolError('E_NOT_FOUND', 'PR context or project profile not found', []));
      if (context.repository.localPath !== profile.workspace.rootRealPath)
        return fail(
          toolError('E_REPO_MISMATCH', 'the inventory is from a different workspace than the PR context', [
            'Inspect the workspace the PR belongs to',
          ]),
        );
      let basePlan: TestPlan | undefined;
      if (input.basePlanId) {
        basePlan = await ports.plans.get(input.basePlanId);
        if (!basePlan) return fail(toolError('E_NOT_FOUND', 'base plan not found', []));
      }
      const ws = resolveWorkspace(deps, profile.workspace.allowlistEntryId);
      const usable = ws !== undefined && ws.realPath === profile.workspace.rootRealPath;
      const capabilities = new Map<string, CapabilityView | undefined>();
      const executables = new Map<string, boolean>();
      const exeRegistry = buildRegistry(nodeFsPort(), policy.config.executables);
      for (const adapterId of new Set(inventory.targets.map((t) => t.adapterId))) {
        const adapter = deps.registry.get(adapterId);
        capabilities.set(
          adapterId,
          adapter && usable
            ? await adapter.capabilities({ workspace: createWorkspaceReader(ws), host: deps.host })
            : undefined,
        );
        executables.set(
          adapterId,
          adapter
            ? executablesAllowed(
                adapter,
                inventory.targets.find((t) => t.adapterId === adapterId)!,
                exeRegistry.executables,
              )
            : false,
        );
      }
      const result = normalizePlan({
        draft: input.draft,
        platformsInScope: input.platformsInScope,
        requirementSet: set,
        inventory,
        ...(basePlan ? { basePlan } : {}),
        repository: context.repository,
        headSha: context.head?.sha ?? null,
        riskPolicyVersion: policy.riskPolicyVersion,
        eligibilityContext: (target) => ({
          capabilities: target ? capabilities.get(target.adapterId) : undefined,
          hostOs: deps.host.os,
          executableAvailable: target ? (executables.get(target.adapterId) ?? false) : false,
          deviceAvailable: false,
          readOnlyReference: !usable || ws.readOnlyReference,
          platformsInScope: input.platformsInScope,
        }),
        now: ports.clock.now(),
        exceptionMaxDays: policy.config.coverageGate.exceptionMaxDays,
        newPlanId: () => ports.ids.newId('plan'),
      });
      if (!result.ok)
        return fail(
          toolError(
            'E_VALIDATION',
            'the draft plan is invalid',
            ['Fix the fields listed in details.issues and retry'],
            { issues: result.issues },
          ),
        );

      let plan = result.plan;
      let created = false;
      if (!result.reused) {
        const existing = await ports.plans.getByHash(plan.planHash);
        if (existing) plan = existing;
        else {
          await ports.plans.put(plan);
          created = true;
        }
      }
      if (created) {
        const superseded = basePlan ? await ports.approvals.supersedeByPlanHash(basePlan.planHash) : 0;
        await ports.audit.append({
          ts: iso(ports.clock.now()),
          actor: 'agent',
          kind: 'plan.versioned',
          subjectRefs: [plan.id],
          data: { planId: plan.id, version: plan.version, planHash: plan.planHash, supersededApprovals: superseded },
        });
      }
      return ok(planOutput(plan, result.unresolvedTargets, result.warnings));
    },
  };
}

/** Dry resolution: does the adapter's spec for this target name an allowlisted, present executable? */
function executablesAllowed(
  adapter: PlatformAdapter,
  target: TestTarget,
  allowed: ReadonlyMap<string, unknown>,
): boolean {
  try {
    return adapter
      .buildExecution({ attemptNo: 1, targets: [target], options: { coverage: false, timeoutMs: 60_000 } })
      .every((s) => allowed.has(s.executable));
  } catch {
    return false;
  }
}

function planOutput(
  plan: TestPlan,
  unresolvedTargets: { clientKey: string; targetPath: string; reason: string }[],
  warnings: string[],
): ToolOutput<'generate_test_plan'> {
  const riskSummary: Record<RiskTier, number> = { R0: 0, R1: 0, R2: 0, R3: 0 };
  const ineligible: Record<string, number> = {};
  let eligible = 0;
  for (const c of plan.testCases) {
    riskSummary[c.riskTier]++;
    if (c.eligibility === 'eligible') eligible++;
    else {
      const reason = c.eligibility.slice('ineligible:'.length);
      ineligible[reason] = (ineligible[reason] ?? 0) + 1;
    }
  }
  const summaries = plan.testCases.map((c) => ({
    id: c.id,
    clientKey: c.clientKey ?? '',
    title: c.title,
    riskTier: c.riskTier,
    eligibility: c.eligibility,
    targetRef: c.targetRef,
    priority: c.priority,
  }));
  const shown = fitList(summaries.slice(0, 200), 12_000);
  const notes = [...warnings];
  if (shown.length < plan.testCases.length)
    notes.push(
      `testCases list shows ${shown.length} of ${plan.testCases.length}; the full plan is stored as ${plan.id} v${plan.version}`,
    );
  return {
    planId: plan.id,
    version: plan.version,
    planHash: plan.planHash as `v1:sha256:${string}`,
    hashVersion: 1,
    testCaseCount: plan.testCases.length,
    testCases: shown,
    riskSummary,
    eligibilitySummary: { eligible, ineligible },
    unresolvedTargets: fitList(unresolvedTargets.slice(0, 100), 3000),
    warnings: notes.slice(0, 50).map((w) => w.slice(0, 500)),
    supersedes: plan.supersedes ?? null,
    untrustedFields: ['/testCases/*/title', '/unresolvedTargets/*/targetPath'],
  };
}
