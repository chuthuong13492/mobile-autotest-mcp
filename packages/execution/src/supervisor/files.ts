/**
 * Run-directory files shared by the server (writer of `run.json`/`control.json`, reader of the rest) and the
 * supervisor (writer of `events.ndjson`, `heartbeat.json`, `terminal.json`) — ADR-0007, data model §On-disk layout.
 *
 * The durable-write helpers mirror `@autotest/storage` (which `execution` may not import, boundaries.json): atomic
 * replace for JSON records and an fsync per appended event line.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CancelReason,
  ExecutionSpec,
  InfraReason,
  RunEvent,
  RunId,
  RunState,
  Sha256,
  Timestamp,
  type RunEvent as RunEventT,
} from '@autotest/core';

export function runPaths(dataRoot: string, runId: string) {
  const dir = path.join(dataRoot, 'runs', runId);
  const tmp = path.join(dataRoot, 'tmp', runId);
  return {
    dir,
    header: path.join(dir, 'run.json'),
    control: path.join(dir, 'control.json'),
    heartbeat: path.join(dir, 'heartbeat.json'),
    events: path.join(dir, 'events.ndjson'),
    terminal: path.join(dir, 'terminal.json'),
    log: path.join(dir, 'supervisor.log'),
    attemptDir: (n: number) => path.join(dir, 'attempts', String(n)),
    tmp,
    home: path.join(tmp, 'home'),
    tmpDir: path.join(tmp, 'tmp'),
  };
}

/** `run.json`: what the supervisor runs. Written by the server before the supervisor starts. */
export const RunHeader = z.strictObject({
  runId: RunId,
  workspaceId: z.string().regex(/^ws_[a-z0-9_]{1,60}$/),
  /** inputsDigest of the create-time authorization; the dispatch hook compares against it (RUN-002). */
  authorizationDigest: Sha256,
  specs: z.array(ExecutionSpec).min(1).max(50),
  timeouts: z.strictObject({ runMs: z.number().int().min(1000).max(14_400_000) }),
  graceMs: z.number().int().min(100).max(120_000),
  heartbeatMs: z.number().int().min(50).max(60_000).default(5000),
  /** How long survivors are re-checked before `infra_error(cancel_unconfirmed)` (default 10 min). */
  cancelVerifyWindowMs: z.number().int().min(100).max(3_600_000).default(600_000),
  diskQuotaBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 ** 3),
  outputCapBytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 ** 3),
});
export type RunHeader = z.infer<typeof RunHeader>;

/** `control.json`: cancel requests from the server. */
export const ControlFile = z.strictObject({ cancel: z.literal(true), reason: CancelReason, requestedAt: Timestamp });
export type ControlFile = z.infer<typeof ControlFile>;

export const Heartbeat = z.strictObject({
  ts: Timestamp,
  pid: z.number().int().positive(),
  seq: z.number().int().min(0),
  state: RunState,
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const TerminalRecord = z.strictObject({
  runId: RunId,
  state: RunState,
  cancelReason: CancelReason.optional(),
  infraReason: InfraReason.optional(),
  survivors: z.array(z.number().int()).optional(),
  processes: z.array(
    z.strictObject({
      pid: z.number().int(),
      exitCode: z.number().int().optional(),
      signal: z.string().max(16).optional(),
    }),
  ),
  endedAt: Timestamp,
});
export type TerminalRecord = z.infer<typeof TerminalRecord>;

export const iso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Appends one validated event with an fsync (written before the supervisor acts on it). */
export function appendEvent(file: string, event: RunEventT): void {
  const line = `${JSON.stringify(RunEvent.parse(event))}\n`;
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson<T>(
  file: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): T | undefined {
  try {
    const r = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export interface EventLog {
  readonly events: readonly RunEventT[];
  /** True when a malformed or partial line was found; the valid prefix is authoritative (observability §2). */
  readonly truncated: boolean;
}

/** Reads the event log; stops at the first invalid line. */
export function readEvents(file: string): EventLog {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { events: [], truncated: false };
  }
  const events: RunEventT[] = [];
  const lines = text.split('\n');
  // Without a trailing newline the last fragment was cut mid-write.
  const partial = lines.pop() ?? '';
  for (const line of lines) {
    try {
      events.push(RunEvent.parse(JSON.parse(line)));
    } catch {
      return { events, truncated: true };
    }
  }
  return { events, truncated: partial.length > 0 };
}
