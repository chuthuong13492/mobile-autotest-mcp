/**
 * Startup reconciliation between the data root and the SQLite index (STO-004; ADR-0008; data model §Consistency).
 *
 * - stray `*.tmp-*` files from interrupted atomic writes are deleted;
 * - a plan row whose snapshot is missing or modified is reported (reads already fail closed with `integrity`);
 * - a plan snapshot without a row is indexed only if it parses and its recomputed hash matches; otherwise it is
 *   moved to quarantine/;
 * - an approval file without a row is quarantined — never auto-indexed, because an unindexed approval file could
 *   be forged by any same-user process (T-15); an approval row whose file is missing/modified is reported;
 * - an artifact row whose file is missing is marked `status = 'missing'`.
 * Idempotent: a second run repairs nothing further; only unrepairable integrity findings (missing/modified plan
 * snapshots, approval file mismatches) are reported again. Every action is audited when a sink is given.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TestPlan, canonicalize, verifyPlanHash, type AuditSink } from '@autotest/core';
import { TMP_SUFFIX, dataRootPaths, sha256OfFile, sha256OfText } from './fs.ts';
import type { SqlPort } from './sql.ts';

export type ReconcileActionKind =
  | 'tmp_removed'
  | 'plan_snapshot_missing'
  | 'plan_snapshot_modified'
  | 'plan_indexed'
  | 'plan_quarantined'
  | 'approval_file_quarantined'
  | 'approval_integrity'
  | 'artifact_missing';

export interface ReconcileAction {
  readonly kind: ReconcileActionKind;
  readonly subject: string;
}

export interface ReconcileOptions {
  readonly audit?: AuditSink;
  readonly now?: () => Date;
}

export async function reconcileStorage(
  sql: SqlPort,
  root: string,
  options: ReconcileOptions = {},
): Promise<ReconcileAction[]> {
  const paths = dataRootPaths(root);
  const actions: ReconcileAction[] = [];
  const act = (kind: ReconcileActionKind, subject: string) => actions.push({ kind, subject });

  // 1. Interrupted atomic writes.
  for (const file of walk(root)) {
    if (TMP_SUFFIX.test(file)) {
      fs.rmSync(file, { force: true });
      act('tmp_removed', path.relative(root, file));
    }
  }

  // 2. Plan rows ↔ snapshots.
  const planRows = sql.all<{ id: string; version: number; snapshot_path: string; snapshot_sha256: string }>(
    'SELECT id, version, snapshot_path, snapshot_sha256 FROM plans',
  );
  const indexedSnapshots = new Set(planRows.map((r) => path.resolve(r.snapshot_path)));
  for (const r of planRows) {
    if (!fs.existsSync(r.snapshot_path)) act('plan_snapshot_missing', `${r.id}@${r.version}`);
    else if (sha256OfFile(r.snapshot_path) !== r.snapshot_sha256) act('plan_snapshot_modified', `${r.id}@${r.version}`);
  }
  for (const file of walk(path.join(root, 'plans')).filter((f) => f.endsWith('.json'))) {
    if (indexedSnapshots.has(path.resolve(file))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = safeParsePlan(text);
    if (
      parsed &&
      verifyPlanHash(parsed) &&
      canonicalize(parsed) === text &&
      path.resolve(paths.planSnapshot(parsed.id, parsed.planHash)) === path.resolve(file)
    ) {
      const clash = sql.get(
        'SELECT id FROM plans WHERE plan_hash = ? OR (id = ? AND version = ?)',
        parsed.planHash,
        parsed.id,
        parsed.version,
      );
      if (!clash) {
        sql.run(
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
        act('plan_indexed', `${parsed.id}@${parsed.version}`);
        continue;
      }
    }
    quarantine(file, paths.quarantine('plans', path.basename(file)));
    act('plan_quarantined', path.relative(root, file));
  }

  // 3. Approval files ↔ rows.
  const approvalRows = sql.all<{ id: string; file_sha256: string }>('SELECT id, file_sha256 FROM approvals');
  const approvalFiles = new Set(approvalRows.map((r) => path.resolve(paths.approval(r.id))));
  for (const r of approvalRows) {
    const f = paths.approval(r.id);
    if (!fs.existsSync(f) || sha256OfFile(f) !== r.file_sha256) act('approval_integrity', r.id);
  }
  for (const file of walk(path.join(root, 'approvals')).filter((f) => f.endsWith('.json'))) {
    if (approvalFiles.has(path.resolve(file))) continue;
    quarantine(file, paths.quarantine('approvals', path.basename(file)));
    act('approval_file_quarantined', path.relative(root, file));
  }

  // 4. Artifact rows whose files vanished.
  for (const a of sql.all<{ id: string; run_id: string; rel_path: string }>(
    "SELECT id, run_id, rel_path FROM artifacts WHERE status = 'present'",
  )) {
    if (!fs.existsSync(path.join(paths.runDir(a.run_id), a.rel_path))) {
      sql.run("UPDATE artifacts SET status = 'missing' WHERE id = ?", a.id);
      act('artifact_missing', a.id);
    }
  }

  if (options.audit) {
    const ts = (options.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const a of actions)
      await options.audit.append({
        ts,
        actor: 'server',
        kind: 'reconciliation.action',
        subjectRefs: [a.subject.slice(0, 64)],
        data: { action: a.kind },
      });
  }
  return actions;
}

function safeParsePlan(text: string): TestPlan | undefined {
  try {
    const r = TestPlan.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

function quarantine(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const target = fs.existsSync(to) ? `${to}.${Date.now()}` : to;
  fs.renameSync(from, target);
}

/** Recursively lists regular files without following symlinks. */
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'quarantine') out.push(...walk(p));
    } else if (e.isFile()) out.push(p);
  }
  return out;
}
