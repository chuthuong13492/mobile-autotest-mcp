import { describe, expect, it } from 'vitest';
import { admit, selectDispatchable, type QueuedRun } from '@autotest/execution';

const limits = { maxConcurrentRuns: 2, maxRunsPerWorkspace: 1, maxRunsPerDevice: 1, queueCapacity: 3 };
const q = (
  runId: string,
  workspaceId: string,
  devices: string[] = [],
  queuedAt = `2026-10-23T00:00:0${runId.slice(-1)}Z`,
): QueuedRun => ({ runId, workspaceId, devices, queuedAt });

describe('EXE-004 queue', () => {
  it('the (N+1)th run waits in the queue', () => {
    expect(selectDispatchable([q('r1', 'a'), q('r2', 'b'), q('r3', 'c')], [], limits)).toEqual(['r1', 'r2']);
    expect(
      selectDispatchable(
        [q('r3', 'c')],
        [
          { runId: 'r1', workspaceId: 'a', devices: [] },
          { runId: 'r2', workspaceId: 'b', devices: [] },
        ],
        limits,
      ),
    ).toEqual([]);
  });

  it('is FIFO, but a run blocked by its workspace or device does not block others', () => {
    const active = [{ runId: 'r0', workspaceId: 'a', devices: ['SIM-1'] }];
    expect(selectDispatchable([q('r2', 'a'), q('r3', 'b', ['SIM-1']), q('r4', 'c')], active, limits)).toEqual(['r4']);
    expect(
      selectDispatchable([q('r9', 'x', [], '2026-10-23T00:00:09Z'), q('r1', 'y', [], '2026-10-23T00:00:01Z')], [], {
        ...limits,
        maxConcurrentRuns: 1,
      }),
    ).toEqual(['r1']);
  });

  it('a full queue returns E_QUEUE_FULL', () => {
    expect(admit(2, limits)).toEqual({ ok: true });
    const r = admit(3, limits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error).toMatchObject({ code: 'E_QUEUE_FULL', recoverable: true });
  });
});
