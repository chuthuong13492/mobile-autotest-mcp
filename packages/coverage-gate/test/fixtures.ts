/** Gate fixtures built from contract schemas only (the gate may not reach `planning`, even in tests). */
import {
  computePlanHash,
  computeRequirementSetHash,
  RequirementSet,
  TestPlan,
  type RiskTier,
  type TestCase,
} from '@autotest/core';
import type { GateConfig, GateInput } from '@autotest/coverage-gate';

export const NOW = new Date('2026-10-23T01:00:00Z');
const factors = (tier: RiskTier) =>
  ({
    R0: {
      functionalImpact: 1,
      securityPrivacyImpact: 1,
      dataIntegrityImpact: 1,
      criticalJourney: false,
      regressionLikelihood: 1,
      changeSurface: 1,
      uncertainty: 1,
      platformSpecificity: 1,
    },
    R1: {
      functionalImpact: 3,
      securityPrivacyImpact: 1,
      dataIntegrityImpact: 1,
      criticalJourney: false,
      regressionLikelihood: 2,
      changeSurface: 2,
      uncertainty: 1,
      platformSpecificity: 1,
    },
    R2: {
      functionalImpact: 3,
      securityPrivacyImpact: 2,
      dataIntegrityImpact: 2,
      criticalJourney: false,
      regressionLikelihood: 3,
      changeSurface: 2,
      uncertainty: 2,
      platformSpecificity: 1,
    },
    R3: {
      functionalImpact: 4,
      securityPrivacyImpact: 3,
      dataIntegrityImpact: 3,
      criticalJourney: true,
      regressionLikelihood: 4,
      changeSurface: 3,
      uncertainty: 2,
      platformSpecificity: 1,
    },
  })[tier];

export const req = (n: number, tier: RiskTier, acs = 1, over: Record<string, unknown> = {}) => {
  const id = `REQ-${String(n).padStart(3, '0')}`;
  return {
    id,
    title: `Requirement ${n}`,
    statement: `Requirement ${n}`,
    kind: 'functional',
    testable: true,
    provenance: 'parsed',
    platforms: [],
    riskFactors: factors(tier),
    riskTier: tier,
    acceptanceCriteria: Array.from({ length: acs }, (_, i) => ({
      id: `${id}.AC-${String(i + 1).padStart(2, '0')}`,
      text: `AC ${i + 1}`,
      format: 'freeform',
      observable: true,
      provenance: 'parsed',
    })),
    ...over,
  };
};

export const tc = (n: number, reqId: string, over: Partial<TestCase> = {}): TestCase => ({
  id: `TC-${String(n).padStart(3, '0')}`,
  title: `Case ${n}`,
  requirementRefs: [reqId],
  acRefs: [`${reqId}.AC-01`],
  level: 'unit',
  technique: 'positive',
  priority: 'should',
  platforms: ['host'],
  preconditions: [],
  steps: [`step ${n}`],
  expectedResults: [`Text '${n}' is visible`],
  targetRef: 'TT-flutter-1a2b3c4d5e6f',
  automation: 'existing_test',
  eligibility: 'eligible',
  riskTier: 'R1',
  ...over,
});

export function build(o: {
  reqs: ReturnType<typeof req>[];
  cases: TestCase[];
  exceptions?: TestPlan['exceptions'];
  ambiguities?: unknown[];
  assumptions?: unknown[];
  scope?: TestPlan['platformsInScope'];
  display?: TestPlan['display'];
}) {
  // A plan needs at least one case: an unrelated, fully covered R0 filler keeps "no case for REQ-001" fixtures valid.
  if (o.cases.length === 0)
    o = {
      ...o,
      reqs: [...o.reqs, req(99, 'R0')],
      cases: [tc(99, 'REQ-099', { steps: ['filler'], expectedResults: ["Text 'filler' is visible"] })],
    };
  const content = { requirements: o.reqs, ambiguities: o.ambiguities ?? [], assumptions: o.assumptions ?? [] } as Pick<
    RequirementSet,
    'requirements' | 'ambiguities' | 'assumptions'
  >;
  const set = RequirementSet.parse({
    id: 'rqs_01JC0000000000000000000004',
    schemaVersion: 1,
    createdAt: '2026-10-23T00:00:00Z',
    prContextId: 'prc_01JC0000000000000000000001',
    ...content,
    requirementSetHash: computeRequirementSetHash(content),
  });
  const draft = {
    id: 'plan_01JC0000000000000000000005',
    version: 1,
    schemaVersion: 1,
    createdAt: '2026-10-23T00:00:00Z',
    planHash: '',
    hashVersion: 1,
    requirementSetId: set.id,
    requirementSetHash: set.requirementSetHash,
    inventoryId: 'inv_01JC0000000000000000000003',
    repository: { host: 'local', localPath: '/src/app' },
    headSha: null,
    riskPolicyVersion: `sha256:${'b'.repeat(64)}`,
    platformsInScope: o.scope ?? ['host'],
    testCases: o.cases,
    exceptions: o.exceptions ?? [],
    ambiguities: set.ambiguities,
    assumptions: set.assumptions,
    ...(o.display ? { display: o.display } : {}),
  } as unknown as TestPlan;
  const plan = TestPlan.parse({ ...draft, planHash: computePlanHash(draft) });
  return { plan, set };
}

export const CONFIG: GateConfig = {
  thresholds: { requirementCoverageMin: 1, testCaseCoverageMin: 1, platformCoverageMin: 0.8, regressionCoverageMin: 1 },
  rules: {
    'GR-02': {
      enabled: true,
      vagueTerms: ['works', 'correctly', 'properly', 'as expected', 'is fine', 'no issues', 'looks good'],
      observableVerbs: ['shows', 'hides', 'returns', 'navigates', 'emits', 'equals', 'contains', 'is disabled'],
    },
    'GR-03': { enabled: true },
    'GR-05': { enabled: true },
    'GR-06': { enabled: true },
    'GR-08': { enabled: true },
    'GR-09': { enabled: true, depth: 2 },
    'GR-10': { promote: false },
  },
  exceptionMaxDays: 30,
};

export const TARGET = {
  id: 'TT-flutter-1a2b3c4d5e6f',
  adapterId: 'flutter',
  level: 'unit' as const,
  path: 'test/widgets/badge_test.dart',
  platforms: ['host' as const],
  requires: { host: 'any' as const, device: 'none' as const },
  tags: [],
};

export function input(b: ReturnType<typeof build>, over: Partial<GateInput> = {}): GateInput {
  return {
    plan: b.plan,
    requirementSet: b.set,
    config: CONFIG,
    targets: [TARGET],
    approvedExceptions: new Set(),
    changedFiles: [],
    now: NOW,
    ...over,
  };
}
