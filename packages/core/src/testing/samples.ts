/**
 * Schema-valid sample entities for tests. Every builder parses its result through the contracts schema,
 * so a sample that drifts from the contracts fails loudly instead of silently testing the wrong shape.
 */
import {
  Approval,
  ApprovalRequest,
  CoverageDecision,
  EvidenceArtifact,
  PRContext,
  ProjectProfile,
  Run,
  TestInventory,
  TestPlan,
  TestResult,
  computePlanHash,
  type Approval as ApprovalT,
  type ApprovalRequest as ApprovalRequestT,
  type CoverageDecision as CoverageDecisionT,
  type EvidenceArtifact as EvidenceArtifactT,
  type PRContext as PRContextT,
  type ProjectProfile as ProjectProfileT,
  type TestInventory as TestInventoryT,
  type Run as RunT,
  type TestPlan as TestPlanT,
  type TestResult as TestResultT,
} from '@autotest/contracts';

const ulid = (c: string) => `01JC${c.repeat(22)}`;
export const sha = (c: string): string => `sha256:${c.repeat(64)}`;
export const T0 = '2026-10-23T00:00:00Z';

/** A valid plan whose `planHash` is correctly computed from its content. */
export function samplePlan(overrides: Partial<TestPlanT> = {}): TestPlanT {
  const draft = {
    id: `plan_${ulid('5')}`,
    version: 1,
    schemaVersion: 1,
    createdAt: T0,
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
      {
        id: 'TC-001',
        clientKey: 'badge-count',
        title: 'Badge shows new listing count',
        requirementRefs: ['REQ-001'],
        acRefs: ['REQ-001.AC-01'],
        level: 'widget',
        technique: 'positive',
        priority: 'must',
        platforms: ['host'],
        preconditions: ['3 new listings stubbed'],
        steps: ['Pump SavedSearchBadge with count 3'],
        expectedResults: ["Text '3' is visible in badge"],
        targetRef: 'TT-flutter-1a2b3c4d5e6f',
        automation: 'existing_test',
        eligibility: 'eligible',
        riskTier: 'R1',
      },
    ],
    exceptions: [],
    ambiguities: [],
    assumptions: [],
    ...overrides,
  } as TestPlanT;
  return TestPlan.parse({ ...draft, planHash: computePlanHash(draft) });
}

export function sampleDecision(overrides: Partial<CoverageDecisionT> = {}): CoverageDecisionT {
  return CoverageDecision.parse({
    id: `cov_${ulid('6')}`,
    schemaVersion: 1,
    planId: `plan_${ulid('5')}`,
    planHash: `v1:sha256:${'1'.repeat(64)}`,
    requirementSetHash: sha('a'),
    gatePolicyVersion: sha('c'),
    decision: 'pass',
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
    evaluatedAt: T0,
    ...overrides,
  });
}

export function sampleApproval(overrides: Partial<ApprovalT> = {}): ApprovalT {
  return Approval.parse({
    id: `appr_${ulid('9')}`,
    schemaVersion: 1,
    scope: { kind: 'plan_execution', digest: sha('d'), params: {} },
    planHash: `v1:sha256:${'1'.repeat(64)}`,
    environment: 'local:host1',
    policyVersion: sha('e'),
    source: 'cli',
    assuranceLevel: 'AL2',
    approver: { osUser: 'dev' },
    createdAt: T0,
    expiresAt: '2026-10-24T00:00:00Z',
    maxUses: 3,
    uses: 0,
    state: 'approved',
    ...overrides,
  });
}

export function sampleApprovalRequest(overrides: Partial<ApprovalRequestT> = {}): ApprovalRequestT {
  return ApprovalRequest.parse({
    id: `apr_${ulid('8')}`,
    schemaVersion: 1,
    createdAt: T0,
    expiresAt: '2026-10-23T04:00:00Z',
    scope: { kind: 'plan_execution', digest: sha('d'), params: {} },
    requiredAssurance: 'AL2',
    status: 'open',
    instructions: { cliCommand: `autotest approve apr_${ulid('8')}`, expiresAt: '2026-10-23T04:00:00Z' },
    createdBy: 'agent',
    ...overrides,
  });
}

export function sampleRun(overrides: Partial<RunT> = {}): RunT {
  return Run.parse({
    id: `run_${ulid('A')}`,
    schemaVersion: 1,
    planId: `plan_${ulid('5')}`,
    planHash: `v1:sha256:${'1'.repeat(64)}`,
    targets: ['TC-001'],
    environment: 'local',
    devices: [],
    state: 'queued',
    statusCategory: 'pending',
    requestDigest: sha('f'),
    authorizationIds: [`authz_${ulid('B')}`],
    timeouts: { runMs: 2_700_000, attemptMs: 1_800_000, targetMs: 600_000 },
    retryPolicy: { maxAttempts: 2, retryOn: ['infrastructure', 'flaky'] },
    counts: {},
    partial: false,
    limitations: [],
    createdAt: T0,
    ...overrides,
  });
}

export function sampleResult(n: number, overrides: Partial<TestResultT> = {}): TestResultT {
  return TestResult.parse({
    id: `res_01JC${String(n).padStart(22, '0')}`,
    runId: `run_${ulid('A')}`,
    attemptNo: 1,
    testCaseIds: ['TC-001'],
    targetId: 'TT-flutter-1a2b3c4d5e6f',
    name: `test ${n}`,
    outcome: n % 3 === 0 ? 'failed' : 'passed',
    flaky: false,
    artifactRefs: [],
    rawStatus: 'success',
    ...overrides,
  });
}

export function sampleArtifact(overrides: Partial<EvidenceArtifactT> = {}): EvidenceArtifactT {
  return EvidenceArtifact.parse({
    id: `art_${ulid('D')}`,
    runId: `run_${ulid('A')}`,
    kind: 'junit',
    relativePath: 'attempts/1/runner/junit.xml',
    mimeType: 'application/xml',
    sizeBytes: 10,
    sha256: sha('0'),
    redaction: { applied: true, rulesetVersion: 'redact-1', findingsCount: 0 },
    quarantined: false,
    provenance: { producer: 'flutter' },
    truncated: false,
    ...overrides,
  });
}

export function sampleProfile(overrides: Partial<ProjectProfileT> = {}): ProjectProfileT {
  return ProjectProfile.parse({
    id: `prj_${ulid('2')}`,
    schemaVersion: 1,
    createdAt: T0,
    workspace: { rootRealPath: '/src/app', allowlistEntryId: 'ws_app' },
    frameworks: [{ adapterId: 'flutter', confidence: 0.98, evidence: ['pubspec.yaml'] }],
    platforms: [{ platform: 'host', status: 'present', evidence: ['test/'] }],
    languages: ['dart'],
    toolchains: [],
    runners: [{ adapterId: 'flutter', kind: 'flutter_test', configured: true, evidence: ['test/'] }],
    limitations: [],
    ...overrides,
  });
}

export function sampleInventory(overrides: Partial<TestInventoryT> = {}): TestInventoryT {
  return TestInventory.parse({
    id: `inv_${ulid('3')}`,
    schemaVersion: 1,
    createdAt: T0,
    profileId: `prj_${ulid('2')}`,
    targets: [
      {
        id: 'TT-flutter-1a2b3c4d5e6f',
        adapterId: 'flutter',
        level: 'widget',
        path: 'test/a_test.dart',
        selector: { kind: 'file', value: 'test/a_test.dart' },
        platforms: ['host'],
        requires: { host: 'any', device: 'none' },
        tags: [],
      },
    ],
    helpers: [],
    automationConfigs: [],
    counts: { total: 1, byLevel: { widget: 1 }, byAdapter: { flutter: 1 } },
    completeness: { complete: true, truncatedAt: null, reasons: [] },
    limits: { maxFiles: 50000, maxBytes: 262144 },
    ...overrides,
  });
}

export function samplePrContext(overrides: Partial<PRContextT> = {}): PRContextT {
  return PRContext.parse({
    id: `prc_${ulid('1')}`,
    schemaVersion: 1,
    createdAt: T0,
    source: 'manual',
    repository: { host: 'local', localPath: '/src/app' },
    title: 'Add saved-search badge',
    body: '## Acceptance criteria\n- [ ] Badge shows count of new listings\n',
    limitations: [],
    untrustedFields: ['/title', '/body'],
    ...overrides,
  });
}
