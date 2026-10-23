/**
 * Idempotency store over `idempotency_keys` (MCP-002; mcp-tool-contracts §2.5). The primary key is
 * `<tool>:<key>`; the remembered result is stored as canonical JSON in `result_ref`. Writes are first-wins inside an
 * IMMEDIATE transaction, so concurrent server instances agree on one result; an expired record is replaced.
 */
import { canonicalize, type IdempotencyRecord, type IdempotencyStore } from '@autotest/core';
import type { SqlPort } from './sql.ts';

type Row = { tool: string; key: string; request_digest: string; result_ref: string; expires_at: string };

export class SqliteIdempotencyStore implements IdempotencyStore {
  private readonly sql: SqlPort;
  constructor(sql: SqlPort) {
    this.sql = sql;
  }

  async get(tool: string, key: string, at: Date): Promise<IdempotencyRecord | undefined> {
    const row = this.sql.get<Row>(
      'SELECT tool, key, request_digest, result_ref, expires_at FROM idempotency_keys WHERE key = ?',
      `${tool}:${key}`,
    );
    return row && at.getTime() < Date.parse(row.expires_at) ? toRecord(row, key) : undefined;
  }

  async putIfAbsent(record: IdempotencyRecord, at: Date): Promise<IdempotencyRecord> {
    return this.sql.transaction(() => {
      const pk = `${record.tool}:${record.key}`;
      const row = this.sql.get<Row>(
        'SELECT tool, key, request_digest, result_ref, expires_at FROM idempotency_keys WHERE key = ?',
        pk,
      );
      if (row && at.getTime() < Date.parse(row.expires_at)) return toRecord(row, record.key);
      this.sql.run(
        'INSERT OR REPLACE INTO idempotency_keys (key, tool, request_digest, result_ref, expires_at) VALUES (?,?,?,?,?)',
        pk,
        record.tool,
        record.requestDigest,
        canonicalize(record.result),
        record.expiresAt,
      );
      return record;
    });
  }
}

function toRecord(row: Row, key: string): IdempotencyRecord {
  return {
    tool: row.tool,
    key,
    requestDigest: row.request_digest,
    result: JSON.parse(row.result_ref) as unknown,
    expiresAt: row.expires_at,
  };
}
