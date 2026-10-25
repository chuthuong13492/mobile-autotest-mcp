/**
 * In-memory port implementations for tests (CORE-004). They implement the same semantics the SQLite repositories
 * must provide, and pass the shared contract cases in `portContract.ts`. Values are deep-cloned on the way in and
 * out so callers cannot mutate stored state.
 */
import type {
  Approval,
  ApprovalRequest,
  AuditEvent,
  CoverageDecision,
  EvidenceArtifact,
  ExecutionAuthorizationDecision,
  FailureAnalysis,
  KnownFailure,
  PRContext,
  PRReport,
  ProjectProfile,
  RequirementSet,
  Run,
  TestInventory,
  TestPlan,
  TestResult,
} from '@autotest/contracts';
import { TERMINAL_RUN_STATES } from '@autotest/contracts';
import { auditHash } from '../audit.ts';
import { assertAuditData } from '../auditData.ts';
import { canonicalize } from '@autotest/contracts';
import { createIdGenerator } from '../ids.ts';
import {
  PortError,
  type ApprovalStore,
  type AnalysisStore,
  type ArtifactIndex,
  type AuditAppend,
  type AuthorizationStore,
  type AuditSink,
  type Clock,
  type DecisionBinding,
  type DecisionStore,
  type PlanStore,
  type RequirementStore,
  type ResultQuery,
  type ResultStore,
  type RunStore,
  type IdempotencyRecord,
  type IdempotencyStore,
  type InventoryStore,
  type KnownFailureStore,
  type DeviceLease,
  type DeviceLeaseStore,
  type PrContextStore,
  type ProfileStore,
  type PublicationRecord,
  type PublicationStore,
  type ReportStore,
} from '../ports.ts';

const clone = <T>(v: T): T => structuredClone(v);

export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class InMemoryPlanStore implements PlanStore {
  private readonly byKey = new Map<string, TestPlan>();
  async put(plan: TestPlan): Promise<void> {
    const key = `${plan.id}@${plan.version}`;
    const existing = this.byKey.get(key);
    if (existing) {
      if (canonicalize(existing) !== canonicalize(plan)) throw new PortError('conflict', `plan ${key} is immutable`);
      return;
    }
    if ([...this.byKey.values()].some((p) => p.planHash === plan.planHash && p.id !== plan.id))
      throw new PortError('conflict', `plan hash ${plan.planHash} already belongs to another plan`);
    this.byKey.set(key, clone(plan));
  }
  async get(planId: string, version?: number): Promise<TestPlan | undefined> {
    const versions = [...this.byKey.values()].filter((p) => p.id === planId).sort((a, b) => b.version - a.version);
    const hit = version === undefined ? versions[0] : versions.find((p) => p.version === version);
    return hit && clone(hit);
  }
  async getByHash(planHash: string): Promise<TestPlan | undefined> {
    const hit = [...this.byKey.values()].find((p) => p.planHash === planHash);
    return hit && clone(hit);
  }
}

export class InMemoryRequirementStore implements RequirementStore {
  private readonly sets = new Map<string, RequirementSet>();
  async put(set: RequirementSet): Promise<void> {
    const existing = this.sets.get(set.id);
    if (existing && canonicalize(existing) !== canonicalize(set))
      throw new PortError('conflict', `requirement set ${set.id} is immutable`);
    this.sets.set(set.id, clone(set));
  }
  async get(id: string): Promise<RequirementSet | undefined> {
    const s = this.sets.get(id);
    return s && clone(s);
  }
  async getByHash(hash: string, prContextId?: string): Promise<RequirementSet | undefined> {
    const s = [...this.sets.values()]
      .reverse()
      .find((x) => x.requirementSetHash === hash && (prContextId === undefined || x.prContextId === prContextId));
    return s && clone(s);
  }
}

export class InMemoryDecisionStore implements DecisionStore {
  private readonly decisions = new Map<string, CoverageDecision>();
  async put(d: CoverageDecision): Promise<void> {
    if (this.decisions.has(d.id)) throw new PortError('conflict', `decision ${d.id} is immutable`);
    this.decisions.set(d.id, clone(d));
  }
  async get(id: string): Promise<CoverageDecision | undefined> {
    const d = this.decisions.get(id);
    return d && clone(d);
  }
  async findCurrent(b: DecisionBinding): Promise<CoverageDecision | undefined> {
    // Newest first; insertion order breaks ties within one second.
    const hits = [...this.decisions.values()]
      .reverse()
      .filter(
        (d) =>
          d.planHash === b.planHash &&
          d.requirementSetHash === b.requirementSetHash &&
          d.gatePolicyVersion === b.gatePolicyVersion,
      )
      .sort((x, y) => (x.evaluatedAt < y.evaluatedAt ? 1 : x.evaluatedAt > y.evaluatedAt ? -1 : 0));
    return hits[0] && clone(hits[0]);
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly approvals = new Map<string, Approval>();
  async putRequest(r: ApprovalRequest): Promise<void> {
    this.requests.set(r.id, clone(r));
  }
  async getRequest(id: string): Promise<ApprovalRequest | undefined> {
    const r = this.requests.get(id);
    return r && clone(r);
  }
  async quarantine(id: string): Promise<void> {
    if (!this.approvals.delete(id)) throw new PortError('not_found', `approval ${id}`);
  }
  async putApproval(a: Approval): Promise<void> {
    if (this.approvals.has(a.id)) throw new PortError('conflict', `approval ${a.id} exists`);
    this.approvals.set(a.id, clone(a));
  }
  async getApproval(id: string): Promise<Approval | undefined> {
    const a = this.approvals.get(id);
    return a && clone(a);
  }
  async listByScopeDigest(digest: string): Promise<Approval[]> {
    return [...this.approvals.values()].filter((a) => a.scope.digest === digest).map(clone);
  }
  // Single-threaded event loop: the read-check-write below has no await between steps, so it is atomic.
  async consume(id: string, at: Date): Promise<Approval> {
    const a = this.approvals.get(id);
    if (!a) throw new PortError('not_found', `approval ${id}`);
    if (a.state !== 'approved') throw new PortError('not_usable', `approval ${id} is ${a.state}`);
    if (at.getTime() >= Date.parse(a.expiresAt)) {
      this.approvals.set(id, { ...a, state: 'expired' });
      throw new PortError('not_usable', `approval ${id} expired`);
    }
    if (a.uses >= a.maxUses) throw new PortError('not_usable', `approval ${id} exhausted`);
    const uses = a.uses + 1;
    const next: Approval = { ...a, uses, state: uses >= a.maxUses ? 'consumed' : 'approved' };
    this.approvals.set(id, next);
    return clone(next);
  }
  async revoke(id: string, by: string, at: Date): Promise<Approval> {
    const a = this.approvals.get(id);
    if (!a) throw new PortError('not_found', `approval ${id}`);
    if (a.state !== 'approved' && a.state !== 'pending')
      throw new PortError('not_usable', `approval ${id} is ${a.state}`);
    const next: Approval = {
      ...a,
      state: 'revoked',
      revokedAt: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      revokedBy: by,
    };
    this.approvals.set(id, next);
    return clone(next);
  }
  async supersedeByPlanHash(planHash: string): Promise<number> {
    let n = 0;
    for (const [id, a] of this.approvals) {
      if (a.planHash === planHash && a.state === 'approved') {
        this.approvals.set(id, { ...a, state: 'superseded' });
        n++;
      }
    }
    return n;
  }
  async findOpenRequest(scopeDigest: string, at: Date): Promise<ApprovalRequest | undefined> {
    const r = [...this.requests.values()]
      .reverse()
      .find((x) => x.scope.digest === scopeDigest && x.status === 'open' && at.getTime() < Date.parse(x.expiresAt));
    return r && clone(r);
  }
  async listOpenRequests(at: Date, limit: number): Promise<ApprovalRequest[]> {
    return [...this.requests.values()]
      .reverse()
      .filter((x) => x.status === 'open' && at.getTime() < Date.parse(x.expiresAt))
      .slice(0, limit)
      .map(clone);
  }
  async listRecentApprovals(limit: number): Promise<Approval[]> {
    return [...this.approvals.values()].reverse().slice(0, limit).map(clone);
  }
  async expireDue(at: Date): Promise<{ approvals: number; requests: number }> {
    let approvals = 0;
    let requests = 0;
    for (const [id, a] of this.approvals) {
      if (a.state === 'approved' && at.getTime() >= Date.parse(a.expiresAt)) {
        this.approvals.set(id, { ...a, state: 'expired' });
        approvals++;
      }
    }
    for (const [id, r] of this.requests) {
      if (r.status === 'open' && at.getTime() >= Date.parse(r.expiresAt)) {
        this.requests.set(id, { ...r, status: 'expired' });
        requests++;
      }
    }
    return { approvals, requests };
  }
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  private readonly decisions = new Map<string, ExecutionAuthorizationDecision>();
  async put(decision: ExecutionAuthorizationDecision): Promise<void> {
    const prev = this.decisions.get(decision.id);
    if (prev && canonicalize(prev) !== canonicalize(decision))
      throw new PortError('conflict', `authorization ${decision.id} exists with different content`);
    this.decisions.set(decision.id, clone(decision));
  }
  async get(id: string): Promise<ExecutionAuthorizationDecision | undefined> {
    const d = this.decisions.get(id);
    return d && clone(d);
  }
  async listByRun(runId: string): Promise<ExecutionAuthorizationDecision[]> {
    return [...this.decisions.values()].filter((d) => d.runId === runId).map(clone);
  }
}

export class InMemoryAnalysisStore implements AnalysisStore {
  private readonly rows = new Map<string, { analysis: FailureAnalysis; ruleset: string }>();
  async putMany(analyses: readonly FailureAnalysis[], rulesetVersion: string): Promise<void> {
    for (const a of analyses) {
      const prev = this.rows.get(a.id);
      if (prev && (canonicalize(prev.analysis) !== canonicalize(a) || prev.ruleset !== rulesetVersion))
        throw new PortError('conflict', `analysis ${a.id} exists with different content`);
    }
    for (const a of analyses) this.rows.set(a.id, { analysis: clone(a), ruleset: rulesetVersion });
  }
  async listByRun(runId: string, rulesetVersion: string): Promise<FailureAnalysis[]> {
    return [...this.rows.values()]
      .filter((r) => r.analysis.runId === runId && r.ruleset === rulesetVersion)
      .map((r) => clone(r.analysis));
  }
  async replaceForRun(runId: string, rulesetVersion: string, analyses: readonly FailureAnalysis[]): Promise<void> {
    for (const [id, r] of this.rows)
      if (r.analysis.runId === runId && r.ruleset === rulesetVersion) this.rows.delete(id);
    await this.putMany(analyses, rulesetVersion);
  }
}

export class InMemoryPublicationStore implements PublicationStore {
  private readonly rows = new Map<string, PublicationRecord>();
  async put(r: PublicationRecord): Promise<void> {
    this.rows.set(`${r.scopeDigest}\u0000${r.mechanism}`, clone(r));
  }
  async listByReport(reportId: string): Promise<PublicationRecord[]> {
    return [...this.rows.values()].filter((r) => r.reportId === reportId).map(clone);
  }
}

export class InMemoryReportStore implements ReportStore {
  private readonly reports = new Map<string, PRReport>();
  async put(report: PRReport): Promise<PRReport> {
    const same = [...this.reports.values()].find((r) => r.reportHash === report.reportHash);
    if (same) return clone(same);
    if (this.reports.has(report.id)) throw new PortError('conflict', `report ${report.id} exists`);
    this.reports.set(report.id, clone(report));
    return clone(report);
  }
  async get(id: string): Promise<PRReport | undefined> {
    const r = this.reports.get(id);
    return r && clone(r);
  }
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, Run>();
  async create(run: Run): Promise<void> {
    if (this.runs.has(run.id)) throw new PortError('conflict', `run ${run.id} exists`);
    if (
      run.idempotencyKey !== undefined &&
      [...this.runs.values()].some((r) => r.idempotencyKey === run.idempotencyKey)
    )
      throw new PortError('conflict', `idempotency key ${run.idempotencyKey} in use`);
    this.runs.set(run.id, clone(run));
  }
  async get(id: string): Promise<Run | undefined> {
    const r = this.runs.get(id);
    return r && clone(r);
  }
  async findByIdempotencyKey(key: string): Promise<Run | undefined> {
    const r = [...this.runs.values()].find((x) => x.idempotencyKey === key);
    return r && clone(r);
  }
  async update(id: string, patch: Partial<Run>, expectedState?: Run['state']): Promise<Run> {
    const r = this.runs.get(id);
    if (!r) throw new PortError('not_found', `run ${id}`);
    if (expectedState !== undefined && r.state !== expectedState)
      throw new PortError('stale', `run ${id} is ${r.state}, expected ${expectedState}`);
    const next = { ...r, ...clone(patch), id: r.id, schemaVersion: r.schemaVersion, createdAt: r.createdAt } as Run;
    this.runs.set(id, next);
    return clone(next);
  }
  async listNonTerminal(): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => !(TERMINAL_RUN_STATES as readonly string[]).includes(r.state))
      .map(clone);
  }
  async listByPlanHash(planHash: string): Promise<Run[]> {
    return [...this.runs.values()].filter((r) => r.planHash === planHash).map(clone);
  }
}

export class InMemoryDeviceLeaseStore implements DeviceLeaseStore {
  private readonly rows = new Map<string, DeviceLease>();
  async put(l: DeviceLease): Promise<void> {
    const other = [...this.rows.values()].find((x) => x.deviceId === l.deviceId && x.id !== l.id);
    if (other) throw new PortError('conflict', `device ${l.deviceId} already has lease ${other.id}`);
    this.rows.set(l.id, clone(l));
  }
  async findByDevice(deviceId: string): Promise<DeviceLease | undefined> {
    const l = [...this.rows.values()].find((x) => x.deviceId === deviceId);
    return l && clone(l);
  }
  async list(): Promise<DeviceLease[]> {
    return [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone);
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class InMemoryKnownFailureStore implements KnownFailureStore {
  private readonly rows = new Map<string, KnownFailure>();
  async add(entry: Omit<KnownFailure, 'id'>): Promise<KnownFailure> {
    const max = Math.max(0, ...[...this.rows.keys()].map((k) => Number(k.slice(3))));
    const kf = { id: `KF-${String(max + 1).padStart(3, '0')}`, ...clone(entry) };
    this.rows.set(kf.id, kf);
    return clone(kf);
  }
  async list(): Promise<KnownFailure[]> {
    return [...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id)).map(clone);
  }
  async remove(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

export class InMemoryResultStore implements ResultStore {
  private readonly results: TestResult[] = [];
  async append(results: readonly TestResult[]): Promise<void> {
    for (const r of results) {
      if (this.results.some((x) => x.id === r.id)) throw new PortError('conflict', `result ${r.id} exists`);
      this.results.push(clone(r));
    }
  }
  async list(runId: string, q: ResultQuery): Promise<{ items: TestResult[]; total: number }> {
    const all = this.results.filter(
      (r) =>
        r.runId === runId &&
        (!q.outcomes || q.outcomes.includes(r.outcome)) &&
        (!q.targetId || r.targetId === q.targetId),
    );
    return { items: all.slice(q.offset, q.offset + q.limit).map(clone), total: all.length };
  }
}

export class InMemoryArtifactIndex implements ArtifactIndex {
  private readonly items = new Map<string, EvidenceArtifact>();
  async put(a: EvidenceArtifact): Promise<void> {
    if (this.items.has(a.id)) throw new PortError('conflict', `artifact ${a.id} exists`);
    this.items.set(a.id, clone(a));
  }
  async get(id: string): Promise<EvidenceArtifact | undefined> {
    const a = this.items.get(id);
    return a && clone(a);
  }
  async list(runId: string): Promise<EvidenceArtifact[]> {
    return [...this.items.values()].filter((a) => a.runId === runId).map(clone);
  }
}

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];
  private readonly ids = createIdGenerator();
  async append(e: AuditAppend): Promise<AuditEvent> {
    assertAuditData(e.kind, e.data);
    const prev = this.events.at(-1);
    const base = { ...clone(e), id: this.ids.newId('aud'), seq: this.events.length, prevHash: prev?.hash ?? null };
    const event = { ...base, hash: auditHash(base) } as AuditEvent;
    this.events.push(event);
    return clone(event);
  }
  async readAll(): Promise<AuditEvent[]> {
    return this.events.map(clone);
  }
  /** Test hook: mutate a stored event to simulate tampering. */
  tamper(seq: number, patch: Partial<AuditEvent>): void {
    this.events[seq] = { ...this.events[seq]!, ...patch };
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  async get(tool: string, key: string, at: Date): Promise<IdempotencyRecord | undefined> {
    const r = this.records.get(`${tool}:${key}`);
    return r && at.getTime() < Date.parse(r.expiresAt) ? clone(r) : undefined;
  }
  async putIfAbsent(record: IdempotencyRecord, at: Date): Promise<IdempotencyRecord> {
    const existing = await this.get(record.tool, record.key, at);
    if (existing) return existing;
    this.records.set(`${record.tool}:${record.key}`, clone(record));
    return clone(record);
  }
}

/** Immutable-by-id store shared by the profile and inventory fakes. */
class ImmutableDocStore<T extends { id: string }> {
  private readonly docs = new Map<string, T>();
  private readonly what: string;
  constructor(what: string) {
    this.what = what;
  }
  async put(doc: T): Promise<void> {
    const existing = this.docs.get(doc.id);
    if (existing) {
      if (canonicalize(existing) !== canonicalize(doc))
        throw new PortError('conflict', `${this.what} ${doc.id} is immutable`);
      return;
    }
    this.docs.set(doc.id, clone(doc));
  }
  async get(id: string): Promise<T | undefined> {
    const d = this.docs.get(id);
    return d && clone(d);
  }
}

export class InMemoryProfileStore extends ImmutableDocStore<ProjectProfile> implements ProfileStore {
  constructor() {
    super('profile');
  }
}

export class InMemoryInventoryStore extends ImmutableDocStore<TestInventory> implements InventoryStore {
  constructor() {
    super('inventory');
  }
}

export class InMemoryPrContextStore extends ImmutableDocStore<PRContext> implements PrContextStore {
  constructor() {
    super('pr context');
  }
}
