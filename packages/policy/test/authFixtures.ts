/** Fixtures for AUTH-002/003 built from contracts only (policy tests may not import @autotest/core). */
import { Approval, CoverageDecision, TestPlan, computePlanHash } from '@autotest/contracts';
import {
  loadPolicyConfig,
  planExecutionScope,
  type AuthorizationInputs,
  type LoadedPolicy,
  type ResolvedWorkspace,
} from '@autotest/policy';

export const NOW = new Date('2026-10-23T01:00:00Z');
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const ulid = (c: string) => `01JC${c.repeat(22)}`;

export function policy(extra = ''): LoadedPolicy {
  const r = loadPolicyConfig(
    `version: 1\nworkspaces: [{ id: ws_app, path: /src/app, github: { host: github.com, owner: example, name: app } }]\n${extra}`,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.policy;
}

const tc = (id: string, targetRef: string | null, eligibility: string) => ({
  id,
  title: `Case ${id}`,
  requirementRefs: ['REQ-001'],
  acRefs: ['REQ-001.AC-01'],
  level: 'widget',
  technique: 'positive',
  priority: 'must',
  platforms: ['host'],
  preconditions: [],
  steps: ['Pump widget'],
  expectedResults: ["Text '3' is visible"],
  targetRef,
  automation: 'existing_test',
  eligibility,
  riskTier: 'R1',
});

export const TT_A = 'TT-flutter-aaaaaaaaaaaa';
export const TT_B = 'TT-flutter-bbbbbbbbbbbb';

export function plan(overrides: Record<string, unknown> = {}): TestPlan {
  const draft = {
    id: `plan_${ulid('5')}`,
    version: 1,
    schemaVersion: 1,
    createdAt: '2026-10-23T00:00:00Z',
    planHash: `v1:sha256:${'0'.repeat(64)}`,
    hashVersion: 1,
    requirementSetId: `rqs_${ulid('4')}`,
    requirementSetHash: sha('a'),
    inventoryId: `inv_${ulid('3')}`,
    repository: { host: 'github.com', owner: 'example', name: 'app' },
    headSha: null,
    riskPolicyVersion: sha('b'),
    platformsInScope: ['host'],
    testCases: [
      tc('TC-001', TT_A, 'eligible'),
      tc('TC-002', TT_B, 'eligible'),
      tc('TC-003', null, 'ineligible:no_target'),
    ],
    exceptions: [],
    ambiguities: [],
    assumptions: [],
    ...overrides,
  } as TestPlan;
  return TestPlan.parse({ ...draft, planHash: computePlanHash(draft) });
}

export function decision(
  p: TestPlan,
  pol: LoadedPolicy,
  value: 'pass' | 'fail' | 'needs_review' = 'pass',
): CoverageDecision {
  return CoverageDecision.parse({
    id: `cov_${ulid('6')}`,
    schemaVersion: 1,
    planId: p.id,
    planHash: p.planHash,
    requirementSetHash: p.requirementSetHash,
    gatePolicyVersion: pol.gatePolicyVersion,
    decision: value,
    findings: [],
    metrics: {
      requirementCoverage: null,
      testCaseCoverage: null,
      sourceCodeCoverage: null,
      platformCoverage: null,
      regressionCoverage: null,
      executionCoverage: null,
    },
    requirementStatus: [],
    evaluatedAt: '2026-10-23T00:10:00Z',
  });
}

export function approvalFor(
  p: TestPlan,
  pol: LoadedPolicy,
  targets: string[],
  overrides: Record<string, unknown> = {},
): Approval {
  return Approval.parse({
    id: `appr_${ulid('9')}`,
    schemaVersion: 1,
    scope: planExecutionScope({ planHash: p.planHash, environment: 'local:host1', targetIds: targets }),
    planHash: p.planHash,
    environment: 'local:host1',
    policyVersion: pol.policyVersion,
    source: 'cli',
    assuranceLevel: 'AL2',
    approver: { osUser: 'dev' },
    createdAt: '2026-10-23T00:20:00Z',
    expiresAt: '2026-10-24T00:00:00Z',
    maxUses: 3,
    uses: 0,
    state: 'approved',
    ...overrides,
  });
}

export const WORKSPACE: ResolvedWorkspace = {
  id: 'ws_app',
  configuredPath: '/src/app',
  realPath: '/src/app',
  readOnlyReference: false,
  github: { host: 'github.com', owner: 'example', name: 'app' },
};

/** A fully valid, authorizable input for a `pass` decision. */
export function validInputs(over: Partial<AuthorizationInputs> = {}): AuthorizationInputs {
  const pol = policy();
  const p = plan();
  return {
    decisionId: `authz_${ulid('7')}`,
    phase: 'create',
    now: NOW,
    request: {
      planId: p.id,
      planHash: p.planHash,
      targets: ['TC-001', TT_B],
      deviceIds: [],
      environment: 'local:host1',
    },
    serverEnvironment: { id: 'local:host1', kind: 'local' },
    policy: pol,
    plan: p,
    latestPlanVersion: 1,
    currentRequirementSetHash: p.requirementSetHash,
    coverage: decision(p, pol),
    approvals: [],
    workspace: WORKSPACE,
    devices: [],
    commands: [
      { targetId: TT_A, ok: true },
      { targetId: TT_B, ok: true },
    ],
    prerequisites: { satisfied: true },
    ...over,
  };
}
