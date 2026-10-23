import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RUN_STATES,
  allowedTransitions,
  InvalidRunTransitionError,
  isTerminal,
  transitionRun,
  type RunEventInput,
  type RunStatus,
} from '@autotest/core';

const dataModel = fs.readFileSync(new URL('../../../docs/data-model-and-artifacts.md', import.meta.url), 'utf8');

const run = (start: RunStatus, ...events: RunEventInput[]) => events.reduce(transitionRun, start);

describe('CORE-003 run state machine', () => {
  it('matches the canonical state diagram edge-for-edge', () => {
    const diagram = /```mermaid\nstateDiagram-v2\n([\s\S]*?)```/.exec(dataModel)![1]!;
    const docEdges = new Set([...diagram.matchAll(/^\s*([a-z_]+) --> ([a-z_]+)/gm)].map((m) => `${m[1]}>${m[2]}`));
    const codeEdges = new Set(allowedTransitions().map(([a, b]) => `${a}>${b}`));
    expect([...codeEdges].sort()).toEqual([...docEdges].sort());
  });

  it('happy path reaches completed', () => {
    expect(
      run(
        { state: 'queued' },
        { type: 'slot_acquired' },
        { type: 'prerequisites_ok' },
        { type: 'attempts_finished' },
        { type: 'evidence_collected' },
        { type: 'analysis_done' },
      ).state,
    ).toBe('completed');
  });

  it('a confirmed timeout cancellation ends timed_out; a user cancellation ends cancelled', () => {
    const running: RunStatus = { state: 'running' };
    expect(run(running, { type: 'cancel_requested', reason: 'timeout' }, { type: 'termination_confirmed' }).state).toBe(
      'timed_out',
    );
    expect(run(running, { type: 'cancel_requested', reason: 'user' }, { type: 'termination_confirmed' }).state).toBe(
      'cancelled',
    );
  });

  it('never reports cancelled without confirmation; unconfirmed ends infra_error(cancel_unconfirmed)', () => {
    const pending = run(
      { state: 'running' },
      { type: 'cancel_requested', reason: 'user' },
      { type: 'survivors_after_kill' },
    );
    expect(pending.state).toBe('cancel_pending');
    const unconfirmed = transitionRun(pending, { type: 'verification_window_exceeded' });
    expect(unconfirmed).toEqual({ state: 'infra_error', infraReason: 'cancel_unconfirmed', cancelReason: 'user' });
    expect(transitionRun(pending, { type: 'survivors_gone' }).state).toBe('cancelled');
  });

  it('queued runs can be cancelled (user or authorization) but not timed out', () => {
    expect(
      run(
        { state: 'queued' },
        { type: 'cancel_requested', reason: 'authorization_invalidated' },
        { type: 'termination_confirmed' },
      ).state,
    ).toBe('cancelled');
    expect(() => transitionRun({ state: 'queued' }, { type: 'cancel_requested', reason: 'timeout' })).toThrow(
      InvalidRunTransitionError,
    );
  });

  it('terminal states are immutable', () => {
    const events: RunEventInput[] = [
      { type: 'slot_acquired' },
      { type: 'cancel_requested', reason: 'user' },
      { type: 'analysis_done' },
      { type: 'termination_confirmed' },
    ];
    for (const s of RUN_STATES.filter(isTerminal))
      for (const e of events) expect(() => transitionRun({ state: s }, e)).toThrow(InvalidRunTransitionError);
  });

  it('records infra reasons', () => {
    expect(transitionRun({ state: 'preparing' }, { type: 'prerequisite_failed' })).toEqual({
      state: 'infra_error',
      infraReason: 'prerequisite_failed',
    });
    expect(transitionRun({ state: 'running' }, { type: 'supervisor_lost' }).infraReason).toBe('supervisor_lost');
  });
});
