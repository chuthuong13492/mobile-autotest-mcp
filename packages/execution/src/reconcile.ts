/**
 * Process checks for restart reconciliation (RUN-006; ADR-0007 §7). The decision table lives in the run manager;
 * these helpers keep every signal identity-checked: a process whose identity cannot be verified is never signalled.
 */
import type { ProcessIdentity } from '@autotest/core';
import { checkIdentity, nodeExecPort, terminateGroup, type ExecPort } from '@autotest/exec';
import { importRunEvents } from './importEvents.ts';
import type { EventLog } from './supervisor/files.ts';

export type { ExecPort } from '@autotest/exec';

/** True when the recorded supervisor is still the same live process. */
export function supervisorAlive(identity: ProcessIdentity, port: ExecPort = nodeExecPort()): boolean {
  return identity.startTime !== 'unknown' && checkIdentity(port, identity) === 'match';
}

/**
 * Stops runner processes a lost supervisor started and never saw exit. Returns whether any of them could not be
 * verified (then nothing is signalled for it and the run ends `orphan_unverified`).
 */
export async function stopOrphans(
  log: EventLog,
  port: ExecPort = nodeExecPort(),
  graceMs = 2000,
): Promise<{ stopped: number; unverified: boolean }> {
  const started = importRunEvents(log, 0).processes;
  const exited = new Set(log.events.flatMap((e) => (e.t === 'process.exit' ? [e.pid] : [])));
  let stopped = 0;
  let unverified = false;
  for (const p of started.filter((x) => !exited.has(x.pid))) {
    if (p.startTime === 'unknown') {
      unverified = true;
      continue;
    }
    const r = await terminateGroup(p, { graceMs, port });
    if (r.outcome === 'confirmed') stopped++;
    else if (r.outcome === 'survivors') unverified = true;
  }
  return { stopped, unverified };
}
