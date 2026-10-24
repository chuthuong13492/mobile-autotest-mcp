/**
 * ANL-002 baseline runs and the known-failure registry, end to end through the server with the fake runner and a
 * real git repository: a test failing at both the base commit and the head is `pre_existing/baseline_failure`, a
 * known-failure entry makes a failure `pre_existing/known_failure`, the worktree never outlives the run, and the
 * refusals leave nothing behind.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import {
  composeRuns,
  HOST_ENV,
  runnablePlan,
  sc,
  setupRunData,
  waitTerminal,
} from '../../apps/mcp-server/test/runSetup.ts';

const GIT = fs.realpathSync(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
const git = (cwd: string, ...args: string[]) =>
  execFileSync(GIT, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const fake = (mode: string) => `// fake: ${mode}\nvoid main() {}\n`;
const err = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string; details?: { prerequisites?: string[] } } }).error;
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

/** Base commit (branch `base`): a fails, b passes. Head (checked out): a and b fail, c is new and passes. */
async function repo() {
  const f = setupRunData({ 'test/a_test.dart': 'fail', 'test/b_test.dart': 'pass' });
  fs.writeFileSync(path.join(f.ws, 'pubspec.lock'), 'packages: {}\n');
  fs.writeFileSync(path.join(f.ws, '.gitignore'), '.dart_tool/\n');
  git(f.ws, 'init', '-q', '-b', 'main');
  git(f.ws, 'add', '-A');
  git(f.ws, 'commit', '-qm', 'base');
  git(f.ws, 'branch', 'base');
  fs.writeFileSync(path.join(f.ws, 'test/b_test.dart'), fake('fail'));
  fs.writeFileSync(path.join(f.ws, 'test/c_test.dart'), fake('pass'));
  git(f.ws, 'add', '-A');
  git(f.ws, 'commit', '-qm', 'head');
  const cfg = path.join(f.data, 'config.yaml');
  fs.writeFileSync(
    cfg,
    fs
      .readFileSync(cfg, 'utf8')
      .replace('executables: { flutter: {', `executables: { git: { path: ${GIT} }, flutter: {`),
  );
  const c = await composeRuns(f.data);
  closers.push(() => c.close());
  const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart', 'test/c_test.dart']);
  return { f, c, plan };
}

type Analyses = { analyses: { resultId: string; class: string; subtype: string }[] };
async function classesByTest(c: Awaited<ReturnType<typeof composeRuns>>, runId: string) {
  const res = sc<{ results: { resultId: string; name: string; targetId: string }[] }>(
    await c.call('get_run_results', { runId, limit: 100 }),
  ).results;
  const an = sc<Analyses>(await c.call('analyze_test_failures', { runId })).analyses;
  return Object.fromEntries(
    an.map((a) => {
      const r = res.find((x) => x.resultId === a.resultId)!;
      return [r.targetId, `${a.class}/${a.subtype}`];
    }),
  );
}
const worktrees = (ws: string) => git(ws, 'worktree', 'list').split('\n').length;

describe('ANL-002 baseline runs', () => {
  it(
    'classifies a failure present at the base commit as pre_existing, and removes the worktree',
    { timeout: 60_000 },
    async () => {
      const { f, c, plan } = await repo();
      expect(plan.decision).toBe('pass');
      const head = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
      expect(await waitTerminal(c, head.runId)).toMatchObject({ state: 'completed' });

      const b = sc<{ runId: string; limitations: { code: string }[] }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, baseline: { ref: 'base' } }),
      );
      // c_test.dart does not exist at the base commit: it is left out and reported.
      expect(b.limitations.map((l) => l.code)).toEqual(['baseline_target_missing']);
      expect(await waitTerminal(c, b.runId)).toMatchObject({ state: 'completed' });
      const baseResults = sc<{ results: { name: string; outcome: string; targetId: string }[] }>(
        await c.call('get_run_results', { runId: b.runId, limit: 100 }),
      ).results;
      expect(baseResults.map((r) => r.outcome).sort()).toEqual(['failed', 'passed']);
      expect(fs.existsSync(path.join(f.data, 'runs', b.runId, 'baseline'))).toBe(false);
      expect(worktrees(f.ws)).toBe(1);

      const ids = Object.fromEntries(baseResults.map((r) => [r.outcome, r.targetId]));
      const classes = await classesByTest(c, head.runId);
      // a failed at the base commit too; b passed there, so its failure is new.
      expect(classes[ids['failed']!]).toBe('pre_existing/baseline_failure');
      expect(classes[ids['passed']!]).not.toMatch(/^pre_existing/);

      // A known-failure entry for b (added by a human with the CLI) changes its analysis on the next call.
      const out: string[] = [];
      const io: Io = {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        out: (s) => void out.push(s),
        err: (s) => void out.push(s),
        ask: async () => '',
      };
      const env = { env: { ...HOST_ENV, AUTOTEST_HOME: f.data } };
      const until = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      expect(
        await cli(
          ['known-failures', 'add', '--target', 'test/b_test.dart', '--name', '*', '--reason', 'tracked'].concat([
            '--link',
            'https://example.invalid/1',
            '--expires',
            until,
          ]),
          io,
          env,
        ),
      ).toBe(0);
      expect(out.join('\n')).toMatch(/Added KF-001 for TT-flutter-/);
      expect((await classesByTest(c, head.runId))[ids['passed']!]).toBe('pre_existing/known_failure');
      expect(await cli(['known-failures', 'remove', 'KF-001'], io, env)).toBe(0);
      expect((await classesByTest(c, head.runId))[ids['passed']!]).not.toMatch(/^pre_existing/);
    },
  );

  it(
    'refuses without a ref, with an unknown ref, or with different lock files, leaving no worktree',
    {
      timeout: 60_000,
    },
    async () => {
      const { f, c, plan } = await repo();
      const call = (baseline: Record<string, unknown>) =>
        c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, baseline });
      expect(err(await call({}))?.code).toBe('E_VALIDATION');
      const unknown = err(await call({ ref: 'no-such-branch' }));
      expect(unknown?.code).toBe('E_PREREQUISITE_MISSING');
      expect(unknown?.details?.prerequisites).toEqual(['baseline_ref_missing']);
      expect(err(await call({ ref: '--upload-pack=x' }))?.code).toBe('E_VALIDATION');

      fs.writeFileSync(path.join(f.ws, 'pubspec.lock'), 'packages: { changed: {} }\n');
      const differ = err(await call({ ref: 'base' }));
      expect(differ?.details?.prerequisites).toEqual(['baseline_dependencies_differ']);
      expect(worktrees(f.ws)).toBe(1);
      expect(fs.readdirSync(path.join(f.data, 'runs'))).toEqual([]);
    },
  );
});
