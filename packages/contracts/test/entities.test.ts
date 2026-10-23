import { describe, expect, it } from 'vitest';
import {
  Approval,
  EvidenceArtifact,
  ExecutionAuthorizationDecision,
  FailureAnalysis,
  PlanHash,
  ProjectProfile,
  Requirement,
  RunEvent,
  TestCase,
} from '@autotest/contracts';

const ulid = (c: string) => `01JC${c.repeat(22)}`;
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const ts = '2026-10-23T00:00:00Z';

const factors = {
  functionalImpact: 3,
  securityPrivacyImpact: 1,
  dataIntegrityImpact: 1,
  criticalJourney: false,
  regressionLikelihood: 2,
  changeSurface: 2,
  uncertainty: 1,
};
const requirement = {
  id: 'REQ-001',
  title: 'Badge',
  statement: 'Badge shows count',
  kind: 'functional',
  testable: true,
  provenance: 'agent',
  platforms: ['host'],
  riskFactors: factors,
  riskTier: 'R1',
  acceptanceCriteria: [
    { id: 'REQ-001.AC-01', text: 'shows 3', format: 'checklist', observable: true, provenance: 'parsed' },
  ],
};

describe('CON-003 project profile', () => {
  const base = {
    id: `prj_${ulid('2')}`,
    schemaVersion: 1,
    createdAt: ts,
    workspace: { rootRealPath: '/w', allowlistEntryId: 'ws' },
    frameworks: [],
    languages: [],
    toolchains: [],
    runners: [],
    limitations: [],
  };
  it('requires evidence for present platforms (FR-006)', () => {
    expect(
      ProjectProfile.safeParse({ ...base, platforms: [{ platform: 'ios', status: 'present', evidence: [] }] }).success,
    ).toBe(false);
    expect(
      ProjectProfile.safeParse({
        ...base,
        platforms: [{ platform: 'ios', status: 'present', evidence: ['ios/Runner.xcodeproj'] }],
      }).success,
    ).toBe(true);
    expect(
      ProjectProfile.safeParse({ ...base, platforms: [{ platform: 'ios', status: 'unknown', evidence: [] }] }).success,
    ).toBe(true);
  });
});

describe('CON-004 requirements and plans', () => {
  it('accepts a valid requirement', () => expect(Requirement.safeParse(requirement).success).toBe(true));
  it('rejects non-testable requirement without reason', () =>
    expect(Requirement.safeParse({ ...requirement, testable: false }).success).toBe(false));
  it('rejects ACs scoped to another requirement', () =>
    expect(
      Requirement.safeParse({
        ...requirement,
        acceptanceCriteria: [{ ...requirement.acceptanceCriteria[0], id: 'REQ-002.AC-01' }],
      }).success,
    ).toBe(false));
  it('rejects unknown fields such as a generator self-assessment (ADR-0005)', () =>
    expect(Requirement.safeParse({ ...requirement, coverageSelfAssessment: 'complete' }).success).toBe(false));
  it('validates eligibility values', () => {
    const tc = {
      id: 'TC-001',
      title: 'abc',
      requirementRefs: ['REQ-001'],
      acRefs: [],
      level: 'widget',
      technique: 'positive',
      priority: 'must',
      platforms: ['host'],
      preconditions: [],
      steps: ['s'],
      expectedResults: ['e'],
      targetRef: null,
      automation: 'manual',
      riskTier: 'R1',
    };
    expect(TestCase.safeParse({ ...tc, eligibility: 'ineligible:manual' }).success).toBe(true);
    expect(TestCase.safeParse({ ...tc, eligibility: 'ineligible:because' }).success).toBe(false);
  });
  it('plan hash format', () => {
    expect(PlanHash.safeParse(`v1:sha256:${'a'.repeat(64)}`).success).toBe(true);
    expect(PlanHash.safeParse(`sha256:${'a'.repeat(64)}`).success).toBe(false);
  });
});

describe('CON-005 approvals and authorization', () => {
  const approval = {
    id: `appr_${ulid('9')}`,
    schemaVersion: 1,
    scope: { kind: 'plan_execution', digest: sha('c'), params: {} },
    planHash: `v1:sha256:${'a'.repeat(64)}`,
    environment: 'local:macbook',
    policyVersion: sha('d'),
    source: 'cli',
    assuranceLevel: 'AL2',
    approver: { osUser: 'dev' },
    createdAt: ts,
    expiresAt: ts,
    maxUses: 3,
    uses: 0,
    state: 'approved',
  };
  it('accepts a CLI AL2 approval', () => expect(Approval.safeParse(approval).success).toBe(true));
  it('elicitation can never yield AL2+ (RL-031)', () =>
    expect(Approval.safeParse({ ...approval, source: 'elicitation', assuranceLevel: 'AL2' }).success).toBe(false));
  it('AL3 needs a signature or verified reviewer', () =>
    expect(Approval.safeParse({ ...approval, assuranceLevel: 'AL3' }).success).toBe(false));
  it('uses cannot exceed maxUses', () => expect(Approval.safeParse({ ...approval, uses: 4 }).success).toBe(false));
  it('authorized iff no denial reasons (ADR-0006 §4)', () => {
    const d = { id: `authz_${ulid('B')}`, schemaVersion: 1, phase: 'create', inputsDigest: sha('e'), evaluatedAt: ts };
    expect(ExecutionAuthorizationDecision.safeParse({ ...d, result: 'authorized', reasons: [] }).success).toBe(true);
    expect(
      ExecutionAuthorizationDecision.safeParse({ ...d, result: 'authorized', reasons: ['coverage_stale'] }).success,
    ).toBe(false);
    expect(ExecutionAuthorizationDecision.safeParse({ ...d, result: 'denied', reasons: [] }).success).toBe(false);
  });
});

describe('CON-006 runs, evidence, analysis', () => {
  it('artifact paths cannot escape the run dir', () => {
    const a = {
      id: `art_${ulid('D')}`,
      runId: `run_${ulid('A')}`,
      kind: 'stderr',
      mimeType: 'text/plain',
      sizeBytes: 1,
      sha256: sha('f'),
      redaction: { applied: true, rulesetVersion: 'redact-1', findingsCount: 0 },
      quarantined: false,
      provenance: { producer: 'flutter' },
      truncated: false,
    };
    expect(EvidenceArtifact.safeParse({ ...a, relativePath: 'attempts/1/stderr.log' }).success).toBe(true);
    expect(EvidenceArtifact.safeParse({ ...a, relativePath: '../../etc/passwd' }).success).toBe(false);
    expect(EvidenceArtifact.safeParse({ ...a, relativePath: '/etc/passwd' }).success).toBe(false);
  });
  it('failure subtype must belong to its class', () => {
    const f = {
      id: `fa_${ulid('1')}`,
      runId: `run_${ulid('A')}`,
      resultId: `res_${ulid('C')}`,
      strength: 'hypothesis',
      confidence: 0.5,
      observations: [],
      inference: 'x',
      alternatives: [],
      ruleIds: ['A9'],
      nextSteps: [],
    };
    expect(FailureAnalysis.safeParse({ ...f, class: 'product_defect', subtype: 'behavior' }).success).toBe(true);
    expect(FailureAnalysis.safeParse({ ...f, class: 'product_defect', subtype: 'flaky' }).success).toBe(false);
  });
  it('run events are a closed discriminated union', () => {
    expect(RunEvent.safeParse({ t: 'heartbeat', ts }).success).toBe(true);
    expect(RunEvent.safeParse({ t: 'shell', ts, command: 'x' }).success).toBe(false);
  });
});
