/**
 * TL-01 `get_pr_context` (manual mode, and GitHub mode since GH-002), TL-04 `extract_requirements` and TL-05 `generate_test_plan` use cases
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
import { fetchPullRequest, GitHubError, parseGitRemote } from '@autotest/github';
import fs from 'node:fs';
import path from 'node:path';
import type { GitHubAccess } from '../github.ts';

export interface PlanningDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly registry: AdapterRegistry;
  readonly host: HostInfo;
  /** GitHub access for `source: "github"` (GH-002); absent means GitHub mode is unavailable. */
  readonly github?: GitHubAccess;
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
        return githubContext(deps, input.workspace, input.github, input.bodyOffset);
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
          // FL-006: a device target is runnable when this host can provide an AutoTest-owned device of its kind.
          deviceAvailable: target
            ? deviceKindAvailable(target.requires.device, deps.host.os, exeRegistry.executables)
            : false,
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

/**
 * GitHub mode of TL-01 (GH-002). The PR must belong to the workspace's repository: `github` in the workspace config,
 * or the `origin` remote in its `.git/config` (read, never executed). Without either, the context records the
 * limitation `repository_unverified`. PR text goes through the same normalization and redaction as manual input.
 */
async function githubContext(
  deps: PlanningDeps,
  workspace: string,
  gh: { host?: string | undefined; owner: string; name: string; number: number },
  bodyOffset: number,
) {
  const { ports } = deps;
  const ws = resolveWorkspace(deps, workspace);
  if (!ws)
    return fail<ToolOutput<'get_pr_context'>>(
      toolError('E_WORKSPACE_NOT_ALLOWED', 'the workspace is not an allowlisted root', [
        'Add it to `workspaces` in ~/.autotest/config.yaml',
      ]),
    );
  if (!deps.github)
    return fail<ToolOutput<'get_pr_context'>>(
      toolError('E_CAPABILITY_UNAVAILABLE', 'GitHub access is not configured', []),
    );
  const host = gh.host ?? 'github.com';
  const limitations: { code: string; message: string }[] = [];
  let expected: { owner: string; name: string } | undefined =
    ws.github?.owner && ws.github.name ? { owner: ws.github.owner, name: ws.github.name } : undefined;
  if (!expected) {
    try {
      expected = parseGitRemote(fs.readFileSync(path.join(ws.realPath, '.git', 'config'), 'utf8'), host);
    } catch {
      expected = undefined;
    }
  }
  if (!expected)
    limitations.push({
      code: 'repository_unverified',
      message: 'the workspace has no GitHub remote to compare with the PR repository',
    });
  else if (
    expected.owner.toLowerCase() !== gh.owner.toLowerCase() ||
    expected.name.toLowerCase() !== gh.name.toLowerCase()
  )
    return fail<ToolOutput<'get_pr_context'>>(
      toolError(
        'E_REPO_MISMATCH',
        `the PR is in ${gh.owner}/${gh.name}, but workspace ${ws.id} is ${expected.owner}/${expected.name}`,
        ['Use the workspace of that repository'],
      ),
    );
  let fetched;
  try {
    fetched = await fetchPullRequest(deps.github.client(host), { owner: gh.owner, name: gh.name, number: gh.number });
  } catch (e) {
    if (e instanceof GitHubError)
      return fail<ToolOutput<'get_pr_context'>>(
        toolError(e.code, e.message, e.code === 'E_GITHUB_AUTH' ? ['Run `gh auth login`, then `autotest doctor`'] : []),
      );
    throw e;
  }
  const pr = normalizeManualPr({
    title: fetched.title,
    body: fetched.body.trim() ? fetched.body : '(empty PR description)',
    labels: fetched.labels,
    changedFiles: fetched.changedFiles.map((f) => f.path),
  });
  const detail = new Map(fetched.changedFiles.map((f) => [f.path, f]));
  const changedFiles = pr.changedFiles.map((f) => {
    const d = detail.get(f.path);
    return d ? { path: f.path, status: d.status, additions: d.additions, deletions: d.deletions } : f;
  });
  if (fetched.filesTruncated)
    limitations.push({
      code: 'changed_files_truncated',
      message: `only the first ${changedFiles.length} changed files were fetched`,
    });
  if (!fetched.body.trim()) limitations.push({ code: 'empty_description', message: 'the PR has no description' });
  const sha = (s: string) => (/^[0-9a-f]{40}$/.test(s) ? { sha: s } : {});
  const context: PRContext = {
    id: ports.ids.newId('prc'),
    schemaVersion: 1,
    createdAt: iso(ports.clock.now()),
    source: 'github',
    repository: { host, owner: gh.owner, name: gh.name, localPath: ws.realPath },
    number: gh.number,
    ...(pr.title ? { title: pr.title } : {}),
    body: pr.body,
    ...(pr.labels.length ? { labels: pr.labels } : {}),
    ...(fetched.base.ref ? { base: { ref: fetched.base.ref.slice(0, 255), ...sha(fetched.base.sha) } } : {}),
    ...(fetched.head.ref ? { head: { ref: fetched.head.ref.slice(0, 255), ...sha(fetched.head.sha) } } : {}),
    changedFiles,
    limitations: [...pr.limitations, ...limitations],
    untrustedFields: ['/title', '/body', '/labels'],
  };
  await ports.prContexts.put(context);
  const page = pageBody(context.body, bodyOffset);
  return ok<ToolOutput<'get_pr_context'>>({
    prContextId: context.id,
    source: 'github',
    repository: context.repository,
    number: gh.number,
    title: context.title ?? null,
    body: page.chunk,
    bodyNextOffset: page.nextOffset,
    labels: context.labels ?? [],
    base: context.base ?? null,
    head: context.head ?? null,
    changedFilesCount: changedFiles.length,
    changedFilesSample: changedFiles.slice(0, 100),
    limitations: context.limitations,
    untrustedFields: ['/title', '/body', '/labels/*', '/changedFilesSample/*/path'],
  });
}

/** Whether this host can create and run the device kind a target needs (simctl on macOS; emulator + adb). */
function deviceKindAvailable(
  need: 'none' | 'simulator' | 'emulator' | 'physical',
  hostOs: string,
  executables: ReadonlyMap<string, unknown>,
): boolean {
  if (need === 'simulator') return hostOs === 'macos' && executables.has('xcrun');
  if (need === 'emulator') return executables.has('emulator') && executables.has('adb');
  return false;
}
