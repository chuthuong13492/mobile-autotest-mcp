/**
 * SqlPort over the built-in `node:sqlite` driver (STO-002; ADR-0008 driver decision, RL-033).
 * WAL mode, busy_timeout=5000, foreign keys on; the database file is chmod 0600.
 */
import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export type SqlParam = SQLInputValue;

export interface SqlPort {
  exec(sql: string): void;
  run(sql: string, ...params: SqlParam[]): { changes: number };
  get<T>(sql: string, ...params: SqlParam[]): T | undefined;
  all<T>(sql: string, ...params: SqlParam[]): T[];
  /** Runs `fn` inside BEGIN IMMEDIATE … COMMIT (ROLLBACK on throw). `fn` must be synchronous. Not re-entrant. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export class SqliteConstraintError extends Error {
  override readonly name = 'SqliteConstraintError';
}

/** Opens (creating if needed) a database with the project pragmas. */
export function openSqlite(file: string): SqlPort {
  // The busy timeout must be in force before any statement that may need a lock (journal_mode included), or a
  // connection opened while another holds the write lock fails at once with "database is locked".
  const db = new DatabaseSync(file, { timeout: 5000 });
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  if (file !== ':memory:') fs.chmodSync(file, 0o600);
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let inTx = false;
  const wrap = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      const msg = (e as Error).message ?? '';
      if (/constraint failed/i.test(msg)) throw new SqliteConstraintError(msg);
      throw e;
    }
  };

  return {
    exec: (sql) => wrap(() => db.exec(sql)),
    run: (sql, ...params) => wrap(() => ({ changes: Number(stmt(sql).run(...params).changes) })),
    get: <T>(sql: string, ...params: SqlParam[]) => wrap(() => stmt(sql).get(...params) as T | undefined),
    all: <T>(sql: string, ...params: SqlParam[]) => wrap(() => stmt(sql).all(...params) as T[]),
    transaction<T>(fn: () => T): T {
      if (inTx) throw new Error('nested transactions are not supported');
      // BEGIN may fail (SQLITE_BUSY after busy_timeout): the flag is set only once a transaction is open, so a failed
      // BEGIN leaves the connection usable (OPS-006 found a connection stuck after one busy failure).
      db.exec('BEGIN IMMEDIATE');
      inTx = true;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        // SQLite already rolled back on some errors (SQLITE_FULL, SQLITE_IOERR): never mask the original error.
        if (db.isTransaction)
          try {
            db.exec('ROLLBACK');
          } catch {
            // the original error is the one that matters
          }
        throw e;
      } finally {
        inTx = false;
      }
    },
    close: () => db.close(),
  };
}
