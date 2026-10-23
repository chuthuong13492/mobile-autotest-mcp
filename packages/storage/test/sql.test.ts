import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  SchemaTooNewError,
  SqliteConstraintError,
  dataRootPaths,
  migrate,
  openSqlite,
} from '@autotest/storage';
import { freshRoot } from './helpers.ts';

describe('STO-002 SQLite schema and migrations', () => {
  it('applies schema v1 with the required pragmas and file mode', () => {
    const { root, open } = freshRoot();
    const { sql } = open();
    expect(sql.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations')!.v).toBe(LATEST_SCHEMA_VERSION);
    expect(sql.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode).toBe('wal');
    expect(Object.values(sql.get<Record<string, number>>('PRAGMA busy_timeout')!)[0]).toBe(5000);
    expect(Object.values(sql.get<Record<string, number>>('PRAGMA foreign_keys')!)[0]).toBe(1);
    const tables = sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name);
    for (const t of [
      'plans',
      'approvals',
      'runs',
      'test_results',
      'artifacts',
      'audit_index',
      'coverage_decisions',
      'idempotency_keys',
    ])
      expect(tables).toContain(t);
    expect(fs.statSync(dataRootPaths(root).db).mode & 0o777).toBe(0o600);
    sql.close();
  });

  it('is idempotent and refuses a database from a newer build', () => {
    const { open } = freshRoot();
    const { sql } = open();
    expect(migrate(sql)).toBe(LATEST_SCHEMA_VERSION);
    expect(sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')!.n).toBe(1);
    sql.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', 999, 'x');
    expect(() => migrate(sql)).toThrow(SchemaTooNewError);
    sql.close();
  });

  it('rolls back failed transactions and maps constraint errors', () => {
    const sql = openSqlite(':memory:');
    sql.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    expect(() =>
      sql.transaction(() => {
        sql.run('INSERT INTO t VALUES (?)', 'a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n).toBe(0);
    sql.run('INSERT INTO t VALUES (?)', 'a');
    expect(() => sql.run('INSERT INTO t VALUES (?)', 'a')).toThrow(SqliteConstraintError);
    expect(() => sql.transaction(() => sql.transaction(() => 1))).toThrow(/nested/);
  });

  it('two connections writing concurrently lose nothing (worker threads)', async () => {
    const { root, open } = freshRoot();
    const { sql } = open();
    sql.exec('CREATE TABLE ev (id INTEGER PRIMARY KEY, src INTEGER NOT NULL, n INTEGER NOT NULL)');
    const db = dataRootPaths(root).db;
    const results = await Promise.all(
      [1, 2].map(
        (src) =>
          new Promise<number>((resolve, reject) => {
            const w = new Worker(new URL('./workers/writer.ts', import.meta.url), { workerData: { db, src, n: 500 } });
            w.once('message', resolve);
            w.once('error', reject);
          }),
      ),
    );
    expect(results).toEqual([0, 0]);
    expect(sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM ev')!.n).toBe(1000);
    expect(sql.get<{ integrity_check: string }>('PRAGMA integrity_check')!.integrity_check).toBe('ok');
    sql.close();
  });
});
