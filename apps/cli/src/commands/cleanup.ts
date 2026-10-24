/**
 * `autotest cleanup [--dry-run]` (CLI-003; operations §5): reconciles runs left by a stopped server (without
 * starting queued runs), applies retention (EVD-003) and removes per-run scratch directories older than 24 h whose
 * run is terminal or unknown, and baseline worktrees (ANL-002) of terminal runs. The dry run prints exactly what a
 * real run deletes. Devices arrive with v1.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isTerminal } from '@autotest/core';
import { applyRetention, measureRun, planRetention, type RetentionRun } from '@autotest/evidence';
import { finishBaseline, reconcileRuns, type RunDeps } from '@autotest/workflow';
import { cliRegistry } from '../adapters.ts';
import type { CliContext } from '../context.ts';
import type { Io } from '../io.ts';

const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = 86_400_000;

export interface CleanupPlan {
  readonly retention: ReturnType<typeof planRetention>;
  readonly scratch: readonly string[];
  /** Terminal runs whose baseline worktree is still on disk. */
  readonly worktrees: readonly string[];
}

export async function planCleanup(ctx: CliContext, now: Date): Promise<CleanupPlan> {
  if (!ctx.policy.ok) throw new Error('policy unavailable');
  const runsDir = path.join(ctx.dataRoot, 'runs');
  const runs: RetentionRun[] = [];
  const worktrees: string[] = [];
  for (const id of fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter((n) => RUN_ID.test(n))
        .sort()
    : []) {
    const run = await ctx.ports.runs.get(id);
    if (run && isTerminal(run.state) && fs.existsSync(path.join(runsDir, id, 'baseline'))) worktrees.push(id);
    const m = measureRun(path.join(runsDir, id));
    runs.push({
      runId: id,
      terminal: run ? isTerminal(run.state) : false,
      ...(run?.endedAt ? { endedAt: run.endedAt } : {}),
      ...m,
    });
  }
  const retention = planRetention(runs, now, ctx.policy.policy.config.retention);
  const tmpDir = path.join(ctx.dataRoot, 'tmp');
  const scratch: string[] = [];
  for (const id of fs.existsSync(tmpDir)
    ? fs
        .readdirSync(tmpDir)
        .filter((n) => RUN_ID.test(n))
        .sort()
    : []) {
    const run = await ctx.ports.runs.get(id);
    const age = now.getTime() - fs.statSync(path.join(tmpDir, id)).mtimeMs;
    if ((!run || isTerminal(run.state)) && age > DAY) scratch.push(id);
  }
  return { retention, scratch, worktrees };
}

export async function cleanup(ctx: CliContext, io: Io, flags: readonly string[]): Promise<number> {
  if (!ctx.policy.ok) {
    io.err('The policy (config.yaml) is missing or invalid; run `autotest doctor`.');
    return 1;
  }
  const dryRun = flags.includes('--dry-run');
  const deps: RunDeps = {
    ports: ctx.ports,
    policy: ctx.policy,
    registry: cliRegistry(),
    serverEnvironment: ctx.environment,
    dataRoot: ctx.dataRoot,
    host: { os: process.platform === 'darwin' ? 'macos' : 'linux' },
  };
  if (!dryRun) {
    const actions = await reconcileRuns(deps, { pump: false });
    for (const [runId, action] of Object.entries(actions))
      if (action !== 'queued' && action !== 'reattach') io.out(`reconciled ${runId}: ${action}`);
  }
  const plan = await planCleanup(ctx, ctx.ports.clock.now());
  const verb = dryRun ? 'would remove' : 'removed';
  for (const a of plan.retention)
    io.out(`${verb} ${a.scope.replace('_', ' ')} of ${a.runId} (${a.reason}, ${a.bytes} bytes)`);
  for (const id of plan.scratch) io.out(`${verb} scratch directory tmp/${id}`);
  for (const id of plan.worktrees) io.out(`${verb} baseline worktree of ${id}`);
  if (!dryRun) {
    // Worktrees first: retention may delete the run directory that holds one, and git must forget it.
    for (const id of plan.worktrees) await finishBaseline(deps, id);
    applyRetention(ctx.dataRoot, plan.retention);
    for (const id of plan.scratch) fs.rmSync(path.join(ctx.dataRoot, 'tmp', id), { recursive: true, force: true });
  }
  if (plan.retention.length === 0 && plan.scratch.length === 0 && plan.worktrees.length === 0)
    io.out('Nothing to clean up.');
  return 0;
}
