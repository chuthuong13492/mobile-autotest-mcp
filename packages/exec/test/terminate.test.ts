import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ProcessIdentity } from '@autotest/contracts';
import { nodeExecPort, spawnSpec, terminateGroup, verifyGone, type ExecPort, type ProcessRow } from '@autotest/exec';
import { fixture, spec } from './helpers.ts';

const start = async (mode: string, waitFor?: string) => {
  const ctx = fixture().ctx();
  const r = await spawnSpec(spec(mode), ctx);
  if (!r.ok) throw new Error('denied');
  // Wait until the script has reached its steady state (e.g. installed its signal trap). Under a loaded parallel
  // suite process start-up can take seconds, so wait generously and fail loudly rather than test a half-started child.
  if (waitFor) {
    const deadline = Date.now() + 15_000;
    while (!fs.readFileSync(ctx.stdoutPath, 'utf8').includes(waitFor)) {
      if (Date.now() > deadline) throw new Error(`child never printed ${waitFor}`);
      await new Promise((res) => setTimeout(res, 10));
    }
  }
  return r.process;
};

describe('EXE-002 terminateGroup (real processes)', () => {
  it('a cooperative group ends after SIGTERM', async () => {
    const p = await start('sleep');
    const res = await terminateGroup(p.identity, { graceMs: 3000 });
    expect(res).toMatchObject({ signalled: true, outcome: 'confirmed', stages: ['term_sent', 'confirmed'] });
    expect((await p.exited).signal).toBe('SIGTERM');
  });

  it('a SIGTERM-ignoring group (including a background child) is killed after the grace period', async () => {
    const p = await start('ignore-term', 'ready');
    const t0 = Date.now();
    const res = await terminateGroup(p.identity, { graceMs: 600 });
    expect(res).toMatchObject({ outcome: 'confirmed', stages: ['term_sent', 'kill_sent', 'confirmed'] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect((await p.exited).signal).toBe('SIGKILL');
    const bg = await start('bg-child');
    expect((await terminateGroup(bg.identity, { graceMs: 2000 })).outcome).toBe('confirmed');
    expect(verifyGone(bg.identity)).toBe(true);
  });

  it('a PID-reuse simulation (wrong start time) is never signalled', async () => {
    const p = await start('sleep');
    const forged: ProcessIdentity = { ...p.identity, startTime: 'Thu Jan  1 00:00:00 1970' };
    const res = await terminateGroup(forged, { graceMs: 200 });
    expect(res).toEqual({ signalled: false, outcome: 'identity_mismatch', stages: [], survivors: [] });
    expect(nodeExecPort().processInfo(p.identity.pid)).toBeDefined();
    await terminateGroup(p.identity, { graceMs: 2000 });
  });

  it('an already-finished group is reported, not signalled', async () => {
    const r = await spawnSpec(spec('echo-args'), fixture().ctx());
    if (!r.ok) throw new Error('denied');
    await r.process.exited;
    expect((await terminateGroup(r.process.identity, { graceMs: 100 })).outcome).toBe('already_gone');
  });
});

describe('EXE-002 terminateGroup (simulated port)', () => {
  const id: ProcessIdentity = { pid: 4242, pgid: 4242, startTime: 'Fri Oct 23 09:00:00 2026' };
  const fake = (rows: () => ProcessRow[]) => {
    const signals: [number, string][] = [];
    const port: ExecPort = {
      spawn: () => {
        throw new Error('unused');
      },
      spawnDetached: () => {
        throw new Error('unused');
      },
      processInfo: (pid) => rows().find((r) => r.pid === pid),
      groupMembers: (pgid) => rows().filter((r) => r.pgid === pgid),
      signal: (t, s) => {
        signals.push([t, s]);
        return true;
      },
      capabilities: { rlimits: false },
    };
    return { port, signals };
  };

  it('reports survivors that outlive SIGKILL', async () => {
    const { port, signals } = fake(() => [id, { pid: 4243, pgid: 4242, startTime: 'Fri Oct 23 09:00:01 2026' }]);
    const stages: string[] = [];
    const res = await terminateGroup(id, {
      graceMs: 50,
      killWaitMs: 50,
      pollMs: 10,
      port,
      onStage: (s) => stages.push(s),
    });
    expect(res).toEqual({
      signalled: true,
      outcome: 'survivors',
      stages: ['term_sent', 'kill_sent', 'survivors'],
      survivors: [4242, 4243],
    });
    expect(stages).toEqual(res.stages);
    expect(signals).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    expect(verifyGone(id, port)).toBe(false);
  });

  it('with the leader gone, only members younger than the leader are attributed to it', async () => {
    const older = fake(() => [{ pid: 9000, pgid: 4242, startTime: 'Fri Oct 23 08:00:00 2026' }]);
    expect((await terminateGroup(id, { graceMs: 10, port: older.port })).outcome).toBe('identity_mismatch');
    expect(older.signals).toEqual([]);
    let alive = true;
    const younger = fake(() => (alive ? [{ pid: 9001, pgid: 4242, startTime: 'Fri Oct 23 09:05:00 2026' }] : []));
    const p = terminateGroup(id, { graceMs: 200, pollMs: 10, port: younger.port });
    setTimeout(() => (alive = false), 30);
    expect((await p).outcome).toBe('confirmed');
    expect(younger.signals).toEqual([[-4242, 'SIGTERM']]);
  });

  it('a leader whose pgid changed is a mismatch', async () => {
    const { port, signals } = fake(() => [{ ...id, pgid: 1 }]);
    expect((await terminateGroup(id, { graceMs: 10, port })).outcome).toBe('identity_mismatch');
    expect(signals).toEqual([]);
  });
});
