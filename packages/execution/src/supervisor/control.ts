/**
 * Server-side run-directory operations (ADR-0007): write the run header, launch the detached supervisor, request
 * cancellation (control file + identity-checked SIGTERM) and read what the supervisor wrote.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CancelReason, ProcessIdentity } from '@autotest/core';
import { checkIdentity, launchDetachedNode, nodeExecPort, type ExecPort } from '@autotest/exec';
import {
  atomicWriteJson,
  Heartbeat,
  iso,
  readEvents,
  readJson,
  RunHeader,
  runPaths,
  TerminalRecord,
  type EventLog,
} from './files.ts';

/** Absolute path of the supervisor entrypoint shipped in this package. */
export const SUPERVISOR_ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

export function writeRunHeader(dataRoot: string, header: RunHeader): void {
  const p = runPaths(dataRoot, header.runId);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  atomicWriteJson(p.header, RunHeader.parse(header));
}

/** Starts the supervisor for a run whose header is written. `env` carries the allowlisted variables for children. */
export function launchSupervisor(
  dataRoot: string,
  runId: string,
  env: Readonly<Record<string, string>> = {},
  port?: ExecPort,
  /** The app's supervisor entrypoint (adapters and full re-authorization); default: this package's baseline. */
  entry: string = SUPERVISOR_ENTRY,
): ProcessIdentity {
  const p = runPaths(dataRoot, runId);
  return launchDetachedNode({
    entry,
    args: [runId, dataRoot],
    cwd: p.dir,
    logFile: p.log,
    env,
    ...(port ? { port } : {}),
  });
}

/** Writes `control.json`, then signals the supervisor if (and only if) it still matches its recorded identity. */
export function requestCancel(
  dataRoot: string,
  runId: string,
  reason: CancelReason,
  supervisor: ProcessIdentity | undefined,
  port: ExecPort = nodeExecPort(),
): { signalled: boolean } {
  atomicWriteJson(runPaths(dataRoot, runId).control, { cancel: true, reason, requestedAt: iso() });
  if (!supervisor || checkIdentity(port, supervisor) !== 'match') return { signalled: false };
  return { signalled: port.signal(supervisor.pid, 'SIGTERM') };
}

export interface RunFiles {
  readonly events: EventLog;
  readonly heartbeat?: Heartbeat;
  readonly terminal?: TerminalRecord;
}

export function readRunFiles(dataRoot: string, runId: string): RunFiles {
  const p = runPaths(dataRoot, runId);
  const heartbeat = readJson(p.heartbeat, Heartbeat);
  const terminal = readJson(p.terminal, TerminalRecord);
  return { events: readEvents(p.events), ...(heartbeat ? { heartbeat } : {}), ...(terminal ? { terminal } : {}) };
}
