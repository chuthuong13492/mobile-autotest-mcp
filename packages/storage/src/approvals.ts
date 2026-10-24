/**
 * Approval store (AUTH-001; FR-021, SR-007, SR-019; ADR-0006 §3; T-15, T-17).
 *
 * The approval JSON file (mode 0600, in `approvals/`) is authoritative; the row is an index that records the file's
 * SHA-256, so a file edited by another same-user process is detected on every read and the approval becomes
 * unusable (`PortError('integrity')`). Every state change is a read-check-write under one IMMEDIATE transaction,
 * which serializes concurrent consumers across processes: `uses` can never exceed `maxUses`.
 *
 * States follow ADR-0006: `pending → approved | denied`; `approved → expired | revoked | consumed | superseded`.
 * Expiry is lazy: `consume` persists `expired` when it finds an approval past its expiry, and `expireDue` sweeps.
 * Approval requests have no file: their canonical JSON lives in the row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Approval, ApprovalRequest, PortError, canonicalize, type ApprovalStore } from '@autotest/core';
import { atomicWriteSync, dataRootPaths, sha256OfFile, sha256OfText } from './fs.ts';
import type { SqlPort } from './sql.ts';
import { iso, parseDoc } from './util.ts';

/** `file_sha256` of an approval whose tampered record was moved to quarantine (it is never read again). */
const QUARANTINED = 'quarantined';

/** A change that must be persisted even though the operation then fails (lazy expiry). */
interface PersistThenFail {
  readonly persist: Approval;
  readonly error: PortError;
}

export class SqliteApprovalStore implements ApprovalStore {
  private readonly sql: SqlPort;
  private readonly paths: ReturnType<typeof dataRootPaths>;
  constructor(sql: SqlPort, root: string) {
    this.sql = sql;
    this.paths = dataRootPaths(root);
  }

  async putRequest(r: ApprovalRequest): Promise<void> {
    const p = ApprovalRequest.parse(r);
    this.sql.run(
      'INSERT OR REPLACE INTO approval_requests (id, scope_kind, scope_digest, required_assurance, status, created_at, expires_at, doc) VALUES (?,?,?,?,?,?,?,?)',
      p.id,
      p.scope.kind,
      p.scope.digest,
      p.requiredAssurance,
      p.status,
      p.createdAt,
      p.expiresAt,
      canonicalize(p),
    );
  }

  async getRequest(id: string): Promise<ApprovalRequest | undefined> {
    const row = this.sql.get<{ doc: string }>('SELECT doc FROM approval_requests WHERE id = ?', id);
    return row && parseDoc(ApprovalRequest, row.doc, `approval request ${id}`);
  }

  async putApproval(a: Approval): Promise<void> {
    const p = Approval.parse(a);
    this.sql.transaction(() => {
      if (this.sql.get('SELECT id FROM approvals WHERE id = ?', p.id))
        throw new PortError('conflict', `approval ${p.id} exists`);
      const text = canonicalize(p);
      atomicWriteSync(this.paths.approval(p.id), text);
      this.sql.run(
        'INSERT INTO approvals (id, request_id, scope_kind, scope_digest, plan_hash, environment, policy_version, source, assurance, state, uses, max_uses, expires_at, file_sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        p.id,
        p.requestId ?? null,
        p.scope.kind,
        p.scope.digest,
        p.planHash ?? null,
        p.environment,
        p.policyVersion,
        p.source,
        p.assuranceLevel,
        p.state,
        p.uses,
        p.maxUses,
        p.expiresAt,
        sha256OfText(text),
        p.createdAt,
      );
    });
  }

  async getApproval(id: string): Promise<Approval | undefined> {
    const row = this.sql.get<{ file_sha256: string }>(
      `SELECT file_sha256 FROM approvals WHERE id = ? AND file_sha256 != '${QUARANTINED}'`,
      id,
    );
    return row && this.readFile(id, row.file_sha256);
  }

  async listByScopeDigest(digest: string): Promise<Approval[]> {
    return this.sql
      .all<{ id: string; file_sha256: string }>(
        `SELECT id, file_sha256 FROM approvals WHERE scope_digest = ? AND file_sha256 != '${QUARANTINED}' ORDER BY created_at, id`,
        digest,
      )
      .map((r) => this.readFile(r.id, r.file_sha256));
  }

  async consume(id: string, at: Date): Promise<Approval> {
    return this.mutate(id, (a) => {
      if (a.state !== 'approved') throw new PortError('not_usable', `approval ${id} is ${a.state}`);
      if (at.getTime() >= Date.parse(a.expiresAt))
        return { persist: { ...a, state: 'expired' }, error: new PortError('not_usable', `approval ${id} expired`) };
      if (a.uses >= a.maxUses) throw new PortError('not_usable', `approval ${id} exhausted`);
      const uses = a.uses + 1;
      return { ...a, uses, state: uses >= a.maxUses ? 'consumed' : 'approved' };
    });
  }

  async revoke(id: string, by: string, at: Date): Promise<Approval> {
    return this.mutate(id, (a) => {
      if (a.state !== 'approved' && a.state !== 'pending')
        throw new PortError('not_usable', `approval ${id} is ${a.state}`);
      return { ...a, state: 'revoked', revokedAt: iso(at), revokedBy: by };
    });
  }

  async quarantine(id: string, at: Date): Promise<void> {
    this.sql.transaction(() => {
      if (!this.sql.get('SELECT id FROM approvals WHERE id = ?', id))
        throw new PortError('not_found', `approval ${id}`);
      const file = this.paths.approval(id);
      if (fs.existsSync(file)) {
        const dest = this.paths.quarantine('approvals', `${id}-${iso(at).replace(/[:]/g, '')}.json`);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.renameSync(file, dest);
      }
      this.sql.run(`UPDATE approvals SET state = 'revoked', file_sha256 = '${QUARANTINED}' WHERE id = ?`, id);
    });
  }

  async supersedeByPlanHash(planHash: string): Promise<number> {
    const ids = this.sql
      .all<{ id: string }>("SELECT id FROM approvals WHERE plan_hash = ? AND state = 'approved'", planHash)
      .map((r) => r.id);
    let n = 0;
    for (const id of ids) {
      if (this.mutate(id, (a) => (a.state === 'approved' ? { ...a, state: 'superseded' } : a)).state === 'superseded')
        n++;
    }
    return n;
  }

  async findOpenRequest(scopeDigest: string, at: Date): Promise<ApprovalRequest | undefined> {
    const row = this.sql.get<{ doc: string; id: string }>(
      "SELECT id, doc FROM approval_requests WHERE scope_digest = ? AND status = 'open' AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      scopeDigest,
      iso(at),
    );
    return row && parseDoc(ApprovalRequest, row.doc, `approval request ${row.id}`);
  }

  async listOpenRequests(at: Date, limit: number): Promise<ApprovalRequest[]> {
    return this.sql
      .all<{ doc: string; id: string }>(
        "SELECT id, doc FROM approval_requests WHERE status = 'open' AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        iso(at),
        limit,
      )
      .map((r) => parseDoc(ApprovalRequest, r.doc, `approval request ${r.id}`));
  }

  async listRecentApprovals(limit: number): Promise<Approval[]> {
    return this.sql
      .all<{ id: string; file_sha256: string }>(
        `SELECT id, file_sha256 FROM approvals WHERE file_sha256 != '${QUARANTINED}' ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .map((r) => this.readFile(r.id, r.file_sha256));
  }

  async expireDue(at: Date): Promise<{ approvals: number; requests: number }> {
    const now = iso(at);
    const due = this.sql
      .all<{ id: string }>(
        `SELECT id FROM approvals WHERE state = 'approved' AND expires_at <= ? AND file_sha256 != '${QUARANTINED}'`,
        now,
      )
      .map((r) => r.id);
    let approvals = 0;
    for (const id of due) {
      let changed: Approval;
      try {
        changed = this.mutate(id, (a) =>
          a.state === 'approved' && at.getTime() >= Date.parse(a.expiresAt) ? { ...a, state: 'expired' } : a,
        );
      } catch (e) {
        // A tampered record is unusable anyway; it must not stop the sweep (doctor and revoke handle it).
        if (e instanceof PortError && e.code === 'integrity') continue;
        throw e;
      }
      if (changed.state === 'expired') approvals++;
    }
    let requests = 0;
    for (const row of this.sql.all<{ doc: string; id: string }>(
      "SELECT id, doc FROM approval_requests WHERE status = 'open' AND expires_at <= ?",
      now,
    )) {
      const r = parseDoc(ApprovalRequest, row.doc, `approval request ${row.id}`);
      await this.putRequest({ ...r, status: 'expired' });
      requests++;
    }
    return { approvals, requests };
  }

  /**
   * Read-check-write of one approval under an IMMEDIATE transaction. File first, then row: a crash in between leaves
   * a checksum mismatch, which fails closed (integrity) and is reported by reconciliation.
   */
  private mutate(id: string, change: (a: Approval) => Approval | PersistThenFail): Approval {
    let failure: PortError | undefined;
    const result = this.sql.transaction(() => {
      const row = this.sql.get<{ file_sha256: string }>('SELECT file_sha256 FROM approvals WHERE id = ?', id);
      if (!row) throw new PortError('not_found', `approval ${id}`);
      const current = this.readFile(id, row.file_sha256);
      const outcome = change(current);
      const next = Approval.parse('persist' in outcome ? outcome.persist : outcome);
      if ('error' in outcome) failure = outcome.error;
      if (canonicalize(next) === canonicalize(current)) return current;
      const text = canonicalize(next);
      atomicWriteSync(this.paths.approval(id), text);
      this.sql.run(
        'UPDATE approvals SET state = ?, uses = ?, file_sha256 = ? WHERE id = ?',
        next.state,
        next.uses,
        sha256OfText(text),
        id,
      );
      return next;
    });
    if (failure) throw failure;
    return result;
  }

  private readFile(id: string, expectedSha: string): Approval {
    const file = this.paths.approval(id);
    if (!fs.existsSync(file) || sha256OfFile(file) !== expectedSha)
      throw new PortError('integrity', `approval ${id}: file missing or modified`);
    return parseDoc(Approval, fs.readFileSync(file, 'utf8'), `approval ${id}`);
  }
}
