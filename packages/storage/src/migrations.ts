/**
 * Forward-only schema migrations (STO-002). Schema v1 follows docs/data-model-and-artifacts.md §SQLite schema sketch,
 * with two implementation decisions recorded there:
 * - aggregates that have no snapshot file store their canonical JSON in a `doc` column (the row is the record);
 * - foreign keys are used only inside an aggregate (attempts/processes → runs). Cross-aggregate references are
 *   checked by the workflow layer, so an aggregate can be written before the record it refers to exists.
 * The data root is authoritative for plan snapshots, approvals and audit lines; their rows are an index.
 */
import type { SqlPort } from './sql.ts';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE pr_contexts (id TEXT PRIMARY KEY, source TEXT NOT NULL, host TEXT NOT NULL, owner TEXT, name TEXT, number INTEGER, head_sha TEXT, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE project_profiles (id TEXT PRIMARY KEY, workspace_realpath TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE inventories (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, complete INTEGER NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE test_targets (id TEXT NOT NULL, inventory_id TEXT NOT NULL REFERENCES inventories(id), adapter_id TEXT NOT NULL, level TEXT NOT NULL, path TEXT NOT NULL, selector TEXT, requires_host TEXT NOT NULL, requires_device TEXT NOT NULL, PRIMARY KEY (inventory_id, id));
CREATE TABLE requirement_sets (id TEXT PRIMARY KEY, pr_context_id TEXT NOT NULL, set_hash TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX requirement_sets_hash ON requirement_sets(set_hash);
CREATE TABLE plans (id TEXT NOT NULL, version INTEGER NOT NULL, plan_hash TEXT NOT NULL UNIQUE, hash_version INTEGER NOT NULL, requirement_set_id TEXT NOT NULL, risk_policy_version TEXT NOT NULL, snapshot_path TEXT NOT NULL, snapshot_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE coverage_decisions (id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, requirement_set_hash TEXT NOT NULL, gate_policy_version TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('pass','fail','needs_review')), evaluated_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX coverage_decisions_binding ON coverage_decisions(plan_hash, requirement_set_hash, gate_policy_version);
CREATE TABLE approval_requests (id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL, scope_digest TEXT NOT NULL, required_assurance TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE approvals (id TEXT PRIMARY KEY, request_id TEXT, scope_kind TEXT NOT NULL, scope_digest TEXT NOT NULL, plan_hash TEXT, environment TEXT NOT NULL, policy_version TEXT NOT NULL, source TEXT NOT NULL, assurance TEXT NOT NULL, state TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL, expires_at TEXT NOT NULL, file_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX approvals_scope ON approvals(scope_digest);
CREATE INDEX approvals_plan ON approvals(plan_hash);
CREATE TABLE authorization_decisions (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT NOT NULL, result TEXT NOT NULL, reasons TEXT NOT NULL, inputs_digest TEXT NOT NULL, evaluated_at TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, state TEXT NOT NULL, status_category TEXT NOT NULL, idempotency_key TEXT, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE UNIQUE INDEX runs_idem ON runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX runs_state ON runs(state);
CREATE TABLE run_attempts (run_id TEXT NOT NULL REFERENCES runs(id), attempt_no INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, doc TEXT NOT NULL, PRIMARY KEY (run_id, attempt_no));
CREATE TABLE managed_processes (run_id TEXT NOT NULL REFERENCES runs(id), pid INTEGER NOT NULL, pgid INTEGER NOT NULL, start_time TEXT NOT NULL, executable TEXT NOT NULL, role TEXT NOT NULL, exited INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, pid, start_time));
CREATE TABLE test_results (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL, target_id TEXT NOT NULL, outcome TEXT NOT NULL, doc TEXT NOT NULL);
CREATE INDEX test_results_run ON test_results(run_id, seq);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, rel_path TEXT NOT NULL, sha256 TEXT NOT NULL, quarantined INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'present', doc TEXT NOT NULL);
CREATE INDEX artifacts_run ON artifacts(run_id);
CREATE TABLE failure_analyses (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, result_id TEXT NOT NULL, ruleset_version TEXT NOT NULL, class TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE reports (id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, verdict TEXT NOT NULL, report_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE publications (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, mechanism TEXT NOT NULL, scope_digest TEXT NOT NULL, remote_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (scope_digest, mechanism));
CREATE TABLE known_failures (id TEXT PRIMARY KEY, target_id TEXT NOT NULL, name_pattern TEXT NOT NULL, reason TEXT NOT NULL, expires_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE device_leases (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, run_id TEXT, owned INTEGER NOT NULL, created_by_autotest INTEGER NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE audit_index (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, offset INTEGER NOT NULL, hash TEXT NOT NULL);
CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, tool TEXT NOT NULL, request_digest TEXT NOT NULL, result_ref TEXT NOT NULL, expires_at TEXT NOT NULL);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export class SchemaTooNewError extends Error {
  override readonly name = 'SchemaTooNewError';
}

/** Applies pending migrations in order, each in its own transaction. Idempotent. Returns the resulting version. */
export function migrate(sql: SqlPort, now: () => Date = () => new Date()): number {
  sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = sql.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  if (current > LATEST_SCHEMA_VERSION) {
    throw new SchemaTooNewError(`database schema v${current} is newer than this build (v${LATEST_SCHEMA_VERSION})`);
  }
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    sql.transaction(() => {
      sql.exec(m.sql);
      sql.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', m.version, now().toISOString());
    });
  }
  return LATEST_SCHEMA_VERSION;
}
