/**
 * Baseline runs (ANL-002; FR-047). `run_tests` with `baseline` runs the plan's targets at the base commit: the commit
 * is resolved in the workspace repository (never fetched), checked out into `<runDir>/baseline` as a detached git
 * worktree, and given the workspace's resolved dependencies when the adapter's lock files are identical at both
 * commits. Targets whose test file does not exist at the base commit are left out and reported as a limitation.
 * The authorization subject stays the workspace; only the execution root changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformAdapter } from '@autotest/adapter-sdk';
import { toolError, type Limitation, type TestPlan, type TestTarget, type ToolError } from '@autotest/core';
import {
  addBaselineWorktree,
  removeBaselineWorktree,
  resolveCommit,
  runPaths,
  type ExecPort,
  type GitContext,
} from '@autotest/execution';
import {
  buildRegistry,
  defaultPlanTargets,
  findWorkspace,
  nodeFsPort,
  resolvePlanTargets,
  resolveWorkspaces,
  type FsPort,
  type LoadedPolicy,
} from '@autotest/policy';
import type { WorkflowPorts } from './ports.ts';

export interface PreparedBaseline {
  readonly ref: string;
  readonly commit: string;
  /** Canonical worktree root. */
  readonly root: string;
  /** The targets to run (those whose file exists at the base commit). */
  readonly targetIds: readonly string[];
  readonly limitations: readonly Limitation[];
}

export interface BaselineDeps {
  readonly ports: WorkflowPorts;
  readonly policy: LoadedPolicy;
  readonly dataRoot: string;
  readonly adapterFor: (id: string) => PlatformAdapter | undefined;
  readonly fs?: FsPort;
  readonly execPort?: ExecPort;
}

type Prepared =
  { readonly ok: true; readonly value: PreparedBaseline } | { readonly ok: false; readonly error: ToolError };
const refused = (error: ToolError): Prepared => ({ ok: false, error });

function gitContext(d: BaselineDeps, workspaceRoot: string, runId: string): GitContext {
  const fsp = d.fs ?? nodeFsPort();
  return {
    fs: fsp,
    registry: buildRegistry(fsp, d.policy.config.executables),
    workspaceRoot,
    runDir: runPaths(d.dataRoot, runId).dir,
    ...(d.execPort ? { port: d.execPort } : {}),
  };
}

async function baseRef(d: BaselineDeps, plan: TestPlan, ref: string | undefined): Promise<string | undefined> {
  if (ref) return ref;
  const set = await d.ports.requirements.get(plan.requirementSetId);
  const pr = set && (await d.ports.prContexts.get(set.prContextId));
  return pr?.base?.sha;
}

/** Same bytes, or both absent. */
function sameFile(a: string, b: string): boolean {
  const ea = fs.existsSync(a);
  const eb = fs.existsSync(b);
  return ea === eb && (!ea || fs.readFileSync(a).equals(fs.readFileSync(b)));
}

/** Copies the adapter's resolved-dependency files into the worktree; refuses when the lock files differ. */
function shareDependencies(adapter: PlatformAdapter | undefined, wsRoot: string, root: string): ToolError | undefined {
  const deps = adapter?.baselineDependencies;
  if (!deps) return undefined;
  const changed = deps.lockFiles.filter((f) => !sameFile(path.join(wsRoot, f), path.join(root, f)));
  if (changed.length)
    return toolError(
      'E_PREREQUISITE_MISSING',
      `dependencies differ between the workspace and the base commit (${changed.join(', ')})`,
      ['A baseline run reuses the resolved dependencies, so it needs identical lock files; compare without a baseline'],
      { prerequisites: ['baseline_dependencies_differ'] },
    );
  for (const f of deps.copy) {
    const src = path.join(wsRoot, f);
    if (!fs.existsSync(src) || fs.lstatSync(src).isSymbolicLink()) continue;
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.copyFileSync(src, path.join(root, f));
  }
  return undefined;
}

/** Resolves, checks out and prepares the baseline worktree for a new run. On refusal nothing is left behind. */
export async function prepareBaseline(
  d: BaselineDeps,
  a: { readonly plan: TestPlan; readonly runId: string; readonly ref?: string; readonly targets?: readonly string[] },
): Promise<Prepared> {
  const fsp = d.fs ?? nodeFsPort();
  const ws = a.plan.repository.localPath
    ? findWorkspace(fsp, resolveWorkspaces(fsp, d.policy.config.workspaces), a.plan.repository.localPath)
    : undefined;
  if (!ws) return refused(toolError('E_POLICY_DENIED', "the plan's workspace is not allowlisted", []));
  const ref = await baseRef(d, a.plan, a.ref);
  if (!ref)
    return refused(
      toolError('E_VALIDATION', 'a baseline run needs a base ref', ['Pass baseline.ref (for example "origin/main")'], {
        issues: [{ pointer: '/baseline/ref', message: 'required for a PR context without a base commit' }],
      }),
    );
  const ctx = gitContext(d, ws.realPath, a.runId);
  if (!ctx.registry.executables.has('git'))
    return refused(
      toolError('E_POLICY_DENIED', 'git is not allowlisted', ['Add git under `executables` (`autotest setup`)']),
    );
  const commit = await resolveCommit(ctx, ref);
  if (!commit)
    return refused(
      toolError(
        'E_PREREQUISITE_MISSING',
        `the base ref is not a commit in the local repository`,
        ['AutoTest never fetches: run `git fetch` in the workspace yourself, then retry'],
        { prerequisites: ['baseline_ref_missing'] },
      ),
    );
  const wt = await addBaselineWorktree(ctx, commit);
  if (!wt.ok) {
    await removeBaselineWorktree(ctx);
    return refused(toolError('E_PREREQUISITE_MISSING', wt.reason, [], { prerequisites: ['baseline_checkout'] }));
  }
  const fail = async (error: ToolError): Promise<Prepared> => {
    await removeBaselineWorktree(ctx);
    return refused(error);
  };

  const inventory = await d.ports.inventories.get(a.plan.inventoryId);
  const ids = (a.targets?.length ? resolvePlanTargets(a.plan, a.targets) : defaultPlanTargets(a.plan)) ?? [];
  const targets = ids
    .map((id) => inventory?.targets.find((t) => t.id === id))
    .filter((t): t is TestTarget => t !== undefined);
  const present = targets.filter((t) => fs.existsSync(path.join(wt.root, t.path)));
  const missing = targets.filter((t) => !present.includes(t));
  if (present.length === 0)
    return fail(
      toolError('E_VALIDATION', 'none of the selected test files exists at the base commit', [
        'A baseline compares tests that exist on both sides',
      ]),
    );
  const depError = shareDependencies(d.adapterFor(present[0]!.adapterId), ws.realPath, wt.root);
  if (depError) return fail(depError);
  return {
    ok: true,
    value: {
      ref,
      commit,
      root: wt.root,
      targetIds: present.map((t) => t.id),
      limitations: missing.length
        ? [
            {
              code: 'baseline_target_missing',
              message: `${missing.length} selected test file(s) do not exist at the base commit and were not run`,
            },
          ]
        : [],
    },
  };
}

/** Removes a run's baseline worktree (end of run, refused run, cleanup). */
export async function releaseBaseline(
  d: Omit<BaselineDeps, 'adapterFor'>,
  a: { readonly workspaceRoot: string; readonly runId: string },
): Promise<boolean> {
  return removeBaselineWorktree(gitContext({ ...d, adapterFor: () => undefined }, a.workspaceRoot, a.runId));
}
