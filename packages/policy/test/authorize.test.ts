import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AUTHORIZATION_REASONS, TestPlan, type AuthorizationReason } from '@autotest/contracts';
import { authorizeExecution, type AuthorizationInputs } from '@autotest/policy';
import { NOW, TT_A, TT_B, WORKSPACE, approvalFor, decision, plan, policy, validInputs } from './authFixtures.ts';

const reasonsOf = (i: AuthorizationInputs) => authorizeExecution(i).decision.reasons;

describe('AUTH-003 authorizeExecution', () => {
  it('authorizes a fully valid pass request and resolves targets', () => {
    const out = authorizeExecution(validInputs());
    expect(out.decision).toMatchObject({
      result: 'authorized',
      reasons: [],
      phase: 'create',
      evaluatedAt: '2026-10-23T01:00:00Z',
    });
    expect(out.resolvedTargets).toEqual([TT_A, TT_B]);
    expect(out.approvalId).toBeUndefined();
    expect(authorizeExecution(validInputs()).decision.inputsDigest).toBe(out.decision.inputsDigest);
  });

  it('needs_review requires a usable approval for exactly this scope, and returns it for consumption', () => {
    const base = validInputs();
    const nr = { ...base, coverage: decision(base.plan!, base.policy!, 'needs_review') };
    expect(reasonsOf(nr)).toEqual(['approval_required']);
    const a = approvalFor(base.plan!, base.policy!, [TT_A, TT_B]);
    expect(authorizeExecution({ ...nr, approvals: [a] })).toMatchObject({
      decision: { result: 'authorized' },
      approvalId: a.id,
    });
    const narrower = approvalFor(base.plan!, base.policy!, [TT_A]);
    expect(reasonsOf({ ...nr, approvals: [narrower] })).toEqual(['approval_stale']);
  });

  it('a gate pass alone is not enough: targets, workspace and commands must all be allowed (AC 3)', () => {
    expect(reasonsOf(validInputs({ request: { ...validInputs().request, targets: ['TC-003'] } }))).toEqual([
      'target_not_eligible',
    ]);
    expect(
      reasonsOf(validInputs({ request: { ...validInputs().request, targets: ['TT-flutter-cccccccccccc'] } })),
    ).toEqual(['target_not_eligible']);
    expect(reasonsOf(validInputs({ request: { ...validInputs().request, targets: [] } }))).toEqual([
      'target_not_eligible',
    ]);
    expect(reasonsOf(validInputs({ workspace: undefined }))).toEqual(['workspace_not_allowed']);
  });

  const fixtures: [AuthorizationReason, () => AuthorizationInputs][] = [
    [
      'plan_hash_mismatch',
      () => validInputs({ request: { ...validInputs().request, planHash: `v1:sha256:${'9'.repeat(64)}` } }),
    ],
    ['coverage_missing', () => validInputs({ coverage: undefined })],
    [
      'coverage_stale',
      () => {
        const i = validInputs();
        return { ...i, policy: policy('coverageGate: { thresholds: { platformCoverageMin: 0.5 } }\n') };
      },
    ],
    [
      'coverage_failed',
      () => {
        const i = validInputs();
        return { ...i, coverage: decision(i.plan!, i.policy!, 'fail') };
      },
    ],
    [
      'approval_required',
      () => {
        const i = validInputs();
        return { ...i, coverage: decision(i.plan!, i.policy!, 'needs_review') };
      },
    ],
    [
      'approval_stale',
      () => {
        const i = validInputs();
        return {
          ...i,
          coverage: decision(i.plan!, i.policy!, 'needs_review'),
          approvals: [approvalFor(i.plan!, i.policy!, [TT_A, TT_B], { policyVersion: `sha256:${'8'.repeat(64)}` })],
        };
      },
    ],
    [
      'approval_expired',
      () => {
        const i = validInputs();
        return {
          ...i,
          coverage: decision(i.plan!, i.policy!, 'needs_review'),
          approvals: [approvalFor(i.plan!, i.policy!, [TT_A, TT_B], { expiresAt: '2026-10-23T00:30:00Z' })],
        };
      },
    ],
    [
      'approval_revoked',
      () => {
        const i = validInputs();
        return {
          ...i,
          coverage: decision(i.plan!, i.policy!, 'needs_review'),
          approvals: [approvalFor(i.plan!, i.policy!, [TT_A, TT_B], { state: 'revoked' })],
        };
      },
    ],
    [
      'approval_exhausted',
      () => {
        const i = validInputs();
        return {
          ...i,
          coverage: decision(i.plan!, i.policy!, 'needs_review'),
          approvals: [approvalFor(i.plan!, i.policy!, [TT_A, TT_B], { uses: 3 })],
        };
      },
    ],
    [
      'assurance_insufficient',
      () => {
        const i = validInputs();
        return {
          ...i,
          coverage: decision(i.plan!, i.policy!, 'needs_review'),
          approvals: [approvalFor(i.plan!, i.policy!, [TT_A, TT_B], { source: 'elicitation', assuranceLevel: 'AL1' })],
        };
      },
    ],
    ['workspace_not_allowed', () => validInputs({ workspace: { ...WORKSPACE, readOnlyReference: true } })],
    ['target_not_eligible', () => validInputs({ request: { ...validInputs().request, targets: ['TC-999'] } })],
    [
      'device_not_allowed',
      () =>
        validInputs({
          request: { ...validInputs().request, deviceIds: ['SIM-1'] },
          devices: [{ deviceId: 'SIM-1', allowed: false }],
        }),
    ],
    [
      'environment_not_allowed',
      () => validInputs({ request: { ...validInputs().request, environment: 'local:other' } }),
    ],
    [
      'command_denied',
      () =>
        validInputs({
          commands: [
            { targetId: TT_A, ok: true },
            { targetId: TT_B, ok: false },
          ],
        }),
    ],
    ['prerequisite_missing', () => validInputs({ prerequisites: { satisfied: false } })],
    ['superseded', () => validInputs({ latestPlanVersion: 2 })],
    ['cancelled', () => validInputs({ phase: 'dispatch', cancellation: { requested: true } })],
    ['policy_unavailable', () => validInputs({ policy: undefined })],
    ['unknown_state', () => validInputs({ phase: 'dispatch' })],
  ];

  it('has a fixture for every authorization reason code (AC 1)', () => {
    expect(fixtures.map(([r]) => r).sort()).toEqual([...AUTHORIZATION_REASONS].sort());
  });
  for (const [reason, make] of fixtures) {
    it(`denies with ${reason}`, () => {
      const d = authorizeExecution(make()).decision;
      expect(d.result).toBe('denied');
      expect(d.reasons).toContain(reason);
    });
  }

  it('workspace must match the plan repository; a tampered plan snapshot is detected', () => {
    expect(
      reasonsOf(
        validInputs({ workspace: { ...WORKSPACE, github: { host: 'github.com', owner: 'example', name: 'other' } } }),
      ),
    ).toEqual(['workspace_not_allowed']);
    const i = validInputs();
    const tampered = TestPlan.parse({
      ...i.plan!,
      testCases: [{ ...i.plan!.testCases[0]!, title: 'edited after the gate' }, ...i.plan!.testCases.slice(1)],
    });
    expect(reasonsOf({ ...i, plan: tampered })).toContain('plan_hash_mismatch');
  });

  it('dispatch with a known, unrequested cancellation is authorized', () => {
    expect(
      authorizeExecution(
        validInputs({ phase: 'dispatch', runId: 'run_01JCAAAAAAAAAAAAAAAAAAAAAA', cancellation: { requested: false } }),
      ).decision,
    ).toMatchObject({ result: 'authorized', runId: 'run_01JCAAAAAAAAAAAAAAAAAAAAAA' });
  });

  it('property: authorization is never granted when any input is missing or corrupted (AC 2)', () => {
    const keys = [
      'policy',
      'plan',
      'latestPlanVersion',
      'currentRequirementSetHash',
      'coverage',
      'workspace',
      'commands',
      'prerequisites',
      'serverEnvironment',
      'devices',
      'request',
      'cancellation',
    ] as const;
    fc.assert(
      fc.property(
        fc.subarray([...keys], { minLength: 1 }),
        fc.constantFrom<unknown>(undefined, { bogus: true }, null, 'x', 1, true, []),
        fc.constantFrom<'create' | 'dispatch'>('create', 'dispatch'),
        (drop, bad, phase) => {
          const i: Record<string, unknown> = {
            ...validInputs({ phase }),
            ...(phase === 'dispatch' ? { cancellation: { requested: false } } : {}),
          };
          if (drop.length === 1 && drop[0] === 'cancellation' && phase === 'create' && bad === undefined) return true; // optional at create
          if (drop.every((k) => JSON.stringify(i[k]) === JSON.stringify(bad))) return true; // replacing a value with itself is not corruption
          for (const k of drop) i[k] = bad;
          return authorizeExecution(i as unknown as AuthorizationInputs).decision.result === 'denied';
        },
      ),
      { numRuns: 400 },
    );
  });

  it('property: the inputs digest changes whenever the decision basis changes', () => {
    const base = authorizeExecution(validInputs()).decision.inputsDigest;
    const variants = [
      validInputs({ now: NOW, request: { ...validInputs().request, targets: ['TC-001'] } }),
      validInputs({ latestPlanVersion: 2 }),
      validInputs({ prerequisites: { satisfied: false } }),
      validInputs({ plan: plan({ headSha: 'b'.repeat(40) }) }),
    ];
    for (const v of variants) expect(authorizeExecution(v).decision.inputsDigest).not.toBe(base);
  });
});
