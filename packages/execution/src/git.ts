/**
 * Baseline worktrees (ANL-002). A baseline run executes the plan at the base commit: git checks that commit out into
 * `<runDir>/baseline` as a detached worktree, the supervisor runs the tests there, and the worktree is removed when
 * the run ends. Every git call goes through the `git` argument schema (hooks off, no transport, no LFS smudge) and
 * the exec port; git never fetches, so the base commit must already be in the local repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ArgToken, ExecutionSpec } from '@autotest/core';
import { nodeExecPort, type ExecPort } from '@autotest/exec';
import { validateSpec, type FsPort, type Registry } from '@autotest/policy';

export const BASELINE_DIR = 'baseline';

const SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
];

export interface GitContext {
  readonly fs: FsPort;
  readonly registry: Registry;
  /** The repository (the workspace root). */
  readonly workspaceRoot: string;
  readonly runDir: string;
  readonly port?: ExecPort;
  readonly timeoutMs?: number;
}

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  /** First 2 KiB of stderr, for diagnostics. */
  readonly stderr: string;
}

const w = (value: string): ArgToken => ({ kind: 'word', value });

/** Validates and runs one git invocation; `denied` when policy refuses it (git not allowlisted, bad argument). */
export async function runGit(ctx: GitContext, args: readonly ArgToken[]): Promise<GitResult | 'denied'> {
  const spec: ExecutionSpec = {
    executable: 'git',
    args: [...SAFE.map(w), ...args],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: ctx.timeoutMs ?? 120_000,
    cancellation: 'process_group',
    requires: { host: 'any', device: 'none' },
  };
  const v = validateSpec(spec, {
    fs: ctx.fs,
    registry: ctx.registry,
    workspaceRoot: ctx.workspaceRoot,
    runDir: ctx.runDir,
    allowDependencyResolution: false,
    allowedClasses: ['probe', 'build_tool'],
  });
  if (!v.ok) return 'denied';
  const env = {
    PATH: `${path.dirname(v.executablePath)}:/usr/bin:/bin`,
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    // git reads no user configuration (aliases, credential helpers, includes): HOME points at an empty directory.
    HOME: path.join(ctx.runDir, '.git-home'),
  };
  fs.mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  const child = (ctx.port ?? nodeExecPort()).spawn({ file: v.executablePath, argv: v.argv, cwd: v.cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    if (stdout.length < 64 * 1024) stdout += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 2048) stderr += d.toString('utf8');
  });
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, spec.timeoutMs);
    child.on('error', () => resolve(127));
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  return { exitCode, stdout, stderr: stderr.slice(0, 2048) };
}

/** Resolves a ref to a full commit id in the workspace repository, or undefined. */
export async function resolveCommit(ctx: GitContext, ref: string): Promise<string | undefined> {
  const r = await runGit(ctx, [w('rev-parse'), w('--verify'), w('--quiet'), w(`${ref}^{commit}`)]);
  if (r === 'denied' || r.exitCode !== 0) return undefined;
  const sha = r.stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : undefined;
}

export type WorktreeResult =
  { readonly ok: true; readonly root: string } | { readonly ok: false; readonly reason: string };

/** Checks `commit` out into `<runDir>/baseline`. */
export async function addBaselineWorktree(ctx: GitContext, commit: string): Promise<WorktreeResult> {
  const r = await runGit(ctx, [
    w('worktree'),
    w('add'),
    w('--detach'),
    { kind: 'runPath', rel: BASELINE_DIR },
    w(commit),
  ]);
  if (r === 'denied') return { ok: false, reason: 'git is not allowlisted or the request was denied by policy' };
  if (r.exitCode !== 0) return { ok: false, reason: `git worktree add failed (exit ${r.exitCode})` };
  return { ok: true, root: fs.realpathSync(path.join(ctx.runDir, BASELINE_DIR)) };
}

/** Removes the baseline worktree and git's record of it. Returns true when nothing is left behind. */
export async function removeBaselineWorktree(ctx: GitContext): Promise<boolean> {
  const dir = path.join(ctx.runDir, BASELINE_DIR);
  if (fs.existsSync(dir))
    await runGit(ctx, [w('worktree'), w('remove'), w('--force'), { kind: 'runPath', rel: BASELINE_DIR }]);
  // A worktree git no longer knows about (or a half-created one) is deleted directly; it lives inside the run dir.
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  await runGit(ctx, [w('worktree'), w('prune')]);
  fs.rmSync(path.join(ctx.runDir, '.git-home'), { recursive: true, force: true });
  return !fs.existsSync(dir);
}
