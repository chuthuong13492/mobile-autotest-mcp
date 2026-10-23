import { describe, expect, it } from 'vitest';
import { TOOLS, toolError } from '@autotest/core';
import { bindUseCases, fail, ok, type UseCases } from '@autotest/workflow';

const ctx = { sessionId: 's1', toolCallId: 'call-1', actor: 'agent' } as const;
const RUN = 'run_01JC000000000000000000000A';
const status = {
  runId: RUN,
  state: 'running',
  statusCategory: 'running',
  cancelReason: null,
  infraReason: null,
  progress: { attemptsStarted: 1, attemptsFinished: 0, testsByOutcome: { passed: 1 } },
  survivors: [],
  partial: false,
  limitations: [],
  createdAt: '2026-10-23T00:00:00Z',
  startedAt: null,
  endedAt: null,
  pollAfterMs: 5000,
};

/** Every use case fails with E_INTERNAL unless overridden — enough to exercise the boundary. */
const allUnimplemented = Object.fromEntries(
  TOOLS.map((t) => [t.name, async () => fail(toolError('E_INTERNAL', 'not wired in this test'))]),
) as unknown as UseCases;

describe('CORE-006 workflow contract boundary', () => {
  it('requires a use case for every catalog tool', () => {
    const { get_run_status: _drop, ...partial } = allUnimplemented;
    void _drop;
    expect(() => bindUseCases(partial as UseCases)).toThrow(/missing use cases: get_run_status/);
  });

  it('passes valid input through and returns schema-checked output', async () => {
    let seen: unknown;
    const wf = bindUseCases({
      ...allUnimplemented,
      get_run_status: async (input) => ((seen = input), ok(status as never)),
    });
    const r = await wf.get_run_status({ runId: RUN }, ctx);
    expect(r.ok).toBe(true);
    expect(seen).toEqual({ runId: RUN });
  });

  it('rejects invalid input with E_VALIDATION and JSON pointers, without running the use case', async () => {
    let ran = false;
    const wf = bindUseCases({
      ...allUnimplemented,
      run_tests: async () => ((ran = true), fail(toolError('E_INTERNAL', 'x'))),
    });
    const r = await wf.run_tests({ planId: 'nope', planHash: 'bad', command: 'rm -rf /' }, ctx);
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error.code).toBe('E_VALIDATION');
      const pointers = (r.error.error.details!.issues as { pointer: string }[]).map((i) => i.pointer);
      expect(pointers).toEqual(expect.arrayContaining(['/planId', '/planHash']));
    }
  });

  it('turns contract-violating output into E_INTERNAL instead of leaking it', async () => {
    const wf = bindUseCases({
      ...allUnimplemented,
      get_run_status: async () => ok({ ...status, state: 'exploded' } as never),
    });
    const r = await wf.get_run_status({ runId: RUN }, ctx);
    expect(r.ok ? 'ok' : r.error.error.code).toBe('E_INTERNAL');
  });

  it('never exposes thrown error messages', async () => {
    const wf = bindUseCases({
      ...allUnimplemented,
      get_run_status: async () => {
        throw new Error('secret token abc123');
      },
    });
    const r = await wf.get_run_status({ runId: RUN }, ctx);
    expect(JSON.stringify(r)).not.toContain('abc123');
    expect(r.ok ? '' : r.error.error.details?.correlationId).toBe('call-1');
  });

  it('applies schema defaults before the use case sees the input', async () => {
    let seen: { limit?: number } = {};
    const wf = bindUseCases({
      ...allUnimplemented,
      get_run_results: async (input) => ((seen = input), fail(toolError('E_RUN_NOT_FOUND', 'x'))),
    });
    await wf.get_run_results({ runId: RUN }, ctx);
    expect(seen.limit).toBe(50);
  });
});
