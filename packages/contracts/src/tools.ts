/**
 * Input/output schemas for the 18 MCP tools (CON-007). Canonical contract text: docs/mcp-tool-contracts.md §4.
 *
 * Rules enforced by tests:
 * - exactly 18 tools, IDs TL-01..TL-18, names/tiers match the catalog;
 * - every input schema is a strict object at the root (no root combinators, ADR-0003);
 * - no input field anywhere is named command/argv/shell/script/cmd/exec (SR-001);
 * - every documented example validates against these schemas.
 */
import { z } from 'zod';
import {
  ApprovalId,
  ApprovalRequestId,
  ArtifactId,
  ArtifactRef,
  AuthorizationId,
  ChangedFile,
  CoverageDecisionId,
  Cursor,
  IdempotencyKey,
  InventoryId,
  LeaseId,
  Limit,
  Limitation,
  PlanHash,
  PlanId,
  PrContextId,
  ProjectProfileId,
  RefInfo,
  ReportId,
  RepositoryIdentity,
  ReqId,
  AcId,
  RequirementSetId,
  ResultId,
  RunId,
  Sha256,
  TcId,
  TestTargetId,
  Timestamp,
  UntrustedFields,
  AnalysisId,
} from './common.ts';
import {
  Ambiguity,
  Assumption,
  CoverageMetrics,
  GateFinding,
  RiskFactors,
  TestTarget,
  ToolchainResolution,
} from './entities.ts';
import type { PermissionTier } from './enums.ts';
import {
  AcFormat,
  AmbiguitySeverity,
  ApprovalScopeKind,
  ApprovalState,
  ArtifactKind,
  AssuranceLevel,
  Automation,
  CoverageDecisionValue,
  DeviceApprovalAction,
  DeviceAvailability,
  DeviceKind,
  ElicitationOutcome,
  ExceptionReason,
  FailureClass,
  FailureSubtype,
  HelperKind,
  Platform,
  PlatformStatus,
  PrVerdict,
  Priority,
  Provenance,
  PublishMechanism,
  PublishStatus,
  RequirementKind,
  RequirementVerificationStatus,
  RiskTier,
  RunState,
  SimulatorAction,
  StatusCategory,
  Technique,
  TestLevel,
  TestLevelOrManual,
  TestOutcome,
  ApprovalRequestStatus,
} from './enums.ts';

const S = (max: number) => z.string().max(max);
const WorkspaceRef = z.string().min(1).max(1024);
const RunSurvivor = z.strictObject({ pid: z.number().int().positive(), executable: S(1024) });

// ------------------------------------------------------------------ TL-01 get_pr_context
export const GetPrContextInput = z.strictObject({
  workspace: WorkspaceRef,
  source: z.enum(['manual', 'github']),
  manual: z
    .strictObject({
      title: S(1024).optional(),
      body: z.string().min(1).max(65536),
      labels: z.array(S(100)).max(50).optional(),
      changedFiles: z.array(S(1024)).max(3000).optional(),
    })
    .optional(),
  github: z
    .strictObject({
      host: S(255).optional(),
      owner: z.string().min(1).max(100),
      name: z.string().min(1).max(100),
      number: z.number().int().positive(),
    })
    .optional(),
  bodyOffset: z.number().int().min(0).default(0),
});
export const GetPrContextOutput = z.strictObject({
  prContextId: PrContextId,
  source: z.enum(['manual', 'github']),
  repository: RepositoryIdentity,
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  body: S(16000),
  bodyNextOffset: z.number().int().nullable(),
  labels: z.array(z.string()),
  base: RefInfo.nullable(),
  head: RefInfo.nullable(),
  changedFilesCount: z.number().int().min(0),
  changedFilesSample: z.array(ChangedFile).max(100),
  limitations: z.array(Limitation),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-02 inspect_project
export const InspectProjectInput = z.strictObject({
  workspace: WorkspaceRef,
  adapters: z.array(S(64)).max(10).optional(),
  maxFiles: z.number().int().min(100).max(200000).default(50000),
  probeToolchains: z.boolean().default(true),
});
export const InspectProjectOutput = z.strictObject({
  projectProfileId: ProjectProfileId,
  frameworks: z.array(
    z.strictObject({ adapterId: S(64), confidence: z.number().min(0).max(1), evidence: z.array(S(1024)).max(20) }),
  ),
  platforms: z.array(
    z.strictObject({ platform: Platform, status: PlatformStatus, evidence: z.array(S(1024)).max(10) }),
  ),
  languages: z.array(S(64)),
  toolchains: z.array(ToolchainResolution),
  runners: z.array(
    z.strictObject({ adapterId: S(64), kind: S(64), configured: z.boolean(), evidence: z.array(S(1024)).max(10) }),
  ),
  limitations: z.array(Limitation),
});

// ------------------------------------------------------------------ TL-03 inspect_test_inventory
export const InspectTestInventoryInput = z.strictObject({
  projectProfileId: ProjectProfileId,
  inventoryId: InventoryId.optional(),
  filter: z
    .strictObject({ adapterId: S(64).optional(), level: TestLevel.optional(), pathPrefix: S(512).optional() })
    .optional(),
  cursor: Cursor.optional(),
  limit: Limit(200, 50),
});
export const InspectTestInventoryOutput = z.strictObject({
  inventoryId: InventoryId,
  counts: z.strictObject({
    total: z.number().int(),
    byLevel: z.record(z.string(), z.number().int()),
    byAdapter: z.record(z.string(), z.number().int()),
  }),
  completeness: z.strictObject({
    complete: z.boolean(),
    truncatedAt: z.number().int().nullable(),
    reasons: z.array(z.string()),
  }),
  helpers: z.array(z.strictObject({ path: S(1024), kind: HelperKind })).max(50),
  targets: z.array(TestTarget),
  nextCursor: Cursor.nullable(),
  truncated: z.boolean(),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-04 extract_requirements
export const ExtractRequirementsInput = z.strictObject({
  prContextId: PrContextId,
  agentRequirements: z
    .array(
      z.strictObject({
        title: z.string().min(3).max(200),
        statement: z.string().min(10).max(2000),
        kind: RequirementKind,
        testable: z.boolean().default(true),
        nonTestableReason: S(500).optional(),
        platforms: z.array(Platform).default([]),
        riskFactors: RiskFactors.optional(),
        sourceQuote: S(500).optional(),
        acceptanceCriteria: z.array(z.strictObject({ text: z.string().min(5).max(1000), format: AcFormat })).max(30),
      }),
    )
    .max(200)
    .default([]),
  agentAmbiguities: z
    .array(z.strictObject({ text: S(1000), severity: AmbiguitySeverity, relatedKeys: z.array(S(64)).default([]) }))
    .max(100)
    .default([]),
  agentAssumptions: z
    .array(z.strictObject({ text: S(1000) }))
    .max(100)
    .default([]),
  mode: z.enum(['parsed_only', 'parsed_and_agent']).default('parsed_and_agent'),
});
export const RequirementSummary = z.strictObject({
  id: ReqId,
  title: z.string(),
  kind: RequirementKind,
  provenance: Provenance,
  riskTier: RiskTier,
  testable: z.boolean(),
  acIds: z.array(AcId),
});
export const ExtractRequirementsOutput = z.strictObject({
  requirementSetId: RequirementSetId,
  requirementSetHash: Sha256,
  requirements: z.array(RequirementSummary).max(200),
  ambiguities: z.array(Ambiguity),
  assumptions: z.array(Assumption),
  parseReport: z.strictObject({
    parsedCount: z.number().int(),
    agentCount: z.number().int(),
    mergedDuplicates: z.number().int(),
    discarded: z.array(z.strictObject({ reason: z.string(), excerpt: S(200) })),
  }),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-05 generate_test_plan
export const DraftTestCase = z.strictObject({
  clientKey: z.string().min(1).max(64),
  title: z.string().min(3).max(200),
  requirementRefs: z.array(ReqId).min(1),
  acRefs: z.array(AcId).default([]),
  level: TestLevelOrManual,
  technique: Technique,
  priority: Priority,
  platforms: z.array(Platform).min(1),
  preconditions: z.array(S(500)).max(20).default([]),
  steps: z.array(S(500)).min(1).max(50),
  expectedResults: z.array(S(500)).min(1).max(20),
  targetPath: S(1024).optional(),
  targetSelector: S(512).optional(),
  automation: Automation,
  dependsOnKeys: z.array(S(64)).default([]),
});
export const GenerateTestPlanInput = z.strictObject({
  requirementSetId: RequirementSetId,
  inventoryId: InventoryId,
  basePlanId: PlanId.optional(),
  platformsInScope: z.array(Platform).min(1),
  draft: z.strictObject({
    testCases: z.array(DraftTestCase).min(1).max(500),
    exceptions: z
      .array(
        z.strictObject({
          requirementRefs: z.array(ReqId).min(1),
          reason: ExceptionReason,
          rationale: z.string().min(20).max(2000),
          evidenceLink: S(1024).optional(),
          expiresAt: Timestamp,
        }),
      )
      .max(100)
      .default([]),
    display: z.strictObject({ summary: S(4000).optional(), narrative: S(8000).optional() }).optional(),
  }),
});
export const GenerateTestPlanOutput = z.strictObject({
  planId: PlanId,
  version: z.number().int().min(1),
  planHash: PlanHash,
  hashVersion: z.literal(1),
  testCaseCount: z.number().int(),
  testCases: z
    .array(
      z.strictObject({
        id: TcId,
        clientKey: z.string(),
        title: z.string(),
        riskTier: RiskTier,
        eligibility: z.string(),
        targetRef: TestTargetId.nullable(),
        priority: Priority,
      }),
    )
    .max(200),
  riskSummary: z.record(RiskTier, z.number().int()),
  eligibilitySummary: z.strictObject({
    eligible: z.number().int(),
    ineligible: z.record(z.string(), z.number().int()),
  }),
  unresolvedTargets: z
    .array(z.strictObject({ clientKey: z.string(), targetPath: z.string(), reason: z.string() }))
    .max(100),
  warnings: z.array(S(500)).max(50),
  supersedes: z.strictObject({ planId: PlanId, version: z.number().int(), planHash: PlanHash }).nullable(),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-06 validate_test_coverage
export const ValidateTestCoverageInput = z.strictObject({
  planId: PlanId,
  planHash: PlanHash,
  findingsCursor: Cursor.optional(),
});
export const ValidateTestCoverageOutput = z.strictObject({
  coverageDecisionId: CoverageDecisionId,
  decision: CoverageDecisionValue,
  planHash: PlanHash,
  requirementSetHash: Sha256,
  gatePolicyVersion: Sha256,
  current: z.boolean(),
  findings: z.array(GateFinding).max(100),
  findingsNextCursor: Cursor.nullable(),
  metrics: CoverageMetrics,
  requirementStatus: z.array(z.strictObject({ requirementId: ReqId, status: RequirementVerificationStatus })).max(200),
  nextSteps: z.array(S(300)).max(5),
});

// ------------------------------------------------------------------ TL-07 request_approval
export const RequestApprovalInput = z.strictObject({
  scope: z.strictObject({
    kind: ApprovalScopeKind,
    planId: PlanId.optional(),
    planHash: PlanHash.optional(),
    targets: z
      .array(z.union([TcId, TestTargetId]))
      .max(500)
      .optional(),
    environment: S(200).optional(),
    exceptionIds: z
      .array(z.string().regex(/^EXC-\d{3}$/))
      .max(50)
      .optional(),
    deviceAction: z.strictObject({ action: DeviceApprovalAction, deviceId: S(128) }).optional(),
    publish: z.strictObject({ reportId: ReportId, mechanisms: z.array(PublishMechanism).min(1) }).optional(),
  }),
  justification: S(2000),
  offerElicitation: z.boolean().default(true),
  idempotencyKey: IdempotencyKey.optional(),
});
export const RequestApprovalOutput = z.strictObject({
  approvalRequestId: ApprovalRequestId,
  scopeDigest: Sha256,
  requiredAssurance: AssuranceLevel,
  status: ApprovalRequestStatus,
  approvalId: ApprovalId.nullable(),
  instructions: z.strictObject({ cliCommand: S(300), expiresAt: Timestamp }),
  elicitationOutcome: ElicitationOutcome,
});

// ------------------------------------------------------------------ TL-08 get_approval_status
export const GetApprovalStatusInput = z
  .strictObject({ approvalRequestId: ApprovalRequestId.optional(), approvalId: ApprovalId.optional() })
  .refine(
    (v) => (v.approvalRequestId === undefined) !== (v.approvalId === undefined),
    'exactly one of approvalRequestId/approvalId',
  );
export const GetApprovalStatusOutput = z.strictObject({
  request: z
    .strictObject({
      id: ApprovalRequestId,
      status: ApprovalRequestStatus,
      scopeDigest: Sha256,
      requiredAssurance: AssuranceLevel,
      expiresAt: Timestamp,
    })
    .nullable(),
  approvals: z
    .array(
      z.strictObject({
        approvalId: ApprovalId,
        state: ApprovalState,
        assuranceLevel: AssuranceLevel,
        source: z.string(),
        usable: z.boolean(),
        unusableReasons: z.array(z.string()),
        expiresAt: Timestamp,
        uses: z.number().int(),
        maxUses: z.number().int(),
      }),
    )
    .max(20),
});

/** A branch, tag or hex commit id; no option-like or revision-range syntax (git's `rev-parse` sees exactly this). */
export const BaselineRef = z
  .string()
  .max(200)
  .regex(/^(?!.*\.\.)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]*$/);

// ------------------------------------------------------------------ TL-09 run_tests
export const RunTestsInput = z.strictObject({
  planId: PlanId,
  planHash: PlanHash,
  targets: z
    .array(z.union([TcId, TestTargetId]))
    .max(2000)
    .optional(),
  environment: S(200).default('local'),
  devices: z.array(S(128)).max(10).default([]),
  timeouts: z
    .strictObject({
      runMs: z.number().int().min(60000).max(14400000).optional(),
      attemptMs: z.number().int().positive().optional(),
      targetMs: z.number().int().positive().optional(),
    })
    .optional(),
  retry: z.strictObject({ maxAttempts: z.number().int().min(1).max(3).optional() }).optional(),
  evidence: z.strictObject({ coverage: z.boolean().default(false), screenshots: z.boolean().default(true) }).optional(),
  /**
   * ANL-002: run the targets at the base commit instead (a baseline run, checked out in a worktree inside the run
   * directory). `ref` defaults to the PR's base commit (GitHub PR contexts); manual contexts must name it.
   */
  baseline: z.strictObject({ ref: BaselineRef.optional() }).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export const RunTestsOutput = z.strictObject({
  runId: RunId,
  state: z.literal('queued'),
  authorizationId: AuthorizationId,
  targetsCount: z.number().int(),
  queuePosition: z.number().int().min(0),
  pollAfterMs: z.number().int().positive(),
  limitations: z.array(Limitation),
});

// ------------------------------------------------------------------ TL-10 get_run_status
export const GetRunStatusInput = z.strictObject({ runId: RunId });
export const GetRunStatusOutput = z.strictObject({
  runId: RunId,
  state: RunState,
  statusCategory: StatusCategory,
  cancelReason: z.string().nullable(),
  infraReason: z.string().nullable(),
  progress: z.strictObject({
    attemptsStarted: z.number().int(),
    attemptsFinished: z.number().int(),
    testsByOutcome: z.partialRecord(TestOutcome, z.number().int()),
  }),
  survivors: z.array(RunSurvivor).max(20),
  partial: z.boolean(),
  limitations: z.array(Limitation),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  pollAfterMs: z.number().int().nullable(),
});

// ------------------------------------------------------------------ TL-11 get_run_results
export const GetRunResultsInput = z.strictObject({
  runId: RunId,
  filter: z
    .strictObject({
      outcomes: z.array(TestOutcome).optional(),
      targetId: TestTargetId.optional(),
      flakyOnly: z.boolean().optional(),
    })
    .optional(),
  cursor: Cursor.optional(),
  limit: Limit(200, 50),
});
export const GetRunResultsOutput = z.strictObject({
  runId: RunId,
  runState: RunState,
  snapshotFinal: z.boolean(),
  totals: z.partialRecord(TestOutcome, z.number().int()),
  results: z.array(
    z.strictObject({
      resultId: ResultId,
      targetId: TestTargetId,
      testCaseIds: z.array(TcId),
      name: S(500),
      outcome: TestOutcome,
      failureKind: z.string().nullable(),
      blockedReason: z.string().nullable(),
      flaky: z.boolean(),
      attemptNo: z.number().int().min(1),
      durationMs: z.number().int().nullable(),
      messageExcerpt: S(2048).nullable(),
      artifactIds: z.array(ArtifactId).max(10),
    }),
  ),
  nextCursor: Cursor.nullable(),
  truncated: z.boolean(),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-12 cancel_test_run
export const CancelTestRunInput = z.strictObject({ runId: RunId, reason: S(500).optional() });
export const CancelTestRunOutput = z.strictObject({
  runId: RunId,
  state: RunState,
  alreadyTerminal: z.boolean(),
  survivors: z.array(RunSurvivor).max(20),
  pollAfterMs: z.number().int().nullable(),
});

// ------------------------------------------------------------------ TL-13 list_devices
export const ListDevicesInput = z.strictObject({
  platform: z.enum(['ios', 'android', 'all']).default('all'),
  includeUnavailable: z.boolean().default(false),
});
export const ListDevicesOutput = z.strictObject({
  host: z.strictObject({ os: z.string(), simctl: z.boolean(), adb: z.boolean(), emulator: z.boolean() }),
  devices: z
    .array(
      z.strictObject({
        deviceId: S(128),
        platform: z.enum(['ios', 'android']),
        kind: DeviceKind,
        name: S(200),
        osVersion: S(64).nullable(),
        state: S(64),
        availability: DeviceAvailability,
        owned: z.boolean(),
        leaseId: LeaseId.nullable(),
      }),
    )
    .max(100),
  unsupported: z.array(z.strictObject({ platform: z.string(), reason: S(300) })),
});

// ------------------------------------------------------------------ TL-14 manage_simulator
export const ManageSimulatorInput = z
  .strictObject({
    action: SimulatorAction,
    deviceId: S(128).optional(),
    create: z.strictObject({ platform: z.enum(['ios', 'android']), deviceType: S(100), runtime: S(100) }).optional(),
    runId: RunId.optional(),
    approvalId: ApprovalId.optional(),
  })
  .refine(
    (v) => (v.action === 'create' ? v.create !== undefined : v.deviceId !== undefined),
    'create needs `create`; other actions need `deviceId`',
  );
export const ManageSimulatorOutput = z.strictObject({
  action: SimulatorAction,
  deviceId: S(128),
  owned: z.boolean(),
  tierApplied: z.enum(['P1', 'P2']),
  result: z.enum(['done', 'already_in_state']),
  leaseId: LeaseId.nullable(),
  state: S(64),
});

// ------------------------------------------------------------------ TL-15 collect_test_evidence
export const CollectTestEvidenceInput = z.strictObject({
  runId: RunId,
  kinds: z.array(ArtifactKind).optional(),
  include: z.enum(['metadata', 'excerpt']).default('metadata'),
  excerptBytes: z.number().int().min(256).max(8192).default(2048),
  artifactIds: z.array(ArtifactId).max(20).optional(),
  cursor: Cursor.optional(),
  limit: Limit(100, 50),
});
export const CollectTestEvidenceOutput = z.strictObject({
  runId: RunId,
  partial: z.boolean(),
  artifacts: z.array(
    ArtifactRef.extend({
      redactionApplied: z.boolean(),
      truncated: z.boolean(),
      provenance: z.strictObject({ producer: S(64), toolVersion: S(64).nullable() }),
      excerpt: S(8192).nullable(),
    }),
  ),
  quarantinedCount: z.number().int().min(0),
  nextCursor: Cursor.nullable(),
  untrustedFields: UntrustedFields,
});

// ------------------------------------------------------------------ TL-16 analyze_test_failures
export const AnalyzeTestFailuresInput = z.strictObject({
  runId: RunId,
  resultIds: z.array(ResultId).max(200).optional(),
  cursor: Cursor.optional(),
  limit: Limit(100, 25),
});
export const AnalyzeTestFailuresOutput = z.strictObject({
  runId: RunId,
  rulesetVersion: S(32),
  summary: z.partialRecord(FailureClass, z.number().int()),
  analyses: z.array(
    z.strictObject({
      analysisId: AnalysisId,
      resultId: ResultId,
      class: FailureClass,
      subtype: FailureSubtype,
      strength: z.enum(['hypothesis', 'supported']),
      confidence: z.number().min(0).max(1),
      observations: z.array(z.strictObject({ text: S(500), artifactId: ArtifactId.nullable() })).max(10),
      inference: S(1000),
      alternatives: z
        .array(z.strictObject({ class: FailureClass, subtype: FailureSubtype, confidence: z.number().min(0).max(1) }))
        .max(4),
      nextSteps: z.array(S(300)).max(5),
    }),
  ),
  nextCursor: Cursor.nullable(),
});

// ------------------------------------------------------------------ TL-17 generate_pr_test_report
export const GeneratePrTestReportInput = z.strictObject({
  planId: PlanId,
  planHash: PlanHash,
  runIds: z.array(RunId).max(10).default([]),
  narrative: S(8000).optional(),
  formats: z.array(z.enum(['markdown', 'json', 'junit'])).default(['markdown', 'json', 'junit']),
});
export const GeneratePrTestReportOutput = z.strictObject({
  reportId: ReportId,
  verdict: PrVerdict,
  verdictRule: z.number().int().min(1).max(5),
  reportHash: Sha256,
  artifacts: z.array(ArtifactRef).max(3),
  markdownPreview: S(12000),
  plannedVsExecuted: z.strictObject({
    planned: z.number().int(),
    executed: z.number().int(),
    notRun: z.number().int(),
    blocked: z.number().int(),
  }),
  limitations: z.array(Limitation),
});

// ------------------------------------------------------------------ TL-18 publish_github_report
export const PublishGithubReportInput = z.strictObject({
  reportId: ReportId,
  mechanisms: z.array(PublishMechanism).min(1),
  approvalId: ApprovalId.optional(),
  dryRun: z.boolean().default(false),
});
export const PublishGithubReportOutput = z.strictObject({
  reportId: ReportId,
  scopeDigest: Sha256,
  dryRun: z.boolean(),
  results: z.array(
    z.strictObject({
      mechanism: PublishMechanism,
      status: PublishStatus,
      remoteId: S(256).nullable(),
      url: S(2048).nullable(),
      errorCode: z.string().nullable(),
    }),
  ),
});

// ------------------------------------------------------------------ Registry
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}
export interface ToolContract {
  readonly id: `TL-${string}`;
  readonly name: string;
  /** Permission tier(s); TL-14 varies per action (P1/P2). */
  readonly tier: readonly z.infer<typeof PermissionTier>[];
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  /** Advisory only (RL-002); enforcement lives in @autotest/policy. */
  readonly annotations: ToolAnnotations;
  /** Claude Code `_meta` hints, defense in depth only (ADR-0006 §5). */
  readonly requiresUserInteraction: boolean;
}

const ann = (
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolAnnotations => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint,
});

export const TOOLS = [
  {
    id: 'TL-01',
    name: 'get_pr_context',
    tier: ['P0'],
    input: GetPrContextInput,
    output: GetPrContextOutput,
    annotations: ann(true, false, false, true),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-02',
    name: 'inspect_project',
    tier: ['P0'],
    input: InspectProjectInput,
    output: InspectProjectOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-03',
    name: 'inspect_test_inventory',
    tier: ['P0'],
    input: InspectTestInventoryInput,
    output: InspectTestInventoryOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-04',
    name: 'extract_requirements',
    tier: ['P0'],
    input: ExtractRequirementsInput,
    output: ExtractRequirementsOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-05',
    name: 'generate_test_plan',
    tier: ['P0'],
    input: GenerateTestPlanInput,
    output: GenerateTestPlanOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-06',
    name: 'validate_test_coverage',
    tier: ['P0'],
    input: ValidateTestCoverageInput,
    output: ValidateTestCoverageOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-07',
    name: 'request_approval',
    tier: ['P0'],
    input: RequestApprovalInput,
    output: RequestApprovalOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: true,
  },
  {
    id: 'TL-08',
    name: 'get_approval_status',
    tier: ['P0'],
    input: GetApprovalStatusInput,
    output: GetApprovalStatusOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-09',
    name: 'run_tests',
    tier: ['P1'],
    input: RunTestsInput,
    output: RunTestsOutput,
    annotations: ann(false, false, false, true),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-10',
    name: 'get_run_status',
    tier: ['P0'],
    input: GetRunStatusInput,
    output: GetRunStatusOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-11',
    name: 'get_run_results',
    tier: ['P0'],
    input: GetRunResultsInput,
    output: GetRunResultsOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-12',
    name: 'cancel_test_run',
    tier: ['P1'],
    input: CancelTestRunInput,
    output: CancelTestRunOutput,
    annotations: ann(false, true, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-13',
    name: 'list_devices',
    tier: ['P0'],
    input: ListDevicesInput,
    output: ListDevicesOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-14',
    name: 'manage_simulator',
    tier: ['P1', 'P2'],
    input: ManageSimulatorInput,
    output: ManageSimulatorOutput,
    annotations: ann(false, true, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-15',
    name: 'collect_test_evidence',
    tier: ['P0'],
    input: CollectTestEvidenceInput,
    output: CollectTestEvidenceOutput,
    annotations: ann(true, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-16',
    name: 'analyze_test_failures',
    tier: ['P0'],
    input: AnalyzeTestFailuresInput,
    output: AnalyzeTestFailuresOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-17',
    name: 'generate_pr_test_report',
    tier: ['P0'],
    input: GeneratePrTestReportInput,
    output: GeneratePrTestReportOutput,
    annotations: ann(false, false, true, false),
    requiresUserInteraction: false,
  },
  {
    id: 'TL-18',
    name: 'publish_github_report',
    tier: ['P3'],
    input: PublishGithubReportInput,
    output: PublishGithubReportOutput,
    annotations: ann(false, false, true, true),
    requiresUserInteraction: true,
  },
] as const satisfies readonly ToolContract[];

export type ToolName = (typeof TOOLS)[number]['name'];
export const TOOL_NAMES = TOOLS.map((t) => t.name);

type ToolByName<N extends ToolName> = Extract<(typeof TOOLS)[number], { name: N }>;
/** Parsed (post-default) input type of a tool. */
export type ToolInput<N extends ToolName> = z.output<ToolByName<N>['input']>;
/** Raw (pre-default) input type a client may send. */
export type ToolRawInput<N extends ToolName> = z.input<ToolByName<N>['input']>;
/** Output (structuredContent) type of a tool. */
export type ToolOutput<N extends ToolName> = z.output<ToolByName<N>['output']>;
