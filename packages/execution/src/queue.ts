/**
 * Run admission and dispatch selection (EXE-004; FR-027, SR-010; T-07).
 *
 * Pure functions over the persisted run set, so any server instance can make the same decision inside one SQLite
 * transaction (several stdio servers may share a data root, RK-11). Order is FIFO by `queuedAt` (then run id); a run
 * blocked by its workspace or device limit does not block runs that are free to start (work-conserving FIFO).
 */
import { toolError, type ToolError } from '@autotest/core';

export interface QueueLimits {
  readonly maxConcurrentRuns: number;
  readonly maxRunsPerWorkspace: number;
  readonly maxRunsPerDevice: number;
  readonly queueCapacity: number;
}

export interface QueuedRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly devices: readonly string[];
  readonly queuedAt: string;
}

export interface ActiveRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly devices: readonly string[];
}

/** Admission check for a new run: `E_QUEUE_FULL` when the queue is at capacity. */
export function admit(queuedCount: number, limits: QueueLimits): { ok: true } | { ok: false; error: ToolError } {
  if (queuedCount < limits.queueCapacity) return { ok: true };
  return {
    ok: false,
    error: toolError('E_QUEUE_FULL', `queue is full (${limits.queueCapacity} queued runs)`, [
      'Wait for queued runs to start, or cancel one.',
    ]),
  };
}

/** Returns the queued run ids that may start now, in start order. */
export function selectDispatchable(
  queued: readonly QueuedRun[],
  active: readonly ActiveRun[],
  limits: QueueLimits,
): string[] {
  const perWs = new Map<string, number>();
  const perDev = new Map<string, number>();
  for (const a of active) {
    perWs.set(a.workspaceId, (perWs.get(a.workspaceId) ?? 0) + 1);
    for (const d of a.devices) perDev.set(d, (perDev.get(d) ?? 0) + 1);
  }
  let running = active.length;
  const out: string[] = [];
  const ordered = [...queued].sort((a, b) =>
    a.queuedAt === b.queuedAt ? (a.runId < b.runId ? -1 : 1) : a.queuedAt < b.queuedAt ? -1 : 1,
  );
  for (const q of ordered) {
    if (running >= limits.maxConcurrentRuns) break;
    if ((perWs.get(q.workspaceId) ?? 0) >= limits.maxRunsPerWorkspace) continue;
    if (q.devices.some((d) => (perDev.get(d) ?? 0) >= limits.maxRunsPerDevice)) continue;
    out.push(q.runId);
    running++;
    perWs.set(q.workspaceId, (perWs.get(q.workspaceId) ?? 0) + 1);
    for (const d of q.devices) perDev.set(d, (perDev.get(d) ?? 0) + 1);
  }
  return out;
}
