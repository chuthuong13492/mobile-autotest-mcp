import { describe, expect, it } from 'vitest';
import { allResults, composeRuns, runnablePlan, sc, setupRunData, waitTerminal } from './runSetup.ts';

describe('RUN-001 – RUN-003 a passing run end to end', () => {
  it('authorizes, queues, dispatches, runs, imports results and audits', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
    expect(plan.decision).toBe('pass');
    const r = await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const run = sc<{ runId: string; state: string; targetsCount: number }>(r);
    expect(run).toMatchObject({ state: 'queued', targetsCount: 2 });
    const s = await waitTerminal(c, run.runId);
    expect(s).toMatchObject({ state: 'completed', statusCategory: 'completed' });
    const results = await allResults(c, run.runId);
    expect(results.map((x) => [x.name, x.outcome, x.attemptNo])).toEqual([
      ['pass test', 'passed', 1],
      ['pass test', 'passed', 1],
    ]);
    expect(results.every((x) => x.testCaseIds.length === 1)).toBe(true);
    const kinds = (await c.ports.audit.readAll()).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'authorization.decision')).toHaveLength(2);
    expect(kinds).toContain('run.created');
    const decisions = await c.ports.authorizations.listByRun(run.runId);
    expect(decisions.map((d) => [d.phase, d.result])).toEqual([
      ['create', 'authorized'],
      ['dispatch', 'authorized'],
    ]);
    await c.close();
  });
});

type Composed = Awaited<ReturnType<typeof composeRuns>>;

async function approve(c: Composed, planId: string, planHash: string) {
  const { grantApproval } = await import('@autotest/workflow');
  const req = sc<{ approvalRequestId: string }>(
    await c.call('request_approval', {
      scope: { kind: 'plan_execution', planId, planHash },
      justification: 'review',
      offerElicitation: false,
    }),
  );
  const request = (await c.ports.approvals.getRequest(req.approvalRequestId))!;
  if (!c.policy.ok) throw new Error('policy');
  const g = await grantApproval(c.ports, {
    request,
    source: 'cli',
    assurance: 'AL2',
    approver: { osUser: 'tester' },
    environment: 'local:test-host',
    policyVersion: c.policy.policy.policyVersion,
    actor: 'cli',
  });
  if (!g.ok) throw new Error(g.error.error.message);
  return g.approval;
}

const err = (r: { isError?: boolean; structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string; details?: { reasons?: string[] } } }).error;

describe('RUN-005 bounded retry and flaky labelling', () => {
  it(
    'a flaky test passes on attempt 2 and is labelled; real failures are retried once; load errors never',
    { timeout: 60_000 },
    async () => {
      const f = setupRunData({
        'test/flaky_test.dart': 'flaky',
        'test/fail_test.dart': 'fail',
        'test/broken_test.dart': 'load_error',
        'test/ok_test.dart': 'pass',
      });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, [
        'test/flaky_test.dart',
        'test/fail_test.dart',
        'test/broken_test.dart',
        'test/ok_test.dart',
      ]);
      const run = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
      expect(await waitTerminal(c, run.runId)).toMatchObject({ state: 'completed' });
      const by = Object.fromEntries(
        (await allResults(c, run.runId)).map((r) => [r.name, [r.outcome, r.flaky, r.attemptNo, r.failureKind]]),
      );
      expect(by).toEqual({
        'flaky test': ['passed', true, 2, null],
        'fail test': ['failed', false, 2, 'assertion'],
        'loading test/broken_test.dart': ['failed', false, 1, 'load_error'],
        'pass test': ['passed', false, 1, null],
      });
      const status = sc<{ progress: { attemptsStarted: number; attemptsFinished: number } }>(
        await c.call('get_run_status', { runId: run.runId }),
      );
      expect(status.progress).toMatchObject({ attemptsStarted: 2, attemptsFinished: 2 });
      expect((await allResults(c, run.runId, 200)).length).toBe(4);
      const flakyOnly = sc<{ results: unknown[] }>(
        await c.call('get_run_results', { runId: run.runId, filter: { flakyOnly: true } }),
      );
      expect(flakyOnly.results).toHaveLength(1);
      await c.close();
    },
  );

  it('retry.maxAttempts 1 disables retries; more than policy allows is refused', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/flaky_test.dart': 'flaky', 'test/ok_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/flaky_test.dart', 'test/ok_test.dart']);
    expect(
      err(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, retry: { maxAttempts: 3 } }))?.code,
    ).toBe('E_POLICY_DENIED');
    const run = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, retry: { maxAttempts: 1 } }),
    );
    await waitTerminal(c, run.runId);
    expect((await allResults(c, run.runId)).find((r) => r.name === 'flaky test')).toMatchObject({
      outcome: 'failed',
      attemptNo: 1,
    });
    await c.close();
  });
});

describe('RUN-004 cancellation', () => {
  it(
    'cancels a running test; SIGTERM-ignoring runners are killed; cancel is idempotent',
    { timeout: 90_000 },
    async () => {
      const { waitRunning } = await import('./runSetup.ts');
      for (const mode of ['slow', 'ignore-term']) {
        const f = setupRunData({ 'test/a_test.dart': mode, 'test/b_test.dart': 'pass' });
        const c = await composeRuns(f.data);
        const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
        const run = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
        await waitRunning(c, run.runId);
        await new Promise((r) => setTimeout(r, 500));
        const cancel = sc<{ alreadyTerminal: boolean }>(
          await c.call('cancel_test_run', { runId: run.runId, reason: 'stop' }),
        );
        expect(cancel.alreadyTerminal).toBe(false);
        const t0 = Date.now();
        expect(await waitTerminal(c, run.runId, 30_000)).toMatchObject({ state: 'cancelled', cancelReason: 'user' });
        expect(Date.now() - t0).toBeLessThan(20_000);
        const results = await allResults(c, run.runId);
        expect(results.some((r) => r.outcome === 'passed')).toBe(false);
        expect(results.some((r) => r.outcome === 'cancelled')).toBe(true);
        expect(
          sc<{ alreadyTerminal: boolean; state: string }>(await c.call('cancel_test_run', { runId: run.runId })),
        ).toMatchObject({
          alreadyTerminal: true,
          state: 'cancelled',
        });
        await c.close();
      }
    },
  );

  it('an unknown run is E_RUN_NOT_FOUND for every run tool', async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    for (const tool of ['get_run_status', 'get_run_results', 'cancel_test_run'] as const)
      expect(err(await c.call(tool, { runId: 'run_01JCAAAAAAAAAAAAAAAAAAAAAA' }))?.code).toBe('E_RUN_NOT_FOUND');
    await c.close();
  });
});

describe('RUN-001/002 authorization at creation and dispatch', () => {
  it('denials map to their error codes and are persisted', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const review = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart'], { weak: true });
    expect(review.decision).toBe('needs_review');
    const denied = err(await c.call('run_tests', { planId: review.planId, planHash: review.planHash }));
    expect(denied).toMatchObject({ code: 'E_APPROVAL_REQUIRED', details: { reasons: ['approval_required'] } });
    expect(
      err(await c.call('run_tests', { planId: review.planId, planHash: `v1:sha256:${'0'.repeat(64)}` }))?.code,
    ).toBe('E_PLAN_HASH_MISMATCH');
    expect(
      err(await c.call('run_tests', { planId: 'plan_01JCAAAAAAAAAAAAAAAAAAAAAA', planHash: review.planHash }))?.code,
    ).toBe('E_PLAN_NOT_FOUND');
    expect(
      err(await c.call('run_tests', { planId: review.planId, planHash: review.planHash, targets: ['TC-099'] }))?.code,
    ).toBe('E_POLICY_DENIED');
    expect(
      err(await c.call('run_tests', { planId: review.planId, planHash: review.planHash, devices: ['emulator-5554'] }))
        ?.code,
    ).toBe('E_CAPABILITY_UNAVAILABLE');
    const kinds = (await c.ports.audit.readAll()).filter((e) => e.kind === 'authorization.decision');
    expect(kinds.length).toBeGreaterThanOrEqual(2);
    await c.close();
  });

  it('missing dependencies refuse the run with E_PREREQUISITE_MISSING', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' }, { resolved: false });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/a_test.dart']);
    const e = err(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    expect(e).toMatchObject({ code: 'E_PREREQUISITE_MISSING', details: { prerequisites: ['pub_get'] } });
    await c.close();
  });

  it(
    'an approved needs_review run consumes its approval at dispatch, not creation; revoking before dispatch cancels',
    { timeout: 90_000 },
    async () => {
      const f = setupRunData(
        { 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass', 'test/slow_test.dart': 'slow' },
        { extraConfig: '' },
      );
      const c = await composeRuns(f.data);
      const blocker = await runnablePlan(c, ['test/slow_test.dart']);
      const review = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart'], { weak: true });
      const approval = await approve(c, review.planId, review.planHash);
      // Occupy the only slot so the approved run stays queued.
      const slow = sc<{ runId: string }>(
        await c.call('run_tests', { planId: blocker.planId, planHash: blocker.planHash }),
      );
      const queued = sc<{ runId: string; queuePosition: number }>(
        await c.call('run_tests', { planId: review.planId, planHash: review.planHash }),
      );
      expect(queued.queuePosition).toBe(1);
      expect((await c.ports.approvals.getApproval(approval.id))?.uses).toBe(0);
      // Cancelling a queued run never consumes the approval.
      await c.call('cancel_test_run', { runId: queued.runId });
      expect(await waitTerminal(c, queued.runId)).toMatchObject({ state: 'cancelled' });
      expect((await c.ports.approvals.getApproval(approval.id))?.uses).toBe(0);
      // A second queued run, then a revocation before dispatch.
      const second = sc<{ runId: string }>(
        await c.call('run_tests', { planId: review.planId, planHash: review.planHash }),
      );
      await c.ports.approvals.revoke(approval.id, 'tester', new Date());
      await c.call('cancel_test_run', { runId: slow.runId });
      await waitTerminal(c, slow.runId, 30_000);
      expect(await waitTerminal(c, second.runId, 30_000)).toMatchObject({
        state: 'cancelled',
        cancelReason: 'authorization_invalidated',
      });
      const decisions = await c.ports.authorizations.listByRun(second.runId);
      expect(decisions.map((d) => [d.phase, d.result])).toEqual([
        ['create', 'authorized'],
        ['dispatch', 'denied'],
      ]);
      expect(decisions[1]!.reasons).toContain('approval_revoked');
      // With a fresh approval the run goes through and consumes one use at dispatch.
      const fresh = await approve(c, review.planId, review.planHash);
      const ok = sc<{ runId: string }>(await c.call('run_tests', { planId: review.planId, planHash: review.planHash }));
      expect(await waitTerminal(c, ok.runId)).toMatchObject({ state: 'completed' });
      expect((await c.ports.approvals.getApproval(fresh.id))?.uses).toBe(1);
      expect((await c.ports.audit.readAll()).some((e) => e.kind === 'approval.consumed')).toBe(true);
      await c.close();
    },
  );

  it('a new plan version between create and dispatch cancels the queued run', { timeout: 90_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/slow_test.dart': 'slow' });
    const c = await composeRuns(f.data);
    const blocker = await runnablePlan(c, ['test/slow_test.dart']);
    const plan = await runnablePlan(c, ['test/a_test.dart']);
    const slow = sc<{ runId: string }>(
      await c.call('run_tests', { planId: blocker.planId, planHash: blocker.planHash }),
    );
    const queued = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    // Edit the plan: a new version supersedes the queued run's version.
    const stored = (await c.ports.plans.getByHash(plan.planHash))!;
    const inventory = (await c.ports.inventories.get(stored.inventoryId))!;
    const pathOf = (ref: string | null) => inventory.targets.find((x) => x.id === ref)?.path;
    const edited = await c.call('generate_test_plan', {
      basePlanId: plan.planId,
      requirementSetId: stored.requirementSetId,
      inventoryId: stored.inventoryId,
      platformsInScope: ['host'],
      draft: {
        testCases: stored.testCases.map((tc) => ({
          clientKey: tc.clientKey,
          title: `${tc.title} (edited)`,
          requirementRefs: tc.requirementRefs,
          acRefs: tc.acRefs,
          level: tc.level,
          technique: tc.technique,
          priority: tc.priority,
          platforms: tc.platforms,
          steps: tc.steps,
          expectedResults: tc.expectedResults,
          targetPath: pathOf(tc.targetRef),
          automation: tc.automation,
        })),
      },
    });
    expect(edited.isError, JSON.stringify(edited.structuredContent)).toBeFalsy();
    await c.call('cancel_test_run', { runId: slow.runId });
    expect(await waitTerminal(c, queued.runId, 30_000)).toMatchObject({
      state: 'cancelled',
      cancelReason: 'authorization_invalidated',
    });
    const decisions = await c.ports.authorizations.listByRun(queued.runId);
    expect(decisions[1]!.reasons).toContain('superseded');
    await c.close();
  });

  it(
    'idempotency keys return the same run, and a different request with the key conflicts',
    { timeout: 60_000 },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
      const a = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k-1' }),
      );
      const b = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, idempotencyKey: 'k-1' }),
      );
      expect(b.runId).toBe(a.runId);
      const conflict = err(
        await c.call('run_tests', {
          planId: plan.planId,
          planHash: plan.planHash,
          idempotencyKey: 'k-1',
          retry: { maxAttempts: 1 },
        }),
      );
      expect(conflict?.code).toBe('E_IDEMPOTENCY_CONFLICT');
      await waitTerminal(c, a.runId);
      await c.close();
    },
  );
});

describe('RUN-003 result paging', () => {
  it('2,000 results page out exactly once each', { timeout: 90_000 }, async () => {
    const f = setupRunData({ 'test/many_test.dart': 'many 2000', 'test/b_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/many_test.dart', 'test/b_test.dart']);
    const run = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    await waitTerminal(c, run.runId);
    const all = await allResults(c, run.runId, 137);
    expect(all).toHaveLength(2001);
    expect(new Set(all.map((r) => r.resultId)).size).toBe(2001);
    const failed = sc<{ results: unknown[]; totals: Record<string, number> }>(
      await c.call('get_run_results', { runId: run.runId, filter: { outcomes: ['failed'] } }),
    );
    expect(failed.results).toEqual([]);
    expect(failed.totals).toEqual({ passed: 2001 });
    await c.close();
  });
});

describe('RUN-006 restart reconciliation', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const runnerPid = async (c: Composed, runId: string) => {
    const { readRunFiles } = await import('@autotest/execution');
    for (let i = 0; i < 100; i++) {
      const start = readRunFiles(c.dataRoot, runId).events.events.find((e) => e.t === 'process.start');
      if (start && start.t === 'process.start') return start.pid;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('runner never started');
  };

  it('a server restart mid-run reattaches; the run finishes on its own', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass' });
    const c1 = await composeRuns(f.data);
    const plan = await runnablePlan(c1, ['test/a_test.dart', 'test/b_test.dart']);
    const run = sc<{ runId: string }>(await c1.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    await c1.close();
    const c2 = await composeRuns(f.data);
    expect(await waitTerminal(c2, run.runId)).toMatchObject({ state: 'completed' });
    await c2.close();
  });

  it(
    'a supervisor killed with SIGKILL: its runner is stopped and the run ends supervisor_lost',
    { timeout: 60_000 },
    async () => {
      const { waitRunning } = await import('./runSetup.ts');
      const f = setupRunData({ 'test/slow_test.dart': 'slow' });
      const c1 = await composeRuns(f.data);
      const plan = await runnablePlan(c1, ['test/slow_test.dart']);
      const run = sc<{ runId: string }>(await c1.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
      await waitRunning(c1, run.runId);
      const runner = await runnerPid(c1, run.runId);
      const supervisor = (await c1.ports.runs.get(run.runId))!.supervisor!;
      await c1.close();
      process.kill(supervisor.pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      expect(alive(runner)).toBe(true);
      const c2 = await composeRuns(f.data);
      expect(
        sc<{ state: string; infraReason: string }>(await c2.call('get_run_status', { runId: run.runId })),
      ).toMatchObject({
        state: 'infra_error',
        infraReason: 'supervisor_lost',
      });
      expect(alive(runner)).toBe(false);
      expect((await allResults(c2, run.runId)).map((r) => r.outcome)).toEqual(['not_run']);
      expect((await c2.ports.audit.readAll()).some((e) => e.kind === 'reconciliation.action')).toBe(true);
      await c2.close();
    },
  );

  it('a sync between the terminal event and terminal.json still records endedAt', { timeout: 60_000 }, async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/a_test.dart']);
    const { runId } = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    );
    await waitTerminal(c, runId);
    // Rewind to the moment the supervisor had appended its terminal state event but not yet written terminal.json.
    await c.ports.runs.update(runId, {
      state: 'running',
      statusCategory: 'running',
      endedAt: undefined,
      supervisor: undefined,
    });
    fs.rmSync(path.join(f.data, 'runs', runId, 'terminal.json'));
    expect(sc<{ state: string; endedAt: string | null }>(await c.call('get_run_status', { runId }))).toMatchObject({
      state: 'completed',
      endedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    await c.close();
  });

  it('without a restart, get_run_status notices a dead supervisor', { timeout: 60_000 }, async () => {
    const { waitRunning } = await import('./runSetup.ts');
    const f = setupRunData({ 'test/slow_test.dart': 'slow' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/slow_test.dart']);
    const run = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
    await waitRunning(c, run.runId);
    const runner = await runnerPid(c, run.runId);
    process.kill((await c.ports.runs.get(run.runId))!.supervisor!.pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    expect(await waitTerminal(c, run.runId)).toMatchObject({ state: 'infra_error', infraReason: 'supervisor_lost' });
    expect(alive(runner)).toBe(false);
    await c.close();
  });

  it('an unverifiable supervisor identity is never signalled: orphan_unverified', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c1 = await composeRuns(f.data, { background: false });
    const plan = await runnablePlan(c1, ['test/a_test.dart']);
    const created = await c1.call('run_tests', { planId: plan.planId, planHash: plan.planHash });
    const runId = sc<{ runId: string }>(created).runId;
    await waitTerminal(c1, runId);
    // Simulate a run whose supervisor could not be identified and left no terminal record.
    const { runPaths } = await import('@autotest/execution');
    const fs = await import('node:fs');
    fs.rmSync(runPaths(c1.dataRoot, runId).terminal);
    await c1.ports.runs.update(runId, {
      state: 'running',
      statusCategory: 'running',
      supervisor: { pid: 1, pgid: 1, startTime: 'unknown' },
    });
    await c1.close();
    const c2 = await composeRuns(f.data);
    expect(await c2.ports.runs.get(runId)).toMatchObject({ state: 'infra_error', infraReason: 'orphan_unverified' });
    await c2.close();
  });
});
