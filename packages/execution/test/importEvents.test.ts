import { describe, expect, it } from 'vitest';
import { createMetricsRegistry, type RunEvent } from '@autotest/core';
import { importRunEvents } from '@autotest/execution';

const ts = '2026-10-23T00:00:00Z';
const events: RunEvent[] = [
  { t: 'state', ts, from: 'queued', to: 'preparing' },
  {
    t: 'authorization',
    ts,
    phase: 'dispatch',
    result: 'authorized',
    reasons: [],
    inputsDigest: `sha256:${'a'.repeat(64)}`,
  },
  { t: 'state', ts, from: 'preparing', to: 'running' },
  {
    t: 'process.start',
    ts,
    pid: 10,
    pgid: 10,
    startTime: 'Fri Oct 23 09:00:00 2026',
    executable: '/x/flutter',
    role: 'runner',
  },
  { t: 'heartbeat', ts: '2026-10-23T00:00:05Z' },
  { t: 'state', ts, from: 'running', to: 'cancelling', reason: 'user' },
  { t: 'state', ts, from: 'cancelling', to: 'cancel_pending' },
  { t: 'state', ts, from: 'cancel_pending', to: 'infra_error' },
  { t: 'terminal', ts, state: 'infra_error', infraReason: 'cancel_unconfirmed' },
];

describe('OBS-003 run event import', () => {
  it('imports incrementally from an offset and records metrics', () => {
    const m = createMetricsRegistry();
    const first = importRunEvents({ events: events.slice(0, 5), truncated: false }, 0, m);
    expect(first).toMatchObject({
      nextOffset: 5,
      state: 'running',
      processes: [{ pid: 10 }],
      lastHeartbeat: '2026-10-23T00:00:05Z',
      limitations: [],
    });
    const second = importRunEvents({ events, truncated: false }, first.nextOffset, m);
    expect(second).toMatchObject({
      nextOffset: 9,
      state: 'infra_error',
      terminal: { state: 'infra_error', infraReason: 'cancel_unconfirmed' },
      processes: [],
    });
    expect(second.newEvents).toHaveLength(4);
    const snap = m.snapshot();
    expect(snap['runs_total']?.series).toEqual([{ labels: { state: 'infra_error' }, value: 1 }]);
    expect(snap['cancel_pending_total']?.series).toEqual([{ labels: {}, value: 1 }]);
    expect(importRunEvents({ events, truncated: false }, 9).newEvents).toEqual([]);
  });

  it('flags a truncated log and an offset beyond the log', () => {
    expect(importRunEvents({ events: events.slice(0, 2), truncated: true }, 0).limitations).toEqual([
      'event_log_truncated',
    ]);
    expect(importRunEvents({ events: events.slice(0, 2), truncated: false }, 5)).toMatchObject({
      nextOffset: 5,
      limitations: ['event_offset_ahead'],
    });
  });

  it('counts denial reasons', () => {
    const m = createMetricsRegistry();
    importRunEvents(
      {
        events: [
          {
            t: 'authorization',
            ts,
            phase: 'dispatch',
            result: 'denied',
            reasons: ['workspace_not_allowed', 'policy_unavailable'],
            inputsDigest: `sha256:${'b'.repeat(64)}`,
          },
        ],
        truncated: false,
      },
      0,
      m,
    );
    expect(m.snapshot()['authorization_denials_total']?.series.map((s) => s.labels['reason'])).toEqual([
      'workspace_not_allowed',
      'policy_unavailable',
    ]);
  });
});
