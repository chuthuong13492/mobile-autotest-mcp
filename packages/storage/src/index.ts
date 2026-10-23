/**
 * @autotest/storage — the data root (`~/.autotest`, ADR-0008), the node:sqlite index with forward-only migrations,
 * repositories implementing the core ports, and startup reconciliation.
 */
export * from './fs.ts';
export * from './sql.ts';
export * from './migrations.ts';
export * from './repos.ts';
export * from './approvals.ts';
export * from './auditSink.ts';
export * from './idempotency.ts';
export * from './reconcile.ts';

import { ensureDataRoot, dataRootPaths } from './fs.ts';
import { migrate } from './migrations.ts';
import { createStores } from './repos.ts';
import { openSqlite, type SqlPort } from './sql.ts';

/** Opens a data root: creates/permission-checks it, opens the database and applies migrations. */
export function openDataRoot(root: string): { sql: SqlPort; stores: ReturnType<typeof createStores> } {
  ensureDataRoot(root);
  const sql = openSqlite(dataRootPaths(root).db);
  migrate(sql);
  return { sql, stores: createStores(sql, root) };
}
