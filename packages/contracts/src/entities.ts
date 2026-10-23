/**
 * Persisted domain entities (CON-003 … CON-006). Field sets follow docs/data-model-and-artifacts.md §4.
 * Every persisted entity carries `schemaVersion` (ADR-0003 §4). Agent-written prose is confined to `display` / `narrative`
 * fields, which are untrusted and excluded from hashing and gate decisions (ADR-0004, ADR-0005).
 */
import { z } from 'zod';
import {
  AcId,
  AmbId,
  AnalysisId,
  ApprovalId,
  ApprovalRequestId,
  ArtifactId,
  AsmId,
  AuditEventId,
  AuthorizationId,
  ChangedFile,
  CoverageDecisionId,
  ExcId,
  InventoryId,
  Limitation,
  PlanHash,
  PlanId,
  PrContextId,
  ProjectProfileId,
  RefInfo,
  ReportId,
  RepositoryIdentity,
  ReqId,
  RequirementSetId,
  ResultId,
  RunId,
  Sha256,
  TcId,
  TestTargetId,
  Timestamp,
  UntrustedFields,
} from './common.ts';
import {
  AcFormat,
  AmbiguitySeverity,
  AmbiguityStatus,
  AmbiguityType,
  AnalysisStrength,
  ApprovalRequestStatus,
  ApprovalScopeKind,
  ApprovalSource,
  ApprovalState,
  ArtifactKind,
  AssuranceLevel,
  AuditActor,
  AuditEventKind,
  AuthorizationReason,
  AuthorizationResult,
  Automation,
  CancelReason,
  CoverageDecisionValue,
  DeviceNeed,
  EligibilityReason,
  ExceptionReason,
  FAILURE_SUBTYPES,
  FailureClass,
  FailureKind,
  FailureSubtype,
  FindingSeverity,
  HelperKind,
  HostRequirement,
  InfraReason,
  Platform,
  PlatformStatus,
  PrVerdict,
  Priority,
  Provenance,
  RequirementKind,
  RequirementVerificationStatus,
  RiskTier,
  RunState,
  SelectorKind,
  StatusCategory,
  Technique,
  TestLevel,
  TestLevelOrManual,
  TestOutcome,
} from './enums.ts';

const SchemaVersion = z.literal(1);
const Text = (max: number) => z.string().max(max);

// ---------------------------------------------------------------- CON-003: PR, project, inventory
export const PRContext = z.strictObject({
  id: PrContextId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  source: z.enum(['manual', 'github']),
  repository: RepositoryIdentity,
  number: z.number().int().positive().optional(),
  title: Text(1024).optional(),
  body: z.string().min(1).max(65536),
  labels: z.array(Text(100)).max(50).optional(),
  base: RefInfo.optional(),
  head: RefInfo.optional(),
  changedFiles: z.array(ChangedFile).max(3000).optional(),
  limitations: z.array(Limitation),
  untrustedFields: UntrustedFields,
});
export type PRContext = z.infer<typeof PRContext>;

export const ToolchainResolution = z.strictObject({
  tool: Text(64),
  versionsBySource: z.array(z.strictObject({ source: Text(256), value: Text(64) })).max(20),
  resolved: Text(64).nullable(),
  conflicts: z.array(Text(256)).max(20),
});
export type ToolchainResolution = z.infer<typeof ToolchainResolution>;

const EvidencePaths = (max: number) => z.array(Text(1024)).max(max);

export const ProjectProfile = z.strictObject({
  id: ProjectProfileId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  workspace: z.strictObject({ rootRealPath: Text(1024), allowlistEntryId: Text(128) }),
  frameworks: z.array(
    z.strictObject({ adapterId: Text(64), confidence: z.number().min(0).max(1), evidence: EvidencePaths(20) }),
  ),
  platforms: z
    .array(z.strictObject({ platform: Platform, status: PlatformStatus, evidence: EvidencePaths(10) }))
    // FR-006: `present` must carry evidence.
    .refine(
      (ps) => ps.every((p) => p.status !== 'present' || p.evidence.length > 0),
      'present platform requires evidence',
    ),
  languages: z.array(Text(64)),
  toolchains: z.array(ToolchainResolution),
  runners: z.array(
    z.strictObject({ adapterId: Text(64), kind: Text(64), configured: z.boolean(), evidence: EvidencePaths(10) }),
  ),
  limitations: z.array(Limitation),
});
export type ProjectProfile = z.infer<typeof ProjectProfile>;

export const TestTarget = z.strictObject({
  id: TestTargetId,
  adapterId: z.string().regex(/^[a-z0-9-]+$/),
  level: TestLevel,
  path: Text(1024),
  selector: z.strictObject({ kind: SelectorKind, value: Text(512) }).optional(),
  platforms: z.array(Platform).min(1),
  requires: z.strictObject({ host: HostRequirement, device: DeviceNeed }),
  tags: z.array(Text(64)).max(50),
});
export type TestTarget = z.infer<typeof TestTarget>;

export const TestInventory = z.strictObject({
  id: InventoryId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  profileId: ProjectProfileId,
  targets: z.array(TestTarget),
  helpers: z.array(z.strictObject({ path: Text(1024), kind: HelperKind })),
  automationConfigs: z.array(z.strictObject({ path: Text(1024), kind: Text(64) })),
  counts: z.strictObject({
    total: z.number().int().min(0),
    byLevel: z.record(z.string(), z.number().int()),
    byAdapter: z.record(z.string(), z.number().int()),
  }),
  completeness: z.strictObject({
    complete: z.boolean(),
    truncatedAt: z.number().int().nullable(),
    reasons: z.array(Text(500)),
  }),
  limits: z.strictObject({ maxFiles: z.number().int().positive(), maxBytes: z.number().int().positive() }),
});
export type TestInventory = z.infer<typeof TestInventory>;

// ---------------------------------------------------------------- CON-004: requirements and plans
/** Risk factors (test-planning §Risk model). `platformSpecificity` defaults to 1. */
export const RiskFactors = z.strictObject({
  functionalImpact: z.number().int().min(1).max(4),
  securityPrivacyImpact: z.number().int().min(1).max(4),
  dataIntegrityImpact: z.number().int().min(1).max(4),
  criticalJourney: z.boolean(),
  regressionLikelihood: z.number().int().min(1).max(4),
  changeSurface: z.number().int().min(1).max(3),
  uncertainty: z.number().int().min(1).max(3),
  platformSpecificity: z.number().int().min(1).max(2).optional(),
});
export type RiskFactors = z.infer<typeof RiskFactors>;

export const AcceptanceCriterion = z.strictObject({
  id: AcId,
  text: z.string().min(1).max(1000),
  format: AcFormat,
  observable: z.boolean(),
  provenance: Provenance,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const Requirement = z
  .strictObject({
    id: ReqId,
    title: z.string().min(1).max(200),
    statement: z.string().min(1).max(2000),
    kind: RequirementKind,
    testable: z.boolean(),
    nonTestableReason: Text(500).optional(),
    provenance: Provenance,
    sourceSpan: z.strictObject({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
    platforms: z.array(Platform),
    riskFactors: RiskFactors,
    riskTier: RiskTier,
    acceptanceCriteria: z.array(AcceptanceCriterion).max(30),
  })
  .refine(
    (r) => r.testable || (r.nonTestableReason?.length ?? 0) > 0,
    'non-testable requirement needs nonTestableReason',
  )
  .refine(
    (r) => r.acceptanceCriteria.every((ac) => ac.id.startsWith(`${r.id}.`)),
    'AC ids must be scoped to their requirement',
  );
export type Requirement = z.infer<typeof Requirement>;

export const Ambiguity = z.strictObject({
  id: AmbId,
  type: AmbiguityType.optional(),
  text: Text(1000),
  severity: AmbiguitySeverity,
  relatedRefs: z.array(z.union([ReqId, AcId])).max(50),
  status: AmbiguityStatus,
});
export type Ambiguity = z.infer<typeof Ambiguity>;

export const Assumption = z.strictObject({
  id: AsmId,
  text: Text(1000),
  relatedRefs: z.array(z.union([ReqId, AcId])).max(50),
});
export type Assumption = z.infer<typeof Assumption>;

export const RequirementSet = z.strictObject({
  id: RequirementSetId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  prContextId: PrContextId,
  requirements: z.array(Requirement).max(200),
  ambiguities: z.array(Ambiguity).max(100),
  assumptions: z.array(Assumption).max(100),
  requirementSetHash: Sha256,
});
export type RequirementSet = z.infer<typeof RequirementSet>;

/** `eligible` or `ineligible:<reason>` (FR-014). */
export const Eligibility = z.union([z.literal('eligible'), z.templateLiteral(['ineligible:', EligibilityReason])]);
export type Eligibility = z.infer<typeof Eligibility>;

export const TestCase = z.strictObject({
  id: TcId,
  clientKey: Text(64).optional(),
  title: z.string().min(3).max(200),
  requirementRefs: z.array(ReqId).min(1),
  acRefs: z.array(AcId),
  level: TestLevelOrManual,
  technique: Technique,
  priority: Priority,
  platforms: z.array(Platform).min(1),
  preconditions: z.array(Text(500)).max(20),
  steps: z.array(Text(500)).min(1).max(50),
  expectedResults: z.array(Text(500)).min(1).max(20),
  targetRef: TestTargetId.nullable(),
  automation: Automation,
  eligibility: Eligibility,
  riskTier: RiskTier,
  dependsOn: z.array(TcId).optional(),
});
export type TestCase = z.infer<typeof TestCase>;

export const CoverageException = z.strictObject({
  id: ExcId,
  requirementRefs: z.array(ReqId).min(1),
  reason: ExceptionReason,
  rationale: z.string().min(20).max(2000),
  evidenceLink: Text(1024).optional(),
  approvalId: ApprovalId.optional(),
  expiresAt: Timestamp,
});
export type CoverageException = z.infer<typeof CoverageException>;

export const TestPlan = z.strictObject({
  id: PlanId,
  version: z.number().int().min(1),
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  planHash: PlanHash,
  hashVersion: z.literal(1),
  requirementSetId: RequirementSetId,
  requirementSetHash: Sha256,
  inventoryId: InventoryId,
  /** Hash-covered repository identity and head commit (data model §Plan hash). */
  repository: RepositoryIdentity,
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  riskPolicyVersion: Sha256,
  platformsInScope: z.array(Platform).min(1),
  testCases: z.array(TestCase).min(1).max(500),
  exceptions: z.array(CoverageException).max(100),
  ambiguities: z.array(Ambiguity),
  assumptions: z.array(Assumption),
  /** Untrusted, display-only; excluded from the hash and from gate rules. */
  display: z.strictObject({ summary: Text(4000).optional(), narrative: Text(8000).optional() }).optional(),
  supersedes: z.strictObject({ planId: PlanId, version: z.number().int().min(1), planHash: PlanHash }).optional(),
});
export type TestPlan = z.infer<typeof TestPlan>;

// ---------------------------------------------------------------- CON-005: decisions, approvals, authorization
export const CoverageMetric = z.strictObject({
  numerator: z.number().int().min(0),
  denominator: z.number().int().min(0),
  /** `null` when the denominator is 0 (never shown as 100%). */
  value: z.number().min(0).max(1).nullable(),
});
export type CoverageMetric = z.infer<typeof CoverageMetric>;

/** The six distinct coverage metrics (test-planning §Coverage metrics). `null` = not available. */
export const CoverageMetrics = z.strictObject({
  requirementCoverage: CoverageMetric.nullable(),
  testCaseCoverage: CoverageMetric.nullable(),
  sourceCodeCoverage: CoverageMetric.nullable(),
  platformCoverage: CoverageMetric.nullable(),
  regressionCoverage: CoverageMetric.nullable(),
  executionCoverage: CoverageMetric.nullable(),
});
export type CoverageMetrics = z.infer<typeof CoverageMetrics>;

export const GateFinding = z.strictObject({
  ruleId: z.string().regex(/^(G[BR]-\d{2}|INF-\d{2})$/),
  severity: FindingSeverity,
  message: Text(500),
  refs: z.array(z.string().max(64)).max(20),
});
export type GateFinding = z.infer<typeof GateFinding>;

export const CoverageDecision = z.strictObject({
  id: CoverageDecisionId,
  schemaVersion: SchemaVersion,
  planId: PlanId,
  planHash: PlanHash,
  requirementSetHash: Sha256,
  gatePolicyVersion: Sha256,
  decision: CoverageDecisionValue,
  findings: z.array(GateFinding),
  metrics: CoverageMetrics,
  requirementStatus: z.array(z.strictObject({ requirementId: ReqId, status: RequirementVerificationStatus })),
  evaluatedAt: Timestamp,
});
export type CoverageDecision = z.infer<typeof CoverageDecision>;

export const ApprovalScope = z.strictObject({
  kind: ApprovalScopeKind,
  digest: Sha256,
  params: z.record(z.string(), z.unknown()),
});
export type ApprovalScope = z.infer<typeof ApprovalScope>;

export const ApprovalRequest = z.strictObject({
  id: ApprovalRequestId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  scope: ApprovalScope,
  requiredAssurance: AssuranceLevel,
  status: ApprovalRequestStatus,
  instructions: z.strictObject({ cliCommand: Text(300), expiresAt: Timestamp }),
  createdBy: z.literal('agent'),
  /** Shown to the approving human; never part of the scope digest. `justification` is agent text (untrusted). */
  display: z.strictObject({ summary: Text(300), justification: Text(2000) }).optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const Approval = z
  .strictObject({
    id: ApprovalId,
    schemaVersion: SchemaVersion,
    requestId: ApprovalRequestId.optional(),
    scope: ApprovalScope,
    planHash: PlanHash.optional(),
    environment: z.string().regex(/^(local:[A-Za-z0-9._-]+|ci:[a-z0-9-]+:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/),
    policyVersion: Sha256,
    source: ApprovalSource,
    assuranceLevel: AssuranceLevel,
    approver: z.strictObject({ osUser: Text(128), githubLogin: Text(64).optional() }),
    createdAt: Timestamp,
    expiresAt: Timestamp,
    maxUses: z.number().int().min(1),
    uses: z.number().int().min(0),
    state: ApprovalState,
    signature: z.string().max(4096).optional(),
    revokedAt: Timestamp.optional(),
    revokedBy: Text(128).optional(),
  })
  .refine((a) => a.uses <= a.maxUses, 'uses cannot exceed maxUses')
  .refine(
    (a) => a.assuranceLevel !== 'AL3' || (a.signature?.length ?? 0) > 0 || a.approver.githubLogin !== undefined,
    'AL3 requires a signature or a verified GitHub reviewer',
  )
  .refine(
    (a) => a.source !== 'elicitation' || a.assuranceLevel === 'AL1',
    'elicitation approvals are AL1 only (RL-031)',
  );
export type Approval = z.infer<typeof Approval>;

export const ExecutionAuthorizationDecision = z
  .strictObject({
    id: AuthorizationId,
    schemaVersion: SchemaVersion,
    runId: RunId.optional(),
    phase: z.enum(['create', 'dispatch']),
    result: AuthorizationResult,
    reasons: z.array(AuthorizationReason),
    inputsDigest: Sha256,
    evaluatedAt: Timestamp,
  })
  // Any reason means denied; authorized means no reasons (ADR-0006 §4).
  .refine((d) => (d.result === 'authorized') === (d.reasons.length === 0), 'authorized iff no denial reasons');
export type ExecutionAuthorizationDecision = z.infer<typeof ExecutionAuthorizationDecision>;

// ---------------------------------------------------------------- CON-006: runs, results, evidence, analysis, reports, audit
export const ProcessIdentity = z.strictObject({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  startTime: Text(64),
  executable: Text(1024).optional(),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;

export const Run = z.strictObject({
  id: RunId,
  schemaVersion: SchemaVersion,
  planId: PlanId,
  planHash: PlanHash,
  targets: z.array(z.union([TcId, TestTargetId])).max(2000),
  environment: Text(200),
  devices: z.array(Text(128)).max(10),
  state: RunState,
  statusCategory: StatusCategory,
  cancelReason: CancelReason.optional(),
  infraReason: InfraReason.optional(),
  idempotencyKey: z.string().max(128).optional(),
  requestDigest: Sha256,
  authorizationIds: z.array(AuthorizationId).min(1),
  timeouts: z.strictObject({
    runMs: z.number().int().positive(),
    attemptMs: z.number().int().positive(),
    targetMs: z.number().int().positive(),
  }),
  retryPolicy: z.strictObject({ maxAttempts: z.number().int().min(1).max(3), retryOn: z.array(FailureSubtype) }),
  supervisor: ProcessIdentity.optional(),
  counts: z.partialRecord(TestOutcome, z.number().int().min(0)),
  partial: z.boolean(),
  limitations: z.array(Limitation),
  createdAt: Timestamp,
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
});
export type Run = z.infer<typeof Run>;

export const RunAttempt = z.strictObject({
  runId: RunId,
  attemptNo: z.number().int().min(1),
  specs: z.array(
    z.strictObject({ specDigest: Sha256, executable: Text(64), argv: z.array(Text(2048)), cwd: Text(1024) }),
  ),
  processes: z.array(ProcessIdentity.extend({ exitCode: z.number().int().optional(), signal: Text(16).optional() })),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcomeSummary: z.partialRecord(TestOutcome, z.number().int().min(0)),
});
export type RunAttempt = z.infer<typeof RunAttempt>;

export const TestResult = z.strictObject({
  id: ResultId,
  runId: RunId,
  attemptNo: z.number().int().min(1),
  testCaseIds: z.array(TcId),
  targetId: TestTargetId,
  name: Text(500),
  suitePath: Text(1024).optional(),
  outcome: TestOutcome,
  failureKind: FailureKind.optional(),
  blockedReason: Text(200).optional(),
  durationMs: z.number().int().min(0).optional(),
  flaky: z.boolean(),
  messageExcerpt: Text(2048).optional(),
  artifactRefs: z.array(ArtifactId).max(10),
  rawStatus: Text(64),
});
export type TestResult = z.infer<typeof TestResult>;

export const EvidenceArtifact = z.strictObject({
  id: ArtifactId,
  runId: RunId,
  attemptNo: z.number().int().min(1).optional(),
  kind: ArtifactKind,
  relativePath: z
    .string()
    .max(1024)
    .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'path must stay under the run dir'),
  mimeType: Text(100),
  sizeBytes: z.number().int().min(0),
  sha256: Sha256,
  redaction: z.strictObject({ applied: z.boolean(), rulesetVersion: Text(64), findingsCount: z.number().int().min(0) }),
  quarantined: z.boolean(),
  quarantineReason: Text(200).optional(),
  provenance: z.strictObject({ producer: Text(64), specDigest: Sha256.optional(), toolVersion: Text(64).optional() }),
  truncated: z.boolean(),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifact>;

export const FailureAnalysis = z
  .strictObject({
    id: AnalysisId,
    runId: RunId,
    resultId: ResultId,
    class: FailureClass,
    subtype: FailureSubtype,
    strength: AnalysisStrength,
    confidence: z.number().min(0).max(1),
    observations: z
      .array(z.strictObject({ text: Text(500), artifactRef: ArtifactId.optional(), location: Text(256).optional() }))
      .max(10),
    inference: Text(1000),
    alternatives: z
      .array(z.strictObject({ class: FailureClass, subtype: FailureSubtype, confidence: z.number().min(0).max(1) }))
      .max(4),
    ruleIds: z.array(Text(16)).min(1),
    nextSteps: z.array(Text(300)).max(5),
  })
  .refine((a) => (FAILURE_SUBTYPES[a.class] as readonly string[]).includes(a.subtype), 'subtype must belong to class');
export type FailureAnalysis = z.infer<typeof FailureAnalysis>;

export const KnownFailure = z.strictObject({
  id: z.string().regex(/^KF-\d{3}$/),
  targetId: TestTargetId,
  namePattern: Text(500),
  reason: Text(500),
  addedBy: Text(128),
  expiresAt: Timestamp,
  evidenceLink: Text(1024),
});
export type KnownFailure = z.infer<typeof KnownFailure>;

export const PRReport = z.strictObject({
  id: ReportId,
  schemaVersion: SchemaVersion,
  createdAt: Timestamp,
  prContextId: PrContextId,
  planId: PlanId,
  planHash: PlanHash,
  coverageDecisionId: CoverageDecisionId,
  runIds: z.array(RunId).max(10),
  verdict: PrVerdict,
  verdictRule: z.number().int().min(1).max(5),
  metrics: CoverageMetrics,
  sections: z.record(z.string(), z.unknown()),
  limitations: z.array(Limitation),
  artifacts: z.strictObject({
    markdown: ArtifactId.optional(),
    json: ArtifactId.optional(),
    junit: ArtifactId.optional(),
  }),
  reportHash: Sha256,
  /** Agent-written, untrusted, rendered with a label. */
  narrative: Text(8000).optional(),
});
export type PRReport = z.infer<typeof PRReport>;

export const AuditEvent = z.strictObject({
  id: AuditEventId,
  seq: z.number().int().min(0),
  ts: Timestamp,
  actor: AuditActor,
  kind: AuditEventKind,
  subjectRefs: z.array(z.string().max(64)).max(20),
  data: z.record(z.string(), z.unknown()),
  prevHash: Sha256.nullable(),
  hash: Sha256,
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** Supervisor event-log records (observability §2). */
export const RunEvent = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('state'), ts: Timestamp, from: RunState, to: RunState, reason: Text(64).optional() }),
  z.strictObject({
    t: z.literal('authorization'),
    ts: Timestamp,
    phase: z.literal('dispatch'),
    result: AuthorizationResult,
    reasons: z.array(AuthorizationReason),
    inputsDigest: Sha256,
  }),
  z.strictObject({
    t: z.literal('attempt.start'),
    ts: Timestamp,
    attemptNo: z.number().int().min(1),
    specDigests: z.array(Sha256),
  }),
  z.strictObject({
    t: z.literal('process.start'),
    ts: Timestamp,
    pid: z.number().int().positive(),
    pgid: z.number().int().positive(),
    startTime: Text(64),
    executable: Text(1024),
    role: z.enum(['runner', 'helper', 'appium', 'device']),
  }),
  z.strictObject({
    t: z.literal('process.exit'),
    ts: Timestamp,
    pid: z.number().int().positive(),
    exitCode: z.number().int().optional(),
    signal: Text(16).optional(),
  }),
  z.strictObject({
    t: z.literal('attempt.end'),
    ts: Timestamp,
    attemptNo: z.number().int().min(1),
    summary: z.partialRecord(TestOutcome, z.number().int().min(0)),
  }),
  z.strictObject({
    t: z.literal('cancel'),
    ts: Timestamp,
    stage: z.enum(['term_sent', 'kill_sent', 'confirmed', 'survivors']),
    survivors: z.array(z.number().int()).optional(),
  }),
  z.strictObject({ t: z.literal('timeout'), ts: Timestamp, scope: z.enum(['target', 'attempt', 'run']) }),
  z.strictObject({
    t: z.literal('evidence'),
    ts: Timestamp,
    artifactId: ArtifactId,
    kind: ArtifactKind,
    quarantined: z.boolean(),
  }),
  z.strictObject({ t: z.literal('heartbeat'), ts: Timestamp }),
  z.strictObject({ t: z.literal('terminal'), ts: Timestamp, state: RunState, infraReason: InfraReason.optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
