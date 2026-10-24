/**
 * OPS-006 resilience suite (NFR-005, FR-029; ADR-0007; T-16): fault injection against the real server and
 * supervisor with the fake runner. Every scenario checks the three acceptance criteria:
 * (1) no acknowledged record is lost, (2) no terminal state is misreported, (3) no foreign process is signalled.
 * Run alone with `pnpm test:resilience`; it is also part of `pnpm test`.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyAuditFiles } from '@autotest/storage';
import {
  allResults,
  composeRuns,
  HOST_ENV,
  runnablePlan,
  sc,
  setupRunData,
  waitRunning,
  waitTerminal,
} from '../apps/mcp-server/test/runSetup.ts';
import { composeServer } from '../apps/mcp-server/src/compose.ts';
import { startServer } from './stdioServer.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

/** An unrelated process in its own group: it must still be alive after every scenario (criterion 3). */
function bystander() {
  const p = spawn('/bin/sleep', ['600'], { detached: true, stdio: 'ignore' });
  p.unref();
  cleanups.push(() => void p.kill('SIGKILL'));
  return () => {
    try {
      process.kill(p.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
}
const auditKinds = (data: string) =>
  fs
    .readdirSync(path.join(data, 'audit'))
    .flatMap((f) =>
      fs
        .readFileSync(path.join(data, 'audit', f), 'utf8')
        .trim()
        .split('\n'),
    )
    .map((l) => (JSON.parse(l) as { kind: string }).kind);

describe('OPS-006 resilience', () => {
  it(
    'kill -9 of the server mid-run: the run finishes, a new server reports it, nothing acknowledged is lost',
    {
      timeout: 90_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'sleep 4000', 'test/b_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
      await c.close();
      const still = bystander();
      const s1 = await startServer(f.data, HOST_ENV);
      const { runId } = await s1.call<{ runId: string }>('run_tests', { planId: plan.planId, planHash: plan.planHash });
      s1.proc.kill('SIGKILL');
      await s1.exited;
      const s2 = await startServer(f.data, HOST_ENV);
      cleanups.push(() => void s2.proc.kill('SIGKILL'));
      let state = '';
      for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
        state = (await s2.call<{ state: string }>('get_run_status', { runId })).state;
        if (['completed', 'cancelled', 'timed_out', 'infra_error'].includes(state)) break;
      }
      expect(state).toBe('completed');
      const res = await s2.call<{ results: { outcome: string }[] }>('get_run_results', { runId, limit: 10 });
      expect(res.results.map((r) => r.outcome)).toEqual(['passed', 'passed']);
      expect(auditKinds(f.data)).toContain('run.created');
      expect(verifyAuditFiles(f.data)).toMatchObject({ ok: true });
      expect(still()).toBe(true);
    },
  );

  it(
    'client disconnect (stdin closed): the server exits cleanly and the detached run still completes',
    {
      timeout: 90_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'sleep 3000' });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/a_test.dart']);
      await c.close();
      const s1 = await startServer(f.data, HOST_ENV);
      const { runId } = await s1.call<{ runId: string }>('run_tests', { planId: plan.planId, planHash: plan.planHash });
      s1.proc.stdin!.end();
      expect(await s1.exited).toBe(0);
      const c2 = await composeRuns(f.data);
      cleanups.push(() => c2.close());
      expect(await waitTerminal(c2, runId, 60_000)).toMatchObject({ state: 'completed' });
    },
  );

  it(
    'kill -9 of the supervisor: infra_error(supervisor_lost), the runner group is stopped, no pass is invented',
    {
      timeout: 90_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'slow', 'test/b_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      cleanups.push(() => c.close());
      const still = bystander();
      const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
      const { runId } = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      );
      await waitRunning(c, runId);
      await new Promise((r) => setTimeout(r, 1000));
      const run = await c.ports.runs.get(runId);
      process.kill(run!.supervisor!.pid, 'SIGKILL');
      const s = await waitTerminal(c, runId, 60_000);
      expect(s).toMatchObject({ state: 'infra_error', infraReason: 'supervisor_lost' });
      const results = await allResults(c, runId);
      expect(results.some((r) => r.outcome === 'passed' && r.name.includes('slow'))).toBe(false);
      // The runner (`slow` sleeps 60 s) was in the run's process group and is gone.
      const runner = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
        .stdout.split('\n')
        .filter((l) => l.includes(f.base) && l.includes('a_test.dart'));
      expect(runner).toEqual([]);
      expect(still()).toBe(true);
    },
  );

  it(
    'SQLite locked by another writer: tool calls fail recoverably, then succeed; the audit chain stays valid',
    {
      timeout: 60_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'pass' });
      const c = await composeRuns(f.data);
      cleanups.push(() => c.close());
      const call = () =>
        c.call('get_pr_context', {
          workspace: 'ws_app',
          source: 'manual',
          manual: { title: 'x', body: '## Acceptance criteria\n- [ ] it shows "ok"\n' },
        });
      const lock = new DatabaseSync(path.join(f.data, 'autotest.db'));
      lock.exec('BEGIN EXCLUSIVE');
      const started = Date.now();
      const blocked = await call();
      const waited = Date.now() - started;
      lock.exec('ROLLBACK');
      lock.close();
      expect(blocked.isError).toBe(true);
      expect((blocked.structuredContent as { error: { code: string; recoverable: boolean } }).error).toMatchObject({
        code: 'E_STORAGE_UNAVAILABLE',
        recoverable: true,
      });
      expect(waited).toBeGreaterThanOrEqual(4000); // busy_timeout, not an instant failure
      const after = await call();
      expect(after.isError, JSON.stringify(after.structuredContent)).toBeFalsy();
      expect(verifyAuditFiles(f.data)).toMatchObject({ ok: true });
    },
  );

  it('a corrupted event log never changes a reported terminal state', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/a_test.dart': 'fail', 'test/b_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    cleanups.push(() => c.close());
    const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart']);
    const { runId } = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    );
    await waitTerminal(c, runId);
    const before = await allResults(c, runId);
    const events = path.join(f.data, 'runs', runId, 'events.ndjson');
    const lines = fs.readFileSync(events, 'utf8').split('\n');
    fs.writeFileSync(
      events,
      [lines[0], '{"t":"state","to":"completed"', '\u0000garbage', ...lines.slice(1)].join('\n'),
    );
    const c2 = await composeRuns(f.data);
    cleanups.push(() => c2.close());
    const s = sc<{ state: string }>(await c2.call('get_run_status', { runId }));
    expect(s.state).toBe('completed');
    expect(await allResults(c2, runId)).toEqual(before);
  });

  it(
    'clock skew: a server clock 2 h ahead neither expires a run early nor marks its supervisor lost',
    {
      timeout: 60_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'sleep 2000' });
      const ahead = { now: () => new Date(Date.now() + 2 * 3600_000) };
      const c = await composeServer({ dataRoot: f.data, env: HOST_ENV, stderr: { write: () => true }, clock: ahead });
      cleanups.push(() => c.close());
      const plan = await runnablePlan(c, ['test/a_test.dart']);
      const { runId } = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      );
      expect(await waitTerminal(c, runId, 60_000)).toMatchObject({ state: 'completed' });
      expect((await allResults(c, runId)).map((r) => r.outcome)).toEqual(['passed']);
    },
  );

  const canMount = process.platform === 'darwin' && fs.existsSync('/usr/bin/hdiutil');
  it.skipIf(!canMount)(
    'disk full under the data root: the run never reports passes it did not record; the index stays healthy',
    {
      timeout: 120_000,
    },
    async () => {
      const f = setupRunData({ 'test/a_test.dart': 'flood 60' });
      // A 40 MiB volume for the data root; the workspace stays on the normal disk.
      const vol = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-full-')));
      const img = path.join(vol, 'full.dmg');
      const mnt = path.join(vol, 'mnt');
      fs.mkdirSync(mnt);
      spawnSync('/usr/bin/hdiutil', ['create', '-size', '40m', '-fs', 'HFS+', '-volname', 'atfull', '-quiet', img]);
      expect(spawnSync('/usr/bin/hdiutil', ['attach', img, '-mountpoint', mnt, '-nobrowse', '-quiet']).status).toBe(0);
      cleanups.push(() => void spawnSync('/usr/bin/hdiutil', ['detach', mnt, '-force', '-quiet']));
      const data = path.join(mnt, 'data');
      fs.mkdirSync(data, { mode: 0o700 });
      fs.copyFileSync(path.join(f.data, 'config.yaml'), path.join(data, 'config.yaml'));
      const c = await composeRuns(data);
      cleanups.push(() => c.close());
      const plan = await runnablePlan(c, ['test/a_test.dart']);
      // Ballast: freed by the "operator" once the server reports that storage is unavailable.
      const ballast = path.join(mnt, 'ballast');
      fs.writeFileSync(ballast, Buffer.alloc(8 * 1024 * 1024));
      const { runId } = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      );
      let state = '';
      let sawUnavailable = false;
      for (const end = Date.now() + 100_000; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
        const r = await c.call('get_run_status', { runId });
        const err = (r.structuredContent as { error?: { code: string } }).error;
        if (err) {
          // While the disk is full nothing is answered from unrecorded state: calls fail closed.
          expect(err.code).toBe('E_STORAGE_UNAVAILABLE');
          sawUnavailable = true;
          fs.rmSync(ballast, { force: true });
          continue;
        }
        state = (r.structuredContent as { state: string }).state;
        if (['completed', 'cancelled', 'timed_out', 'infra_error'].includes(state)) break;
      }
      expect(['completed', 'cancelled', 'timed_out', 'infra_error']).toContain(state);
      // 60 MiB of output cannot fit: whatever the terminal state, it is not a pass recorded from nothing.
      const results = await allResults(c, runId);
      if (state === 'completed') expect(results.map((r) => r.outcome)).toEqual(['passed']);
      else expect(results.every((r) => r.outcome !== 'passed')).toBe(true);
      console.log(`disk-full scenario: terminal ${state}, storage unavailable seen: ${sawUnavailable}`);
      const db = new DatabaseSync(path.join(data, 'autotest.db'));
      expect((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check).toBe('ok');
      db.close();
      expect(verifyAuditFiles(data), JSON.stringify(verifyAuditFiles(data))).toMatchObject({ ok: true });
    },
  );
});
