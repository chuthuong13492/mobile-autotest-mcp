/** Ports and call context shared by every use case (CORE-006). Separate from `index.ts` to keep imports acyclic. */
import type {
  ApprovalStore,
  ArtifactIndex,
  AuditSink,
  Clock,
  CursorCodec,
  DecisionStore,
  ExecutionBackend,
  IdGenerator,
  InventoryStore,
  PlanStore,
  PrContextStore,
  ProfileStore,
  Publisher,
  RequirementStore,
  ResultStore,
  RunStore,
} from '@autotest/core';

/** Ports every use case may draw on; implementations are injected by each app's composition root. */
export interface WorkflowPorts {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly prContexts: PrContextStore;
  readonly profiles: ProfileStore;
  readonly inventories: InventoryStore;
  readonly plans: PlanStore;
  readonly requirements: RequirementStore;
  readonly decisions: DecisionStore;
  readonly approvals: ApprovalStore;
  readonly runs: RunStore;
  readonly results: ResultStore;
  readonly artifacts: ArtifactIndex;
  readonly audit: AuditSink;
  readonly execution: ExecutionBackend;
  /** HMAC cursors for paged tools (`paginate`). */
  readonly cursors: CursorCodec;
  /** Absent unless publication is configured (ADR-0013: read-only by default). */
  readonly publisher?: Publisher;
}

/** Per-call context; correlation IDs flow into logs and audit (NFR-008). */
export interface CallContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly actor: 'agent' | 'cli' | 'ci';
}
