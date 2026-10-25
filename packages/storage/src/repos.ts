/**
 * Repositories implementing the core ports over SQLite + the data root (STO-003; ADR-0008).
 * They must pass the same contract cases as the in-memory fakes (`@autotest/core/testing`).
 *
 * Approvals live in `approvals.ts` and the audit sink in `auditSink.ts`.
 *
 * Authority: plan snapshots, approval files and audit NDJSON are authoritative; their rows are an index that also
 * records the file's SHA-256, so tampering is detected on read (`PortError('integrity')`).
 * All operations are synchronous inside (node:sqlite is synchronous), which makes each port call atomic within a
 * process; IMMEDIATE transactions serialize writers across processes.
 */
import fs from 'node:fs';
import {
  CoverageDecision,
  EvidenceArtifact,
  ExecutionAuthorizationDecision,
  FailureAnalysis,
  KnownFailure,
  PortError,
  PRReport,
  PRContext,
  ProjectProfile,
  RequirementSet,
  Run,
  TERMINAL_RUN_STATES,
  TestInventory,
  TestPlan,
  TestResult,
  canonicalize,
  verifyPlanHash,
  type AnalysisStore,
  type ArtifactIndex,
  type AuthorizationStore,
  type PublicationRecord,
  type PublicationStore,
  type KnownFailureStore,
  type DeviceLease,
  type DeviceLeaseStore,
  type ReportStore,
  type DecisionBinding,
  type DecisionStore,
  type InventoryStore,
  type PrContextStore,
  type PlanStore,
  type ProfileStore,
  type RequirementStore,
  type ResultQuery,
  type ResultStore,
  type RunStore,
} from '@autotest/core';
import { atomicWriteSync, dataRootPaths, sha256OfFile, sha256OfText } from './fs.ts';
import { SqliteApprovalStore } from './approvals.ts';
import { FileAuditSink } from './auditSink.ts';
import { SqliteIdempotencyStore } from './idempotency.ts';
import { SqliteConstraintError, type SqlParam, type SqlPort } from './sql.ts';
import { parseDoc } from './util.ts';

const conflictOnConstraint = <T>(what: string, f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof SqliteConstraintError) throw new PortError('conflict', `${what}: ${e.message}`);
    throw e;
  }
};

export class SqlitePlanStore implements PlanStore {
  private readonly sql: SqlPort;
  private readonly paths: ReturnType<typeof dataRootPaths>;
  constructor(sql: SqlPort, root: string) {
    this.sql = sql;
    this.paths = dataRootPaths(root);
  }
  async put(plan: TestPlan): Promise<void> {
    const parsed = TestPlan.parse(plan);
    if (!verifyPlanHash(parsed))
      throw new PortError('integrity', `plan ${plan.id}@${plan.version}: planHash does not match content`);
    const text = canonicalize(parsed);
    const file = this.paths.planSnapshot(parsed.id, parsed.planHash);
    this.sql.transaction(() => {
      const existing = this.sql.get<{ plan_hash: string; snapshot_sha256: string }>(
        'SELECT plan_hash, snapshot_sha256 FROM plans WHERE id = ? AND version = ?',
        parsed.id,
        parsed.version,
      );
      if (existing) {
        if (existing.snapshot_sha256 !== sha256OfText(text))
          throw new PortError('conflict', `plan ${parsed.id}@${parsed.version} is immutable`);
        return;
      }
      const owner = this.sql.get<{ id: string }>('SELECT id FROM plans WHERE plan_hash = ?', parsed.planHash);
      if (owner) throw new PortError('conflict', `plan hash ${parsed.planHash} already stored for ${owner.id}`);
      atomicWriteSync(file, text);
      this.sql.run(
        'INSERT INTO plans (id, version, plan_hash, hash_version, requirement_set_id, risk_policy_version, snapshot_path, snapshot_sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        parsed.id,
        parsed.version,
        parsed.planHash,
        parsed.hashVersion,
        parsed.requirementSetId,
        parsed.riskPolicyVersion,
        file,
        sha256OfText(text),
        parsed.createdAt,
      );
    });
  }
  async get(planId: string, version?: number): Promise<TestPlan | undefined> {
    const row =
      version === undefined
        ? this.sql.get<PlanRow>('SELECT * FROM plans WHERE id = ? ORDER BY version DESC LIMIT 1', planId)
        : this.sql.get<PlanRow>('SELECT * FROM plans WHERE id = ? AND version = ?', planId, version);
    return row && this.load(row);
  }
  async getByHash(planHash: string): Promise<TestPlan | undefined> {
    const row = this.sql.get<PlanRow>('SELECT * FROM plans WHERE plan_hash = ?', planHash);
    return row && this.load(row);
  }
  /** Loads a snapshot, verifying file checksum, schema and recomputed plan hash (tamper detection). */
  private load(row: PlanRow): TestPlan {
    if (!fs.existsSync(row.snapshot_path))
      throw new PortError('integrity', `plan snapshot missing: ${row.id}@${row.version}`);
    if (sha256OfFile(row.snapshot_path) !== row.snapshot_sha256)
      throw new PortError('integrity', `plan snapshot modified: ${row.id}@${row.version}`);
    const plan = parseDoc(TestPlan, fs.readFileSync(row.snapshot_path, 'utf8'), `plan ${row.id}`);
    if (plan.planHash !== row.plan_hash || !verifyPlanHash(plan))
      throw new PortError('integrity', `plan hash mismatch: ${row.id}@${row.version}`);
    return plan;
  }
}
interface PlanRow {
  id: string;
  version: number;
  plan_hash: string;
  snapshot_path: string;
  snapshot_sha256: string;
}

export class SqlitePrContextStore implements PrContextStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(context: PRContext): Promise<void> {
    const c = PRContext.parse(context);
    const doc = canonicalize(c);
    this.sql.transaction(() => {
      const existing = this.sql.get<{ doc: string }>('SELECT doc FROM pr_contexts WHERE id = ?', c.id);
      if (existing) {
        if (existing.doc !== doc) throw new PortError('conflict', `pr context ${c.id} is immutable`);
        return;
      }
      this.sql.run(
        'INSERT INTO pr_contexts (id, source, host, owner, name, number, head_sha, created_at, doc) VALUES (?,?,?,?,?,?,?,?,?)',
        c.id,
        c.source,
        c.repository.host,
        c.repository.owner ?? null,
        c.repository.name ?? null,
        c.number ?? null,
        c.head?.sha ?? null,
        c.createdAt,
        doc,
      );
    });
  }
  async get(id: string): Promise<PRContext | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM pr_contexts WHERE id = ?', id);
    return row && parseDoc(PRContext, row.doc, `pr context ${id}`);
  }
}

export class SqliteProfileStore implements ProfileStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(profile: ProjectProfile): Promise<void> {
    const p = ProjectProfile.parse(profile);
    const doc = canonicalize(p);
    this.sql.transaction(() => {
      const existing = this.sql.get<{ doc: string }>('SELECT doc FROM project_profiles WHERE id = ?', p.id);
      if (existing) {
        if (existing.doc !== doc) throw new PortError('conflict', `profile ${p.id} is immutable`);
        return;
      }
      this.sql.run(
        'INSERT INTO project_profiles (id, workspace_realpath, created_at, doc) VALUES (?,?,?,?)',
        p.id,
        p.workspace.rootRealPath,
        p.createdAt,
        doc,
      );
    });
  }
  async get(id: string): Promise<ProjectProfile | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM project_profiles WHERE id = ?', id);
    return row && parseDoc(ProjectProfile, row.doc, `profile ${id}`);
  }
}

/** Inventory snapshots: the canonical document in `inventories.doc`, plus one `test_targets` row per target for queries. */
export class SqliteInventoryStore implements InventoryStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(inventory: TestInventory): Promise<void> {
    const inv = TestInventory.parse(inventory);
    const doc = canonicalize(inv);
    this.sql.transaction(() => {
      const existing = this.sql.get<{ doc: string }>('SELECT doc FROM inventories WHERE id = ?', inv.id);
      if (existing) {
        if (existing.doc !== doc) throw new PortError('conflict', `inventory ${inv.id} is immutable`);
        return;
      }
      this.sql.run(
        'INSERT INTO inventories (id, profile_id, complete, created_at, doc) VALUES (?,?,?,?,?)',
        inv.id,
        inv.profileId,
        inv.completeness.complete ? 1 : 0,
        inv.createdAt,
        doc,
      );
      for (const t of inv.targets) {
        this.sql.run(
          'INSERT INTO test_targets (id, inventory_id, adapter_id, level, path, selector, requires_host, requires_device) VALUES (?,?,?,?,?,?,?,?)',
          t.id,
          inv.id,
          t.adapterId,
          t.level,
          t.path,
          t.selector ? canonicalize(t.selector) : null,
          t.requires.host,
          t.requires.device,
        );
      }
    });
  }
  async get(id: string): Promise<TestInventory | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM inventories WHERE id = ?', id);
    return row && parseDoc(TestInventory, row.doc, `inventory ${id}`);
  }
}

export class SqliteRequirementStore implements RequirementStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(set: RequirementSet): Promise<void> {
    const parsed = RequirementSet.parse(set);
    const doc = canonicalize(parsed);
    this.sql.transaction(() => {
      const existing = this.sql.get<{ doc: string }>('SELECT doc FROM requirement_sets WHERE id = ?', parsed.id);
      if (existing) {
        if (existing.doc !== doc) throw new PortError('conflict', `requirement set ${parsed.id} is immutable`);
        return;
      }
      this.sql.run(
        'INSERT INTO requirement_sets (id, pr_context_id, set_hash, created_at, doc) VALUES (?,?,?,?,?)',
        parsed.id,
        parsed.prContextId,
        parsed.requirementSetHash,
        parsed.createdAt,
        doc,
      );
    });
  }
  async get(id: string): Promise<RequirementSet | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM requirement_sets WHERE id = ?', id);
    return row && parseDoc(RequirementSet, row.doc, `requirement set ${id}`);
  }
  async getByHash(hash: string, prContextId?: string): Promise<RequirementSet | undefined> {
    const row =
      prContextId === undefined
        ? this.sql.get<{ doc: string; id: string }>(
            'SELECT doc, id FROM requirement_sets WHERE set_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            hash,
          )
        : this.sql.get<{ doc: string; id: string }>(
            'SELECT doc, id FROM requirement_sets WHERE set_hash = ? AND pr_context_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            hash,
            prContextId,
          );
    return row && parseDoc(RequirementSet, row.doc, `requirement set ${row.id}`);
  }
}

export class SqliteDecisionStore implements DecisionStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(d: CoverageDecision): Promise<void> {
    const p = CoverageDecision.parse(d);
    conflictOnConstraint(`decision ${p.id}`, () =>
      this.sql.run(
        'INSERT INTO coverage_decisions (id, plan_hash, requirement_set_hash, gate_policy_version, decision, evaluated_at, doc) VALUES (?,?,?,?,?,?,?)',
        p.id,
        p.planHash,
        p.requirementSetHash,
        p.gatePolicyVersion,
        p.decision,
        p.evaluatedAt,
        canonicalize(p),
      ),
    );
  }
  async get(id: string): Promise<CoverageDecision | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM coverage_decisions WHERE id = ?', id);
    return row && parseDoc(CoverageDecision, row.doc, `decision ${id}`);
  }
  async findCurrent(b: DecisionBinding): Promise<CoverageDecision | undefined> {
    const row = this.sql.get<{ doc: string; id: string }>(
      'SELECT doc, id FROM coverage_decisions WHERE plan_hash = ? AND requirement_set_hash = ? AND gate_policy_version = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1',
      b.planHash,
      b.requirementSetHash,
      b.gatePolicyVersion,
    );
    return row && parseDoc(CoverageDecision, row.doc, `decision ${row.id}`);
  }
}

export class SqliteAuthorizationStore implements AuthorizationStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(decision: ExecutionAuthorizationDecision): Promise<void> {
    const d = ExecutionAuthorizationDecision.parse(decision);
    const doc = canonicalize(d);
    const prev = await this.get(d.id);
    if (prev) {
      if (canonicalize(prev) !== doc)
        throw new PortError('conflict', `authorization ${d.id} exists with different content`);
      return;
    }
    this.sql.run(
      'INSERT INTO authorization_decisions (id, run_id, phase, result, reasons, inputs_digest, evaluated_at) VALUES (?,?,?,?,?,?,?)',
      d.id,
      d.runId ?? null,
      d.phase,
      d.result,
      JSON.stringify(d.reasons),
      d.inputsDigest,
      d.evaluatedAt,
    );
  }
  async get(id: string): Promise<ExecutionAuthorizationDecision | undefined> {
    const row = this.sql.get<AuthorizationRow>('SELECT * FROM authorization_decisions WHERE id = ?', id);
    return row && fromAuthorizationRow(row);
  }
  async listByRun(runId: string): Promise<ExecutionAuthorizationDecision[]> {
    return this.sql
      .all<AuthorizationRow>(
        'SELECT * FROM authorization_decisions WHERE run_id = ? ORDER BY evaluated_at, rowid',
        runId,
      )
      .map(fromAuthorizationRow);
  }
}

interface AuthorizationRow {
  id: string;
  run_id: string | null;
  phase: string;
  result: string;
  reasons: string;
  inputs_digest: string;
  evaluated_at: string;
}

function fromAuthorizationRow(r: AuthorizationRow): ExecutionAuthorizationDecision {
  const parsed = ExecutionAuthorizationDecision.safeParse({
    id: r.id,
    schemaVersion: 1,
    ...(r.run_id ? { runId: r.run_id } : {}),
    phase: r.phase,
    result: r.result,
    reasons: JSON.parse(r.reasons) as unknown,
    inputsDigest: r.inputs_digest,
    evaluatedAt: r.evaluated_at,
  });
  if (!parsed.success) throw new PortError('integrity', `authorization ${r.id} failed validation`);
  return parsed.data;
}

export class SqliteAnalysisStore implements AnalysisStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async putMany(analyses: readonly FailureAnalysis[], rulesetVersion: string): Promise<void> {
    const parsed = analyses.map((a) => FailureAnalysis.parse(a));
    this.sql.transaction(() => this.insert(parsed, rulesetVersion));
  }
  private insert(parsed: readonly FailureAnalysis[], rulesetVersion: string): void {
    for (const a of parsed) {
      const doc = canonicalize(a);
      const prev = this.sql.get<{ doc: string; ruleset_version: string }>(
        'SELECT doc, ruleset_version FROM failure_analyses WHERE id = ?',
        a.id,
      );
      if (prev) {
        if (prev.doc !== doc || prev.ruleset_version !== rulesetVersion)
          throw new PortError('conflict', `analysis ${a.id} exists with different content`);
        continue;
      }
      this.sql.run(
        'INSERT INTO failure_analyses (id, run_id, result_id, ruleset_version, class, doc) VALUES (?,?,?,?,?,?)',
        a.id,
        a.runId,
        a.resultId,
        rulesetVersion,
        a.class,
        doc,
      );
    }
  }
  async replaceForRun(runId: string, rulesetVersion: string, analyses: readonly FailureAnalysis[]): Promise<void> {
    const parsed = analyses.map((a) => FailureAnalysis.parse(a));
    this.sql.transaction(() => {
      this.sql.run('DELETE FROM failure_analyses WHERE run_id = ? AND ruleset_version = ?', runId, rulesetVersion);
      this.insert(parsed, rulesetVersion);
    });
  }
  async listByRun(runId: string, rulesetVersion: string): Promise<FailureAnalysis[]> {
    return this.sql
      .all<{ doc: string; id: string }>(
        'SELECT doc, id FROM failure_analyses WHERE run_id = ? AND ruleset_version = ? ORDER BY rowid',
        runId,
        rulesetVersion,
      )
      .map((r) => parseDoc(FailureAnalysis, r.doc, `analysis ${r.id}`));
  }
}

/** The known-failure registry (ANL-002); the row's columns mirror the document for lookups. */
export class SqliteKnownFailureStore implements KnownFailureStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async add(entry: Omit<KnownFailure, 'id'>): Promise<KnownFailure> {
    return this.sql.transaction(() => {
      const last = this.sql.get<{ id: string }>('SELECT id FROM known_failures ORDER BY id DESC LIMIT 1');
      const kf = KnownFailure.parse({
        id: `KF-${String((last ? Number(last.id.slice(3)) : 0) + 1).padStart(3, '0')}`,
        ...entry,
      });
      this.sql.run(
        'INSERT INTO known_failures (id, target_id, name_pattern, reason, expires_at, doc) VALUES (?,?,?,?,?,?)',
        kf.id,
        kf.targetId,
        kf.namePattern,
        kf.reason,
        kf.expiresAt,
        canonicalize(kf),
      );
      return kf;
    });
  }
  async list(): Promise<KnownFailure[]> {
    return this.sql
      .all<{ doc: string; id: string }>('SELECT doc, id FROM known_failures ORDER BY id')
      .map((r) => parseDoc(KnownFailure, r.doc, `known failure ${r.id}`));
  }
  async remove(id: string): Promise<boolean> {
    const before = this.sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM known_failures WHERE id = ?', id);
    this.sql.run('DELETE FROM known_failures WHERE id = ?', id);
    return (before?.n ?? 0) > 0;
  }
}

/** Device leases (DEV-002) in the `device_leases` table of schema v1. */
export class SqliteDeviceLeaseStore implements DeviceLeaseStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(l: DeviceLease): Promise<void> {
    this.sql.transaction(() => {
      const other = this.sql.get<{ id: string }>(
        'SELECT id FROM device_leases WHERE device_id = ? AND id != ?',
        l.deviceId,
        l.id,
      );
      if (other) throw new PortError('conflict', `device ${l.deviceId} already has lease ${other.id}`);
      this.sql.run(
        `INSERT INTO device_leases (id, device_id, run_id, owned, created_by_autotest, expires_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET device_id = excluded.device_id, run_id = excluded.run_id, owned = excluded.owned,
           created_by_autotest = excluded.created_by_autotest, expires_at = excluded.expires_at`,
        l.id,
        l.deviceId,
        l.runId,
        l.owned ? 1 : 0,
        l.createdByAutotest ? 1 : 0,
        l.expiresAt,
      );
    });
  }
  private row(r: {
    id: string;
    device_id: string;
    run_id: string | null;
    owned: number;
    created_by_autotest: number;
    expires_at: string;
  }): DeviceLease {
    return {
      id: r.id,
      deviceId: r.device_id,
      runId: r.run_id,
      owned: r.owned === 1,
      createdByAutotest: r.created_by_autotest === 1,
      expiresAt: r.expires_at,
    };
  }
  async findByDevice(deviceId: string): Promise<DeviceLease | undefined> {
    const r = this.sql.get<Parameters<SqliteDeviceLeaseStore['row']>[0]>(
      'SELECT * FROM device_leases WHERE device_id = ?',
      deviceId,
    );
    return r && this.row(r);
  }
  async list(): Promise<DeviceLease[]> {
    return this.sql
      .all<Parameters<SqliteDeviceLeaseStore['row']>[0]>('SELECT * FROM device_leases ORDER BY id')
      .map((r) => this.row(r));
  }
  async remove(id: string): Promise<boolean> {
    return this.sql.run('DELETE FROM device_leases WHERE id = ?', id).changes > 0;
  }
}

export class SqlitePublicationStore implements PublicationStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(r: PublicationRecord): Promise<void> {
    this.sql.run(
      `INSERT INTO publications (id, report_id, mechanism, scope_digest, remote_id, status, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (scope_digest, mechanism) DO UPDATE SET id = excluded.id, report_id = excluded.report_id,
         remote_id = excluded.remote_id, status = excluded.status, created_at = excluded.created_at`,
      r.id,
      r.reportId,
      r.mechanism,
      r.scopeDigest,
      r.remoteId,
      r.status,
      r.createdAt,
    );
  }
  async listByReport(reportId: string): Promise<PublicationRecord[]> {
    return this.sql
      .all<{
        id: string;
        report_id: string;
        mechanism: string;
        scope_digest: string;
        remote_id: string | null;
        status: string;
        created_at: string;
      }>('SELECT * FROM publications WHERE report_id = ? ORDER BY created_at, rowid', reportId)
      .map((r) => ({
        id: r.id,
        reportId: r.report_id,
        mechanism: r.mechanism as PublicationRecord['mechanism'],
        scopeDigest: r.scope_digest,
        remoteId: r.remote_id,
        status: r.status as PublicationRecord['status'],
        createdAt: r.created_at,
      }));
  }
}

export class SqliteReportStore implements ReportStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(report: PRReport): Promise<PRReport> {
    const r = PRReport.parse(report);
    const same = this.sql.get<{ doc: string; id: string }>(
      'SELECT doc, id FROM reports WHERE report_hash = ?',
      r.reportHash,
    );
    if (same) return parseDoc(PRReport, same.doc, `report ${same.id}`);
    conflictOnConstraint(`report ${r.id}`, () =>
      this.sql.run(
        'INSERT INTO reports (id, plan_hash, verdict, report_hash, created_at, doc) VALUES (?,?,?,?,?,?)',
        r.id,
        r.planHash,
        r.verdict,
        r.reportHash,
        r.createdAt,
        canonicalize(r),
      ),
    );
    return r;
  }
  async get(id: string): Promise<PRReport | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM reports WHERE id = ?', id);
    return row && parseDoc(PRReport, row.doc, `report ${id}`);
  }
}

export class SqliteRunStore implements RunStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async create(run: Run): Promise<void> {
    const r = Run.parse(run);
    conflictOnConstraint(`run ${r.id}`, () =>
      this.sql.run(
        'INSERT INTO runs (id, plan_hash, state, status_category, idempotency_key, created_at, doc) VALUES (?,?,?,?,?,?,?)',
        r.id,
        r.planHash,
        r.state,
        r.statusCategory,
        r.idempotencyKey ?? null,
        r.createdAt,
        canonicalize(r),
      ),
    );
  }
  async get(id: string): Promise<Run | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM runs WHERE id = ?', id);
    return row && parseDoc(Run, row.doc, `run ${id}`);
  }
  async findByIdempotencyKey(key: string): Promise<Run | undefined> {
    const row = this.sql.get<{ doc: string; id: string }>('SELECT doc, id FROM runs WHERE idempotency_key = ?', key);
    return row && parseDoc(Run, row.doc, `run ${row.id}`);
  }
  async update(id: string, patch: Partial<Run>, expectedState?: Run['state']): Promise<Run> {
    return this.sql.transaction(() => {
      const row = this.sql.get<{ doc: string; state: string }>('SELECT doc, state FROM runs WHERE id = ?', id);
      if (!row) throw new PortError('not_found', `run ${id}`);
      if (expectedState !== undefined && row.state !== expectedState)
        throw new PortError('stale', `run ${id} is ${row.state}, expected ${expectedState}`);
      const current = parseDoc(Run, row.doc, `run ${id}`);
      const next = Run.parse({
        ...current,
        ...patch,
        id: current.id,
        schemaVersion: current.schemaVersion,
        createdAt: current.createdAt,
      });
      this.sql.run(
        'UPDATE runs SET state = ?, status_category = ?, doc = ? WHERE id = ?',
        next.state,
        next.statusCategory,
        canonicalize(next),
        id,
      );
      return next;
    });
  }
  async listByPlanHash(planHash: string): Promise<Run[]> {
    return this.sql
      .all<{ doc: string; id: string }>(
        'SELECT doc, id FROM runs WHERE plan_hash = ? ORDER BY created_at, id',
        planHash,
      )
      .map((r) => parseDoc(Run, r.doc, `run ${r.id}`));
  }
  async listNonTerminal(): Promise<Run[]> {
    const placeholders = TERMINAL_RUN_STATES.map(() => '?').join(',');
    return this.sql
      .all<{ doc: string; id: string }>(
        `SELECT doc, id FROM runs WHERE state NOT IN (${placeholders}) ORDER BY created_at`,
        ...TERMINAL_RUN_STATES,
      )
      .map((r) => parseDoc(Run, r.doc, `run ${r.id}`));
  }
}

export class SqliteResultStore implements ResultStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async append(results: readonly TestResult[]): Promise<void> {
    const parsed = results.map((r) => TestResult.parse(r));
    conflictOnConstraint('results', () =>
      this.sql.transaction(() => {
        for (const r of parsed)
          this.sql.run(
            'INSERT INTO test_results (id, run_id, target_id, outcome, doc) VALUES (?,?,?,?,?)',
            r.id,
            r.runId,
            r.targetId,
            r.outcome,
            canonicalize(r),
          );
      }),
    );
  }
  async list(runId: string, q: ResultQuery): Promise<{ items: TestResult[]; total: number }> {
    const where = ['run_id = ?'];
    const params: SqlParam[] = [runId];
    if (q.outcomes) {
      where.push(`outcome IN (${q.outcomes.map(() => '?').join(',') || 'NULL'})`);
      params.push(...q.outcomes);
    }
    if (q.targetId) {
      where.push('target_id = ?');
      params.push(q.targetId);
    }
    const clause = where.join(' AND ');
    const total = this.sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM test_results WHERE ${clause}`, ...params)!.n;
    const items = this.sql
      .all<{ doc: string; id: string }>(
        `SELECT doc, id FROM test_results WHERE ${clause} ORDER BY seq LIMIT ? OFFSET ?`,
        ...params,
        q.limit,
        q.offset,
      )
      .map((r) => parseDoc(TestResult, r.doc, `result ${r.id}`));
    return { items, total };
  }
}

export class SqliteArtifactIndex implements ArtifactIndex {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }
  async put(a: EvidenceArtifact): Promise<void> {
    const p = EvidenceArtifact.parse(a);
    conflictOnConstraint(`artifact ${p.id}`, () =>
      this.sql.run(
        'INSERT INTO artifacts (id, run_id, kind, rel_path, sha256, quarantined, doc) VALUES (?,?,?,?,?,?,?)',
        p.id,
        p.runId,
        p.kind,
        p.relativePath,
        p.sha256,
        p.quarantined ? 1 : 0,
        canonicalize(p),
      ),
    );
  }
  async get(id: string): Promise<EvidenceArtifact | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM artifacts WHERE id = ?', id);
    return row && parseDoc(EvidenceArtifact, row.doc, `artifact ${id}`);
  }
  async list(runId: string): Promise<EvidenceArtifact[]> {
    return this.sql
      .all<{ doc: string; id: string }>('SELECT doc, id FROM artifacts WHERE run_id = ? ORDER BY id', runId)
      .map((r) => parseDoc(EvidenceArtifact, r.doc, `artifact ${r.id}`));
  }
}

/** Append-only, hash-chained audit log in monthly NDJSON files, indexed in SQLite (SR-015; OBS-002 persistence). */
/** All stores over one database + data root. */
export function createStores(sql: SqlPort, root: string) {
  return {
    prContexts: new SqlitePrContextStore(sql),
    profiles: new SqliteProfileStore(sql),
    inventories: new SqliteInventoryStore(sql),
    plans: new SqlitePlanStore(sql, root),
    requirements: new SqliteRequirementStore(sql),
    decisions: new SqliteDecisionStore(sql),
    approvals: new SqliteApprovalStore(sql, root),
    authorizations: new SqliteAuthorizationStore(sql),
    analyses: new SqliteAnalysisStore(sql),
    reports: new SqliteReportStore(sql),
    publications: new SqlitePublicationStore(sql),
    knownFailures: new SqliteKnownFailureStore(sql),
    deviceLeases: new SqliteDeviceLeaseStore(sql),
    runs: new SqliteRunStore(sql),
    results: new SqliteResultStore(sql),
    artifacts: new SqliteArtifactIndex(sql),
    audit: new FileAuditSink(sql, root),
    idempotency: new SqliteIdempotencyStore(sql),
  };
}
