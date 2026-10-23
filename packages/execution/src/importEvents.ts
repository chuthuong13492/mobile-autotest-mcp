/**
 * Run lifecycle event import (OBS-003; observability §2). The server reads `events.ndjson` from a stored offset and
 * folds the new records into the run's latest state, its processes and metrics. A truncated log is imported up to
 * its last valid line and flagged (`event_log_truncated`). Persisting the offset and state is RUN-004.
 */
import type { InfraReason, MetricsRegistry, RunEvent, RunState } from '@autotest/core';
import type { EventLog } from './supervisor/files.ts';

export interface EventImport {
  readonly newEvents: readonly RunEvent[];
  /** Offset (in events) to store for the next import. */
  readonly nextOffset: number;
  /** Latest state seen in the new events, if any. */
  readonly state?: RunState;
  readonly terminal?: { readonly state: RunState; readonly infraReason?: InfraReason };
  readonly processes: readonly {
    readonly pid: number;
    readonly pgid: number;
    readonly startTime: string;
    readonly executable: string;
  }[];
  readonly lastHeartbeat?: string;
  /** Limitations to attach to the run (e.g. `event_log_truncated`, `event_offset_ahead`). */
  readonly limitations: readonly string[];
}

export function importRunEvents(log: EventLog, offset: number, metrics?: MetricsRegistry): EventImport {
  const limitations: string[] = [];
  if (log.truncated) limitations.push('event_log_truncated');
  if (offset > log.events.length) {
    limitations.push('event_offset_ahead');
    return { newEvents: [], nextOffset: offset, processes: [], limitations };
  }
  const newEvents = log.events.slice(offset);
  let state: RunState | undefined;
  let terminal: EventImport['terminal'];
  let lastHeartbeat: string | undefined;
  const processes: EventImport['processes'][number][] = [];
  for (const e of newEvents) {
    switch (e.t) {
      case 'state':
        state = e.to;
        if (e.to === 'cancel_pending') metrics?.inc('cancel_pending_total');
        break;
      case 'terminal':
        terminal = { state: e.state, ...(e.infraReason ? { infraReason: e.infraReason } : {}) };
        metrics?.inc('runs_total', { state: e.state });
        break;
      case 'authorization':
        if (e.result === 'denied')
          for (const r of e.reasons) metrics?.inc('authorization_denials_total', { reason: r });
        break;
      case 'process.start':
        processes.push({ pid: e.pid, pgid: e.pgid, startTime: e.startTime, executable: e.executable });
        break;
      case 'heartbeat':
        lastHeartbeat = e.ts;
        break;
      default:
        break;
    }
  }
  return {
    newEvents,
    nextOffset: log.events.length,
    ...(state ? { state } : {}),
    ...(terminal ? { terminal } : {}),
    processes,
    ...(lastHeartbeat ? { lastHeartbeat } : {}),
    limitations,
  };
}
