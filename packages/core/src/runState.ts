/**
 * Run lifecycle state machine (CORE-003; data model §Run lifecycle; ADR-0007).
 *
 * The transition table is data so a docs-sync test can compare it with the canonical Mermaid diagram.
 * Invariants: terminal states are immutable; `cancelled`/`timed_out` are reachable only after termination is
 * confirmed; an unconfirmed cancellation ends in `infra_error(cancel_unconfirmed)`, never `cancelled`.
 */
import { STATUS_CATEGORY_BY_STATE, TERMINAL_RUN_STATES } from '@autotest/contracts';
import type { CancelReason, InfraReason, RunState, StatusCategory } from '@autotest/contracts';

/** Current lifecycle position of a run, plus the reasons that qualify certain states. */
export interface RunStatus {
  readonly state: RunState;
  readonly cancelReason?: CancelReason;
  readonly infraReason?: InfraReason;
}

/** Events that drive the lifecycle (emitted by the run manager and the supervisor). */
export type RunEventInput =
  | { readonly type: 'slot_acquired' }
  | { readonly type: 'cancel_requested'; readonly reason: CancelReason }
  | { readonly type: 'prerequisites_ok' }
  | { readonly type: 'prerequisite_failed' }
  | { readonly type: 'supervisor_lost' }
  | { readonly type: 'attempts_finished' }
  | { readonly type: 'runner_crashed' }
  | { readonly type: 'evidence_collected' }
  | { readonly type: 'storage_error' }
  | { readonly type: 'analysis_done' }
  | { readonly type: 'internal_error' }
  | { readonly type: 'termination_confirmed' }
  | { readonly type: 'survivors_after_kill' }
  | { readonly type: 'survivors_gone' }
  | { readonly type: 'verification_window_exceeded' };

export class InvalidRunTransitionError extends Error {
  override readonly name = 'InvalidRunTransitionError';
  readonly from: RunState;
  readonly event: RunEventInput['type'];
  constructor(from: RunState, event: RunEventInput['type']) {
    super(`invalid run transition: ${from} --${event}-->`);
    this.from = from;
    this.event = event;
  }
}

type Rule = { readonly to: RunState; readonly reasons?: readonly CancelReason[]; readonly infra?: InfraReason };

/** Which cancel reasons a state accepts (data model diagram labels). */
const CANCEL_FROM: Partial<Record<RunState, readonly CancelReason[]>> = {
  queued: ['user', 'authorization_invalidated'],
  preparing: ['user', 'timeout', 'authorization_invalidated', 'resource_quota'],
  running: ['user', 'timeout', 'resource_quota'],
};

const TABLE: Partial<Record<RunState, Partial<Record<RunEventInput['type'], Rule>>>> = {
  queued: { slot_acquired: { to: 'preparing' }, cancel_requested: { to: 'cancelling' } },
  preparing: {
    prerequisites_ok: { to: 'running' },
    cancel_requested: { to: 'cancelling' },
    prerequisite_failed: { to: 'infra_error', infra: 'prerequisite_failed' },
    supervisor_lost: { to: 'infra_error', infra: 'supervisor_lost' },
  },
  running: {
    attempts_finished: { to: 'collecting' },
    cancel_requested: { to: 'cancelling' },
    runner_crashed: { to: 'infra_error', infra: 'runner_crashed' },
    supervisor_lost: { to: 'infra_error', infra: 'supervisor_lost' },
  },
  collecting: { evidence_collected: { to: 'analyzing' }, storage_error: { to: 'infra_error', infra: 'storage_error' } },
  analyzing: { analysis_done: { to: 'completed' }, internal_error: { to: 'infra_error', infra: 'internal' } },
  cancelling: { termination_confirmed: { to: 'cancelled' }, survivors_after_kill: { to: 'cancel_pending' } },
  cancel_pending: {
    survivors_gone: { to: 'cancelled' },
    verification_window_exceeded: { to: 'infra_error', infra: 'cancel_unconfirmed' },
  },
};

/** Applies `event` to `status`, returning the next status or throwing {@link InvalidRunTransitionError}. */
export function transitionRun(status: RunStatus, event: RunEventInput): RunStatus {
  const rule = TABLE[status.state]?.[event.type];
  if (!rule) throw new InvalidRunTransitionError(status.state, event.type);

  if (event.type === 'cancel_requested') {
    if (!CANCEL_FROM[status.state]?.includes(event.reason))
      throw new InvalidRunTransitionError(status.state, event.type);
    return { state: 'cancelling', cancelReason: event.reason };
  }
  if (event.type === 'termination_confirmed' || event.type === 'survivors_gone') {
    if (status.cancelReason === undefined) throw new InvalidRunTransitionError(status.state, event.type);
    // A confirmed timeout cancellation is reported as timed_out; user/authorization cancellations as cancelled.
    return { state: status.cancelReason === 'timeout' ? 'timed_out' : 'cancelled', cancelReason: status.cancelReason };
  }
  if (event.type === 'survivors_after_kill') {
    return { state: 'cancel_pending', ...(status.cancelReason ? { cancelReason: status.cancelReason } : {}) };
  }
  if (rule.infra)
    return {
      state: 'infra_error',
      infraReason: rule.infra,
      ...(status.cancelReason ? { cancelReason: status.cancelReason } : {}),
    };
  return { state: rule.to };
}

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

export function statusCategoryOf(state: RunState): StatusCategory {
  return STATUS_CATEGORY_BY_STATE[state];
}

/** Every (from, to) pair the machine can produce — compared against the canonical diagram by tests. */
export function allowedTransitions(): ReadonlyArray<readonly [RunState, RunState]> {
  const pairs = new Set<string>();
  for (const [from, rules] of Object.entries(TABLE)) {
    for (const [event, rule] of Object.entries(rules ?? {})) {
      if (event === 'termination_confirmed' || event === 'survivors_gone') {
        pairs.add(`${from}>cancelled`);
        pairs.add(`${from}>timed_out`);
      } else pairs.add(`${from}>${rule!.to}`);
    }
  }
  return [...pairs].map((p) => p.split('>') as [RunState, RunState]);
}
