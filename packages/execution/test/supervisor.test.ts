import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunEvent } from '@autotest/core';
import { checkIdentity, launchDetachedNode, nodeExecPort, type ExecPort } from '@autotest/exec';
import {
  atomicWriteJson,
  defaultHooks,
  launchSupervisor,
  readEvents,
  readRunFiles,
  requestCancel,
  runPaths,
  runSupervisor,
  writeRunHeader,
  type RunHeader,
} from '@autotest/execution';
import { env, header, runId, spec, until } from './helpers.ts';

const states = (dataRoot: string, id: string) =>
  readEvents(runPaths(dataRoot, id).events).events.flatMap((e) => (e.t === 'state' ? [e.to] : []));
const cancelStages = (dataRoot: string, id: string) =>
  readEvents(runPaths(dataRoot, id).events).events.flatMap((e) => (e.t === 'cancel' ? [e.stage] : []));

async function runInProcess(
  h: RunHeader,
  dataRoot: string,
  opts: { port?: ExecPort; quotaCheckMs?: number; onStart?: () => void } = {},
) {
  writeRunHeader(dataRoot, h);
  const p = runSupervisor({
    runId: h.runId,
    dataRoot,
    hooks: defaultHooks(dataRoot, h.runId, {}),
    controlPollMs: 50,
    ...(opts.port ? { port: opts.port } : {}),
    quotaCheckMs: opts.quotaCheckMs ?? 100,
  });
  opts.onStart?.();
  return p;
}

describe('EXE-003 supervisor (in process, real child processes)', () => {
  it('runs specs to completed with well-formed events, heartbeat and terminal record', async () => {
    const { dataRoot } = env();
    const id = runId();
    const rec = await runInProcess(header(id, [spec('ok'), spec('fail')]), dataRoot);
    expect(rec).toMatchObject({ runId: id, state: 'completed', processes: [{ exitCode: 0 }, { exitCode: 1 }] });
    expect(states(dataRoot, id)).toEqual(['preparing', 'running', 'collecting', 'analyzing', 'completed']);
    const files = readRunFiles(dataRoot, id);
    expect(files.events.truncated).toBe(false);
    for (const e of files.events.events) expect(RunEvent.safeParse(e).success).toBe(true);
    const kinds = files.events.events.map((e) => e.t);
    for (const k of ['authorization', 'attempt.start', 'process.start', 'process.exit', 'attempt.end', 'terminal'])
      expect(kinds).toContain(k);
    expect(kinds.at(-1)).toBe('terminal');
    expect(files.heartbeat?.pid).toBe(process.pid);
    expect(files.terminal).toEqual(rec);
    const p = runPaths(dataRoot, id);
    expect(fs.readFileSync(path.join(p.attemptDir(1), 'stdout-0.log'), 'utf8')).toBe('all tests passed\n');
    expect(fs.existsSync(p.tmp)).toBe(false);
    expect(fs.statSync(p.events).mode & 0o777).toBe(0o600);
  });

  it('a cancel via control.json during a run reaches a confirmed cancelled state', async () => {
    const { dataRoot } = env();
    const id = runId();
    const h = header(id, [spec('sleep')]);
    const done = runInProcess(h, dataRoot);
    await until(() => readEvents(runPaths(dataRoot, id).events).events.some((e) => e.t === 'process.start'));
    atomicWriteJson(runPaths(dataRoot, id).control, {
      cancel: true,
      reason: 'user',
      requestedAt: '2026-10-23T01:00:00Z',
    });
    const rec = await done;
    expect(rec).toMatchObject({ state: 'cancelled', cancelReason: 'user' });
    expect(states(dataRoot, id)).toEqual(['preparing', 'running', 'cancelling', 'cancelled']);
    // SIGTERM first and a confirmed end; under heavy load the grace period may pass first, adding kill_sent.
    const stages = cancelStages(dataRoot, id);
    expect(stages[0]).toBe('term_sent');
    expect(stages.at(-1)).toBe('confirmed');
    expect(stages.length === 2 || stages[1] === 'kill_sent').toBe(true);
  });

  it('a SIGTERM-ignoring runner is killed; the run times out as timed_out', async () => {
    const { dataRoot } = env();
    const id = runId();
    const rec = await runInProcess(
      header(id, [spec('ignore-term')], { timeouts: { runMs: 1500 }, graceMs: 300 }),
      dataRoot,
    );
    expect(rec).toMatchObject({ state: 'timed_out', cancelReason: 'timeout' });
    expect(cancelStages(dataRoot, id)).toEqual(['term_sent', 'kill_sent', 'confirmed']);
    expect(readEvents(runPaths(dataRoot, id).events).events.some((e) => e.t === 'timeout' && e.scope === 'run')).toBe(
      true,
    );
  });

  it('survivors lead to cancel_pending, then infra_error(cancel_unconfirmed) after the window', async () => {
    const { dataRoot } = env();
    const id = runId();
    const real = nodeExecPort();
    let leaderPgid = -1;
    const ghost = { pid: 999_999, startTime: 'Sat Dec 31 23:59:59 2099' };
    const port: ExecPort = {
      ...real,
      spawn: (req) => {
        const c = real.spawn(req);
        leaderPgid = c.pid ?? -1;
        return c;
      },
      groupMembers: (pgid) => [...real.groupMembers(pgid), ...(pgid === leaderPgid ? [{ ...ghost, pgid }] : [])],
    };
    const done = runInProcess(header(id, [spec('sleep')], { graceMs: 200, cancelVerifyWindowMs: 500 }), dataRoot, {
      port,
    });
    await until(() => readEvents(runPaths(dataRoot, id).events).events.some((e) => e.t === 'process.start'));
    atomicWriteJson(runPaths(dataRoot, id).control, {
      cancel: true,
      reason: 'user',
      requestedAt: '2026-10-23T01:00:00Z',
    });
    const rec = await done;
    expect(rec).toMatchObject({ state: 'infra_error', infraReason: 'cancel_unconfirmed', survivors: [999_999] });
    expect(states(dataRoot, id)).toEqual(['preparing', 'running', 'cancelling', 'cancel_pending', 'infra_error']);
  });

  it('a disk-quota breach cancels the run with reason resource_quota', async () => {
    const { dataRoot } = env();
    const id = runId();
    const rec = await runInProcess(header(id, [spec('write-big')], { diskQuotaBytes: 1024 * 1024 }), dataRoot);
    expect(rec).toMatchObject({ state: 'cancelled', cancelReason: 'resource_quota' });
  });

  it('denied re-authorization or a spec failing current policy never starts a process', async () => {
    const { dataRoot } = env();
    const a = runId();
    expect(await runInProcess(header(a, [spec('ok')], { workspaceId: 'ws_ref' }), dataRoot)).toMatchObject({
      state: 'cancelled',
      cancelReason: 'authorization_invalidated',
      processes: [],
    });
    const auth = readEvents(runPaths(dataRoot, a).events).events.find((e) => e.t === 'authorization');
    expect(auth).toMatchObject({ result: 'denied', reasons: ['workspace_not_allowed'] });
    const b = runId();
    expect(
      await runInProcess(header(b, [spec('ok', [{ kind: 'flag', name: '--update-goldens' }])]), dataRoot),
    ).toMatchObject({ state: 'cancelled', cancelReason: 'authorization_invalidated' });
    expect(readEvents(runPaths(dataRoot, b).events).events.some((e) => e.t === 'process.start')).toBe(false);
  });

  it('an unreadable header ends in infra_error(prerequisite_failed)', async () => {
    const { dataRoot } = env();
    const id = runId();
    fs.mkdirSync(runPaths(dataRoot, id).dir, { recursive: true });
    fs.writeFileSync(runPaths(dataRoot, id).header, '{"not":"a header"}');
    const rec = await runSupervisor({ runId: id, dataRoot, hooks: defaultHooks(dataRoot, id, {}) });
    expect(rec).toMatchObject({ state: 'infra_error', infraReason: 'prerequisite_failed' });
  });

  it('readEvents treats a torn last line as truncation and keeps the valid prefix', () => {
    const { dataRoot } = env();
    const id = runId();
    const p = runPaths(dataRoot, id);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.events, '{"t":"heartbeat","ts":"2026-10-23T00:00:00Z"}\n{"t":"heartb');
    expect(readEvents(p.events)).toMatchObject({ truncated: true, events: [{ t: 'heartbeat' }] });
    fs.writeFileSync(p.events, '{"t":"bogus"}\n');
    expect(readEvents(p.events)).toEqual({ events: [], truncated: true });
  });
});

describe('EXE-003 detached supervisor', () => {
  it('survives the death of the process that launched it', async () => {
    const { base, dataRoot } = env();
    const id = runId();
    writeRunHeader(dataRoot, header(id, [spec('sleep1')]));
    const out = path.join(base, 'parent.json');
    const parent = launchDetachedNode({
      entry: path.resolve(import.meta.dirname, 'fixtures/parent.ts'),
      args: [dataRoot, id, out],
      cwd: base,
      logFile: path.join(base, 'parent.log'),
    });
    const info = await until(() =>
      fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, 'utf8')) as { supervisor: { pid: number } }) : undefined,
    );
    process.kill(parent.pid, 'SIGKILL');
    await until(() => nodeExecPort().processInfo(parent.pid) === undefined || undefined);
    expect(info.supervisor.pid).not.toBe(parent.pid);
    const terminal = await until(() => readRunFiles(dataRoot, id).terminal, 30_000);
    expect(terminal).toMatchObject({ state: 'completed', processes: [{ exitCode: 0 }] });
    // The supervisor logs its last line after writing terminal.json, so wait for it rather than reading at once.
    const log = await until(() => {
      const text = fs.readFileSync(runPaths(dataRoot, id).log, 'utf8');
      return text.includes('terminal completed') ? text : undefined;
    }, 15_000);
    expect(log).toContain('terminal completed');
  }, 60_000);

  it('a cancel request (control file + identity-checked SIGTERM) reaches cancelled', async () => {
    const { dataRoot } = env();
    const id = runId();
    writeRunHeader(dataRoot, header(id, [spec('sleep')]));
    const sup = launchSupervisor(dataRoot, id);
    await until(() => readEvents(runPaths(dataRoot, id).events).events.some((e) => e.t === 'process.start'));
    expect(requestCancel(dataRoot, id, 'user', { ...sup, startTime: 'Thu Jan  1 00:00:00 1970' })).toEqual({
      signalled: false,
    });
    expect(requestCancel(dataRoot, id, 'user', sup)).toEqual({ signalled: true });
    const terminal = await until(() => readRunFiles(dataRoot, id).terminal, 30_000);
    expect(terminal).toMatchObject({ state: 'cancelled', cancelReason: 'user' });
    await until(() => checkIdentity(nodeExecPort(), sup) === 'gone' || undefined);
  }, 60_000);
});
