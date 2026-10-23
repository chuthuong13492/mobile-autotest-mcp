/**
 * Process-group termination (EXE-002; FR-025, FR-026, SR-010; ADR-0007 §5; T-09, T-16).
 *
 * SIGTERM → grace → SIGKILL → verify. Before every signal the group is re-identified: the leader, if alive, must
 * still match the recorded start time and pgid; members of a group whose leader is gone are signalled only if they
 * started no earlier than the recorded leader (a reused PID cannot have done so). Anything that does not match is
 * never signalled. Members still alive after SIGKILL are returned as survivors (→ `cancel_pending`).
 */
import type { ProcessIdentity } from '@autotest/contracts';
import { nodeExecPort, type ExecPort, type ProcessRow } from './port.ts';

export type TerminationStage = 'term_sent' | 'kill_sent' | 'confirmed' | 'survivors';

export interface TerminateOptions {
  readonly graceMs: number;
  /** How long to wait for the group to disappear after SIGKILL before reporting survivors. */
  readonly killWaitMs?: number;
  readonly pollMs?: number;
  readonly port?: ExecPort;
  readonly onStage?: (stage: TerminationStage, survivors?: readonly number[]) => void;
}

export interface TerminationResult {
  /** False when nothing was signalled because the identity did not match or the group was already gone. */
  readonly signalled: boolean;
  readonly outcome: 'confirmed' | 'survivors' | 'already_gone' | 'identity_mismatch';
  readonly stages: readonly TerminationStage[];
  readonly survivors: readonly number[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Members of the recorded group that can be attributed to this identity, or `mismatch`. */
export function ownedMembers(port: ExecPort, id: ProcessIdentity): ProcessRow[] | 'mismatch' {
  const leader = port.processInfo(id.pid);
  if (leader && (leader.startTime !== id.startTime || leader.pgid !== id.pgid)) return 'mismatch';
  const members = port.groupMembers(id.pgid);
  if (leader) return members;
  const born = Date.parse(id.startTime);
  if (Number.isNaN(born)) return members.length ? 'mismatch' : [];
  // Leader gone: a member older than the recorded leader cannot belong to it.
  return members.some((m) => !(Date.parse(m.startTime) >= born)) ? 'mismatch' : members;
}

export async function terminateGroup(id: ProcessIdentity, opts: TerminateOptions): Promise<TerminationResult> {
  const port = opts.port ?? nodeExecPort();
  const poll = opts.pollMs ?? 100;
  const stages: TerminationStage[] = [];
  const stage = (s: TerminationStage, survivors?: readonly number[]) => {
    stages.push(s);
    opts.onStage?.(s, survivors);
  };

  const initial = ownedMembers(port, id);
  if (initial === 'mismatch') return { signalled: false, outcome: 'identity_mismatch', stages, survivors: [] };
  if (initial.length === 0) return { signalled: false, outcome: 'already_gone', stages, survivors: [] };

  port.signal(-id.pgid, 'SIGTERM');
  stage('term_sent');
  if (await waitGone(port, id, opts.graceMs, poll)) {
    stage('confirmed');
    return { signalled: true, outcome: 'confirmed', stages, survivors: [] };
  }

  const beforeKill = ownedMembers(port, id);
  if (beforeKill === 'mismatch') return { signalled: true, outcome: 'identity_mismatch', stages, survivors: [] };
  if (beforeKill.length > 0) {
    port.signal(-id.pgid, 'SIGKILL');
    stage('kill_sent');
  }
  if (await waitGone(port, id, opts.killWaitMs ?? 2000, poll)) {
    stage('confirmed');
    return { signalled: true, outcome: 'confirmed', stages, survivors: [] };
  }
  const left = ownedMembers(port, id);
  const survivors = left === 'mismatch' ? [] : left.map((m) => m.pid).sort((a, b) => a - b);
  stage('survivors', survivors);
  return { signalled: true, outcome: 'survivors', stages, survivors };
}

/** Re-checks a group that had survivors (cancel_pending back-off): true once nothing attributable is left. */
export function verifyGone(id: ProcessIdentity, port: ExecPort = nodeExecPort()): boolean {
  const m = ownedMembers(port, id);
  return m !== 'mismatch' && m.length === 0;
}

async function waitGone(port: ExecPort, id: ProcessIdentity, ms: number, poll: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (port.groupMembers(id.pgid).length === 0) return true;
    if (Date.now() >= until) return false;
    await sleep(Math.min(poll, Math.max(0, until - Date.now())));
  }
}
