/**
 * Workflow ports (CORE-004; ADR-0002, ADR-0008). Implementations: `@autotest/storage` (SQLite + files) and the
 * in-memory fakes in `@autotest/core/testing`. Both must pass the shared contract cases in `./testing/portContract.ts`.
 */
import type {
  Approval,
  ApprovalRequest,
  AuditEvent,
  CoverageDecision,
  EvidenceArtifact,
  ExecutionAuthorizationDecision,
  FailureAnalysis,
  PRReport,
  PRContext,
  ProcessIdentity,
  ProjectProfile,
  PublishMechanism,
  PublishStatus,
  RequirementSet,
  Run,
  RunState,
  TestInventory,
  TestOutcome,
  TestPlan,
  TestResult,
} from '@autotest/contracts';

export type PortErrorCode = 'conflict' | 'not_found' | 'not_usable' | 'stale' | 'integrity';

/** Error thrown by port implementations; mapped to tool error codes by the workflow layer. */
export class PortError extends Error {
  override readonly name = 'PortError';
  readonly code: PortErrorCode;
  constructor(code: PortErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Clock {
  now(): Date;
}

/** Immutable plan versions (FR-015). Re-putting identical content is a no-op; different content for the same version is a conflict. */
export interface PlanStore {
  put(plan: TestPlan): Promise<void>;
  /** Latest version when `version` is omitted. */
  get(planId: string, version?: number): Promise<TestPlan | undefined>;
  getByHash(planHash: string): Promise<TestPlan | undefined>;
}

/** PR contexts (TL-01). Each retrieval is a new immutable record. */
export interface PrContextStore {
  put(context: PRContext): Promise<void>;
  get(id: string): Promise<PRContext | undefined>;
}

/** Immutable project profiles (TL-02). Re-putting identical content is a no-op; different content is a conflict. */
export interface ProfileStore {
  put(profile: ProjectProfile): Promise<void>;
  get(id: string): Promise<ProjectProfile | undefined>;
}

/** Immutable inventory snapshots (TL-03); pages are always drawn from a stored snapshot. */
export interface InventoryStore {
  put(inventory: TestInventory): Promise<void>;
  get(id: string): Promise<TestInventory | undefined>;
}

export interface RequirementStore {
  put(set: RequirementSet): Promise<void>;
  get(id: string): Promise<RequirementSet | undefined>;
  /** The latest set with this content hash, optionally only among sets of one PR context. */
  getByHash(requirementSetHash: string, prContextId?: string): Promise<RequirementSet | undefined>;
}

/** The three bindings that make a coverage decision current (ADR-0005 §3). */
export interface DecisionBinding {
  readonly planHash: string;
  readonly requirementSetHash: string;
  readonly gatePolicyVersion: string;
}

export interface DecisionStore {
  put(decision: CoverageDecision): Promise<void>;
  get(id: string): Promise<CoverageDecision | undefined>;
  /** Only a decision whose three bindings all match is current; anything else is stale. */
  findCurrent(binding: DecisionBinding): Promise<CoverageDecision | undefined>;
}

export interface ApprovalStore {
  putRequest(request: ApprovalRequest): Promise<void>;
  getRequest(id: string): Promise<ApprovalRequest | undefined>;
  putApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | undefined>;
  listByScopeDigest(scopeDigest: string): Promise<Approval[]>;
  /**
   * Atomically records one use. Throws `not_usable` unless state is `approved`, `now < expiresAt` and
   * `uses < maxUses`; reaching `maxUses` moves the approval to `consumed`. Never exceeds maxUses under concurrency.
   * Lazy expiry: an `approved` approval past its expiry is persisted as `expired` before `not_usable` is thrown.
   */
  consume(id: string, at: Date): Promise<Approval>;
  /** Revokes an `approved` or `pending` approval; throws `not_usable` for any other state. */
  revoke(id: string, by: string, at: Date): Promise<Approval>;
  /** Marks every `approved` approval bound to `planHash` as `superseded`; returns how many changed. */
  supersedeByPlanHash(planHash: string): Promise<number>;
  /** The unexpired open request for a scope digest, if any (request idempotency). */
  findOpenRequest(scopeDigest: string, at: Date): Promise<ApprovalRequest | undefined>;
  /** Unexpired open requests, newest first. */
  listOpenRequests(at: Date, limit: number): Promise<ApprovalRequest[]>;
  /** Approvals, newest first. */
  listRecentApprovals(limit: number): Promise<Approval[]>;
  /** Lazy expiry sweep: `approved` approvals and `open` requests at or past their expiry become `expired`. */
  expireDue(at: Date): Promise<{ approvals: number; requests: number }>;
}

/** Execution authorization decisions (ADR-0006 §4), persisted before the run they authorize or deny is reported. */
export interface AuthorizationStore {
  /** Throws `conflict` when the id exists with different content; an identical re-put is a no-op. */
  put(decision: ExecutionAuthorizationDecision): Promise<void>;
  get(id: string): Promise<ExecutionAuthorizationDecision | undefined>;
  /** Decisions recorded for a run, oldest first. */
  listByRun(runId: string): Promise<ExecutionAuthorizationDecision[]>;
}

/** One external write (or dry run) of a report to GitHub (TL-18). */
export interface PublicationRecord {
  readonly id: string;
  readonly reportId: string;
  readonly mechanism: PublishMechanism;
  readonly scopeDigest: string;
  readonly remoteId: string | null;
  readonly status: PublishStatus;
  readonly createdAt: string;
}

/** Publication records; one row per (scope digest, mechanism), replaced by a later publish of the same scope. */
export interface PublicationStore {
  put(record: PublicationRecord): Promise<void>;
  listByReport(reportId: string): Promise<PublicationRecord[]>;
}

/** Failure analyses (TL-16), keyed by run, result and ruleset version: a new ruleset re-analyzes, the old stays. */
export interface AnalysisStore {
  /** Stores analyses; an existing id with identical content is a no-op, different content is a `conflict`. */
  putMany(analyses: readonly FailureAnalysis[], rulesetVersion: string): Promise<void>;
  listByRun(runId: string, rulesetVersion: string): Promise<FailureAnalysis[]>;
}

/** PR reports (TL-17). Report content is immutable; the same content hash is the same report. */
export interface ReportStore {
  /** Returns the stored report: `report` itself, or the existing one with the same `reportHash`. */
  put(report: PRReport): Promise<PRReport>;
  get(id: string): Promise<PRReport | undefined>;
}

export interface RunStore {
  /** Throws `conflict` if the id or a non-null idempotencyKey already exists. */
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | undefined>;
  findByIdempotencyKey(key: string): Promise<Run | undefined>;
  /** Optimistic update: throws `stale` when `expectedState` is given and differs from the stored state. */
  update(
    id: string,
    patch: Partial<Omit<Run, 'id' | 'schemaVersion' | 'createdAt'>>,
    expectedState?: RunState,
  ): Promise<Run>;
  listNonTerminal(): Promise<Run[]>;
}

export interface ResultQuery {
  readonly outcomes?: readonly TestOutcome[];
  readonly targetId?: string;
  readonly offset: number;
  readonly limit: number;
}

export interface ResultStore {
  append(results: readonly TestResult[]): Promise<void>;
  /** Stable order (insertion) so offset paging never skips or repeats (FR-024). */
  list(runId: string, query: ResultQuery): Promise<{ items: TestResult[]; total: number }>;
}

export interface ArtifactIndex {
  put(artifact: EvidenceArtifact): Promise<void>;
  get(id: string): Promise<EvidenceArtifact | undefined>;
  list(runId: string): Promise<EvidenceArtifact[]>;
}

/** Audit append input: id, seq, prevHash and hash are assigned by the sink (hash chain, SR-015). */
export type AuditAppend = Omit<AuditEvent, 'id' | 'seq' | 'prevHash' | 'hash'>;

export interface AuditSink {
  append(event: AuditAppend): Promise<AuditEvent>;
  /** Events in sequence order (for chain verification). */
  readAll(): Promise<AuditEvent[]>;
}

/** A remembered result for an idempotency key (mcp-tool-contracts §2.5). */
export interface IdempotencyRecord {
  readonly tool: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly result: unknown;
  readonly expiresAt: string;
}

export interface IdempotencyStore {
  /** The unexpired record for `(tool, key)`, if any. */
  get(tool: string, key: string, at: Date): Promise<IdempotencyRecord | undefined>;
  /** Stores a record unless an unexpired one exists; returns the record that is now authoritative. */
  putIfAbsent(record: IdempotencyRecord, at: Date): Promise<IdempotencyRecord>;
}

/** Starts the detached run supervisor (ADR-0007); implemented by `@autotest/execution`. */
export interface ExecutionBackend {
  startSupervisor(runId: string): Promise<ProcessIdentity>;
}

export interface PublishRequest {
  readonly reportId: string;
  readonly mechanism: PublishMechanism;
  readonly scopeDigest: string;
  readonly body: string;
}

/** External publication (P3); implemented by `@autotest/github`. */
export interface Publisher {
  publish(request: PublishRequest): Promise<{ status: PublishStatus; remoteId: string | null; url: string | null }>;
}
