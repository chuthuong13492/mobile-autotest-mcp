/**
 * Process identity (EXE-001; ADR-0007 §3; T-16). A recorded identity is `{pid, pgid, startTime, executable}`; a
 * signal is only ever sent when the live process still matches it.
 */
import type { ProcessIdentity } from '@autotest/contracts';
import type { ExecPort } from './port.ts';

/** Reads the identity of a live process, or undefined when it is gone. */
export function identify(port: ExecPort, pid: number, executable?: string): ProcessIdentity | undefined {
  const row = port.processInfo(pid);
  if (!row) return undefined;
  return { pid: row.pid, pgid: row.pgid, startTime: row.startTime, ...(executable ? { executable } : {}) };
}

export type IdentityCheck = 'match' | 'gone' | 'mismatch';

/** Compares a recorded identity with the live process that now has its pid. */
export function checkIdentity(port: ExecPort, recorded: ProcessIdentity): IdentityCheck {
  const row = port.processInfo(recorded.pid);
  if (!row) return 'gone';
  return row.startTime === recorded.startTime && row.pgid === recorded.pgid ? 'match' : 'mismatch';
}
