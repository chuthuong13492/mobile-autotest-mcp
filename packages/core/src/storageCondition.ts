/**
 * Storage operating conditions (OPS-006): a full disk or a busy/locked database is not a bug. Tool calls that hit
 * one fail with the recoverable `E_STORAGE_UNAVAILABLE` instead of `E_INTERNAL`.
 */
/** ENOSPC/EDQUOT from the filesystem, or SQLITE_FULL / SQLITE_BUSY / SQLITE_LOCKED from SQLite. */
export function isStorageCondition(e: unknown): boolean {
  const err = e as { code?: unknown; errcode?: unknown; message?: unknown } | null;
  if (!err) return false;
  if (err.code === 'ENOSPC' || err.code === 'EDQUOT') return true;
  // node:sqlite: primary result codes SQLITE_BUSY (5), SQLITE_LOCKED (6), SQLITE_FULL (13).
  if (typeof err.errcode === 'number' && [5, 6, 13].includes(err.errcode & 0xff)) return true;
  return (
    typeof err.message === 'string' && /database or disk is full|database is locked|no space left/i.test(err.message)
  );
}
