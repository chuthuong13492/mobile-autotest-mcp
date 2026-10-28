/**
 * Canonical enumerations (CON-001).
 *
 * Source of truth: docs/data-model-and-artifacts.md §3 (states, outcomes, decisions, classes, verdicts),
 * docs/test-planning-and-coverage.md (techniques, risk tiers, ambiguity taxonomy) and
 * docs/security-threat-model.md (permission tiers). `enums.docsync.test.ts` fails if these drift from the docs.
 */
import { z } from 'zod';

// ---- Run lifecycle (data model §Run lifecycle) ----
export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'collecting',
  'analyzing',
  'cancelling',
  'cancel_pending',
  'completed',
  'cancelled',
  'timed_out',
  'infra_error',
] as const;
export const RunState = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunState>;

export const TERMINAL_RUN_STATES = [
  'completed',
  'cancelled',
  'timed_out',
  'infra_error',
] as const satisfies readonly RunState[];

export const StatusCategory = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
export type StatusCategory = z.infer<typeof StatusCategory>;

/** Mapping from run state to the coarse status category reported by get_run_status. */
export const STATUS_CATEGORY_BY_STATE: Readonly<Record<RunState, StatusCategory>> = {
  queued: 'pending',
  preparing: 'pending',
  running: 'running',
  collecting: 'running',
  analyzing: 'running',
  cancelling: 'running',
  cancel_pending: 'running',
  completed: 'completed',
  cancelled: 'cancelled',
  timed_out: 'failed',
  infra_error: 'failed',
};

export const CancelReason = z.enum(['user', 'timeout', 'authorization_invalidated', 'resource_quota']);
export type CancelReason = z.infer<typeof CancelReason>;

export const InfraReason = z.enum([
  'supervisor_lost',
  'orphan_unverified',
  'prerequisite_failed',
  'storage_error',
  'runner_crashed',
  'cancel_unconfirmed',
  'internal',
]);
export type InfraReason = z.infer<typeof InfraReason>;

// ---- Per-test outcome ----
export const TEST_OUTCOMES = [
  'passed',
  'failed',
  'blocked',
  'skipped',
  'cancelled',
  'timed_out',
  'infra_error',
  'not_run',
] as const;
export const TestOutcome = z.enum(TEST_OUTCOMES);
export type TestOutcome = z.infer<typeof TestOutcome>;

export const FailureKind = z.enum(['assertion', 'exception', 'load_error', 'crash']);
export type FailureKind = z.infer<typeof FailureKind>;

// ---- Coverage decision / requirement status ----
export const CoverageDecisionValue = z.enum(['pass', 'fail', 'needs_review']);
export type CoverageDecisionValue = z.infer<typeof CoverageDecisionValue>;

export const RequirementVerificationStatus = z.enum([
  'unmapped',
  'mapped',
  'eligible',
  'executed',
  'passing',
  'failing',
  'blocked',
  'excepted',
  'unverified',
]);
export type RequirementVerificationStatus = z.infer<typeof RequirementVerificationStatus>;

export const FindingSeverity = z.enum(['blocker', 'review', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

// ---- Approvals and authorization (ADR-0006) ----
export const ApprovalState = z.enum(['pending', 'approved', 'denied', 'expired', 'revoked', 'consumed', 'superseded']);
export type ApprovalState = z.infer<typeof ApprovalState>;

export const ApprovalRequestStatus = z.enum(['open', 'fulfilled', 'expired', 'withdrawn']);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatus>;

export const AssuranceLevel = z.enum(['AL1', 'AL2', 'AL3']);
export type AssuranceLevel = z.infer<typeof AssuranceLevel>;

export const ApprovalSource = z.enum(['elicitation', 'cli', 'preauth']);
export type ApprovalSource = z.infer<typeof ApprovalSource>;

export const ApprovalScopeKind = z.enum(['plan_execution', 'coverage_exception', 'device_action', 'github_publish']);
export type ApprovalScopeKind = z.infer<typeof ApprovalScopeKind>;

export const AuthorizationResult = z.enum(['authorized', 'denied']);
export type AuthorizationResult = z.infer<typeof AuthorizationResult>;

export const AUTHORIZATION_REASONS = [
  'plan_hash_mismatch',
  'coverage_missing',
  'coverage_stale',
  'coverage_failed',
  'approval_required',
  'approval_stale',
  'approval_expired',
  'approval_revoked',
  'approval_exhausted',
  'assurance_insufficient',
  'workspace_not_allowed',
  'target_not_eligible',
  'device_not_allowed',
  'environment_not_allowed',
  'command_denied',
  'prerequisite_missing',
  'superseded',
  'cancelled',
  'policy_unavailable',
  'unknown_state',
] as const;
export const AuthorizationReason = z.enum(AUTHORIZATION_REASONS);
export type AuthorizationReason = z.infer<typeof AuthorizationReason>;

export const ElicitationOutcome = z.enum(['not_offered', 'accepted_insufficient', 'accepted', 'declined', 'cancelled']);
export type ElicitationOutcome = z.infer<typeof ElicitationOutcome>;

// ---- Failure classification ----
export const FailureClass = z.enum(['product_defect', 'test_defect', 'environment_failure', 'pre_existing', 'unknown']);
export type FailureClass = z.infer<typeof FailureClass>;

/** Allowed subtypes per primary class (data model §Failure classification). */
export const FAILURE_SUBTYPES = {
  product_defect: ['behavior'],
  test_defect: ['assertion', 'setup', 'flaky'],
  environment_failure: ['infrastructure', 'dependency', 'device', 'toolchain'],
  pre_existing: ['baseline_failure', 'known_failure'],
  unknown: ['inconclusive'],
} as const satisfies Record<FailureClass, readonly string[]>;
export const FailureSubtype = z.enum([
  'behavior',
  'assertion',
  'setup',
  'flaky',
  'infrastructure',
  'dependency',
  'device',
  'toolchain',
  'baseline_failure',
  'known_failure',
  'inconclusive',
]);
export type FailureSubtype = z.infer<typeof FailureSubtype>;

export const AnalysisStrength = z.enum(['hypothesis', 'supported']);
export type AnalysisStrength = z.infer<typeof AnalysisStrength>;

// ---- Verdict ----
export const PrVerdict = z.enum(['pass', 'fail', 'inconclusive', 'blocked']);
export type PrVerdict = z.infer<typeof PrVerdict>;

// ---- Tiers ----
export const RiskTier = z.enum(['R0', 'R1', 'R2', 'R3']);
export type RiskTier = z.infer<typeof RiskTier>;

export const PermissionTier = z.enum(['P0', 'P1', 'P2', 'P3']);
export type PermissionTier = z.infer<typeof PermissionTier>;

// ---- Planning vocabulary ----
export const Platform = z.enum(['android', 'ios', 'web', 'macos', 'linux', 'windows', 'host']);
export type Platform = z.infer<typeof Platform>;

export const PlatformStatus = z.enum(['present', 'absent', 'unknown']);
export type PlatformStatus = z.infer<typeof PlatformStatus>;

export const TestLevel = z.enum(['unit', 'widget', 'component', 'integration', 'e2e']);
export type TestLevel = z.infer<typeof TestLevel>;

export const TestLevelOrManual = z.enum(['unit', 'widget', 'component', 'integration', 'e2e', 'manual']);
export type TestLevelOrManual = z.infer<typeof TestLevelOrManual>;

export const Technique = z.enum([
  'positive',
  'negative',
  'boundary',
  'state_transition',
  'error_handling',
  'regression',
  'accessibility',
  'security',
  'platform_specific',
]);
export type Technique = z.infer<typeof Technique>;

export const Priority = z.enum(['must', 'should', 'could']);
export type Priority = z.infer<typeof Priority>;

export const Automation = z.enum(['existing_test', 'new_test_required', 'manual']);
export type Automation = z.infer<typeof Automation>;

export const EligibilityReason = z.enum([
  'platform_unavailable',
  'capability_missing',
  'no_target',
  'manual',
  'policy_denied',
]);
export type EligibilityReason = z.infer<typeof EligibilityReason>;

export const RequirementKind = z.enum([
  'functional',
  'behavior_change',
  'bug_fix',
  'non_functional',
  'regression_scope',
]);
export type RequirementKind = z.infer<typeof RequirementKind>;

export const AcFormat = z.enum(['given_when_then', 'checklist', 'freeform']);
export type AcFormat = z.infer<typeof AcFormat>;

export const Provenance = z.enum(['parsed', 'agent', 'human']);
export type Provenance = z.infer<typeof Provenance>;

export const AmbiguitySeverity = z.enum(['low', 'medium', 'high']);
export type AmbiguitySeverity = z.infer<typeof AmbiguitySeverity>;

export const AmbiguityStatus = z.enum(['open', 'resolved', 'accepted']);
export type AmbiguityStatus = z.infer<typeof AmbiguityStatus>;

export const AmbiguityType = z.enum([
  'missing_ac',
  'vague_term',
  'conflicting_statements',
  'undefined_platform_scope',
  'unspecified_error_behavior',
  'unspecified_data',
  'unknown_baseline',
]);
export type AmbiguityType = z.infer<typeof AmbiguityType>;

export const ExceptionReason = z.enum(['not_testable', 'covered_elsewhere', 'deferred', 'out_of_scope']);
export type ExceptionReason = z.infer<typeof ExceptionReason>;

// ---- Inventory / devices ----
export const SelectorKind = z.enum(['file', 'name', 'tag', 'scheme', 'class', 'scenario']);
export type SelectorKind = z.infer<typeof SelectorKind>;

export const HostRequirement = z.enum(['any', 'macos', 'linux']);
export type HostRequirement = z.infer<typeof HostRequirement>;

export const DeviceNeed = z.enum(['none', 'simulator', 'emulator', 'physical']);
export type DeviceNeed = z.infer<typeof DeviceNeed>;

export const HelperKind = z.enum(['mock', 'fixture', 'helper', 'config']);
export type HelperKind = z.infer<typeof HelperKind>;

export const DeviceKind = z.enum(['simulator', 'emulator', 'physical']);
export type DeviceKind = z.infer<typeof DeviceKind>;

export const DeviceAvailability = z.enum(['available', 'busy', 'unavailable']);
export type DeviceAvailability = z.infer<typeof DeviceAvailability>;

export const SimulatorAction = z.enum(['boot', 'shutdown', 'create', 'erase', 'delete', 'install']);
export type SimulatorAction = z.infer<typeof SimulatorAction>;

export const DeviceApprovalAction = z.enum(['erase', 'delete', 'shutdown_non_owned', 'boot_non_owned']);
export type DeviceApprovalAction = z.infer<typeof DeviceApprovalAction>;

// ---- Evidence / publication / audit ----
export const ArtifactKind = z.enum([
  'stdout',
  'stderr',
  'runner_json',
  'junit',
  'xcresult',
  'screenshot',
  'video',
  'log',
  'coverage',
  'report',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const PublishMechanism = z.enum(['comment', 'check_run', 'commit_status']);
export type PublishMechanism = z.infer<typeof PublishMechanism>;

export const PublishStatus = z.enum(['published', 'updated', 'skipped', 'failed', 'would_publish']);
export type PublishStatus = z.infer<typeof PublishStatus>;

export const AuditActor = z.enum(['agent', 'cli', 'supervisor', 'server', 'ci']);
export type AuditActor = z.infer<typeof AuditActor>;

export const AUDIT_EVENT_KINDS = [
  'tool.call',
  'tool.result',
  'policy.decision',
  'authorization.decision',
  'coverage.decision',
  'approval.requested',
  'approval.created',
  'approval.consumed',
  'approval.revoked',
  'approval.expired',
  'approval.superseded',
  'plan.versioned',
  'run.created',
  'run.transition',
  'run.cancel_requested',
  'process.signal',
  'artifact.ingested',
  'artifact.quarantined',
  'device.action',
  'github.write',
  'config.loaded',
  'reconciliation.action',
  'report.generated',
  'known_failure.added',
  'known_failure.removed',
] as const;
export const AuditEventKind = z.enum(AUDIT_EVENT_KINDS);
export type AuditEventKind = z.infer<typeof AuditEventKind>;
