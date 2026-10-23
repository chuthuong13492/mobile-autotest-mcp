/**
 * Hash-chained audit log (OBS-002; FR-045, SR-015; T-19; observability §5).
 *
 * Monthly NDJSON files (`audit/YYYY-MM.ndjson`, 0600) are authoritative; `audit_index` is an index of them. One
 * chain spans all files: the first event of a month carries the previous month's last hash. Appends run inside an
 * IMMEDIATE transaction, which serializes concurrent writers (several server instances, the CLI, the supervisor
 * importer). If the index is empty while files exist (a rebuilt database), the chain head is recovered from the
 * files instead of restarting at seq 0. Event data must satisfy the audit data rules (IDs and digests only).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AuditEvent,
  assertAuditData,
  auditHash,
  canonicalize,
  createIdGenerator,
  type AuditAppend,
  type AuditSink,
} from '@autotest/core';
import { appendLineSync, dataRootPaths } from './fs.ts';
import type { SqlPort } from './sql.ts';

export class FileAuditSink implements AuditSink {
  private readonly sql: SqlPort;
  private readonly paths: ReturnType<typeof dataRootPaths>;
  private readonly ids = createIdGenerator();
  constructor(sql: SqlPort, root: string) {
    this.sql = sql;
    this.paths = dataRootPaths(root);
  }

  async append(e: AuditAppend): Promise<AuditEvent> {
    assertAuditData(e.kind, e.data);
    return this.sql.transaction(() => {
      const head =
        this.sql.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_index ORDER BY seq DESC LIMIT 1') ??
        this.headFromFiles();
      const base = { ...e, id: this.ids.newId('aud'), seq: head ? head.seq + 1 : 0, prevHash: head?.hash ?? null };
      const event = AuditEvent.parse({ ...base, hash: auditHash(base as AuditEvent) });
      const file = this.paths.auditFile(event.ts.slice(0, 7));
      const offset = appendLineSync(file, canonicalize(event));
      this.sql.run(
        'INSERT INTO audit_index (seq, id, ts, kind, file, offset, hash) VALUES (?,?,?,?,?,?,?)',
        event.seq,
        event.id,
        event.ts,
        event.kind,
        path.basename(file),
        offset,
        event.hash,
      );
      return event;
    });
  }

  /** Reads events from the authoritative files in sequence order. */
  async readAll(): Promise<AuditEvent[]> {
    return readAuditFiles(path.dirname(this.paths.auditFile('x'))).events.sort((a, b) => a.seq - b.seq);
  }

  private headFromFiles(): { seq: number; hash: string } | undefined {
    const { events } = readAuditFiles(path.dirname(this.paths.auditFile('x')));
    const last = events.reduce<AuditEvent | undefined>((m, ev) => (!m || ev.seq > m.seq ? ev : m), undefined);
    return last && { seq: last.seq, hash: last.hash };
  }
}

/** Parses every monthly file; unparsable lines are skipped here (chain verification reports them). */
function readAuditFiles(dir: string): { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  if (!fs.existsSync(dir)) return { events };
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}\.ndjson$/.test(n))
    .sort()) {
    for (const text of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!text.trim()) continue;
      try {
        events.push(AuditEvent.parse(JSON.parse(text)));
      } catch {
        // reported by verifyAuditFiles / verifyAuditChain (seq gap)
      }
    }
  }
  return { events };
}

export type AuditVerification =
  | { readonly ok: true; readonly events: number; readonly files: number }
  | {
      readonly ok: false;
      readonly file: string;
      readonly line: number;
      readonly seq: number | null;
      readonly problem: 'unparsable' | 'broken_link' | 'hash_mismatch' | 'seq_gap';
    };

/**
 * Verifies the chain from the files alone (no database), in file then line order — the order the chain was written.
 * Reports the first broken position (`autotest doctor --audit`).
 */
export function verifyAuditFiles(root: string): AuditVerification {
  const dir = path.dirname(dataRootPaths(root).auditFile('x'));
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^\d{4}-\d{2}\.ndjson$/.test(n))
        .sort()
    : [];
  let prev: string | null = null;
  let expectedSeq = 0;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      if (!text.trim()) continue;
      let ev: AuditEvent;
      try {
        ev = AuditEvent.parse(JSON.parse(text));
      } catch {
        return { ok: false, file: f, line: i + 1, seq: null, problem: 'unparsable' };
      }
      if (ev.seq !== expectedSeq) return { ok: false, file: f, line: i + 1, seq: ev.seq, problem: 'seq_gap' };
      if (ev.prevHash !== prev) return { ok: false, file: f, line: i + 1, seq: ev.seq, problem: 'broken_link' };
      if (ev.hash !== auditHash(ev)) return { ok: false, file: f, line: i + 1, seq: ev.seq, problem: 'hash_mismatch' };
      prev = ev.hash;
      expectedSeq++;
    }
  }
  return { ok: true, events: expectedSeq, files: files.length };
}
