/**
 * Data root layout and crash-safe file writes (STO-001; ADR-0008; data model §On-disk layout).
 *
 * Write protocol: write to a unique temp file in the target directory (O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600) →
 * fsync → rename over the target → fsync the directory. A crash at any point leaves either the old file or the new
 * file, never a partial one; stray `*.tmp-*` files are removed by reconciliation (STO-004).
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_ROOT_DIRS = [
  'approvals',
  'audit',
  'plans',
  'inventories',
  'runs',
  'tmp',
  'logs',
  'quarantine',
] as const;

export class InsecureDataRootError extends Error {
  override readonly name = 'InsecureDataRootError';
}

/** Creates the data root (0700) and its subdirectories; refuses a root that is group/world accessible or a symlink. */
export function ensureDataRoot(root: string): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new InsecureDataRootError(`data root is not a real directory: ${root}`);
  if ((st.mode & 0o077) !== 0)
    throw new InsecureDataRootError(
      `data root must not be group/world accessible (mode ${(st.mode & 0o777).toString(8)}): ${root}`,
    );
  for (const d of DATA_ROOT_DIRS) fs.mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
}

/** File-name-safe form of a hash (`v1:sha256:…` → `v1_sha256_…`). */
const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Generated paths only — repository-provided names are never used as path segments. */
export function dataRootPaths(root: string) {
  return {
    db: path.join(root, 'autotest.db'),
    approval: (approvalId: string) => path.join(root, 'approvals', `${safe(approvalId)}.json`),
    auditFile: (yyyymm: string) => path.join(root, 'audit', `${safe(yyyymm)}.ndjson`),
    planSnapshot: (planId: string, planHash: string) =>
      path.join(root, 'plans', safe(planId), `${safe(planHash)}.json`),
    runDir: (runId: string) => path.join(root, 'runs', safe(runId)),
    runTmp: (runId: string) => path.join(root, 'tmp', safe(runId)),
    quarantine: (...parts: string[]) => path.join(root, 'quarantine', ...parts.map(safe)),
    key: (name: string) => path.join(root, 'keys', `${safe(name)}.key`),
  };
}

export const TMP_SUFFIX = /\.tmp-\d+-[0-9a-f]{12}$/;

export interface AtomicWriteOptions {
  readonly mode?: number;
  /** Test hook to simulate a crash after the temp file is durable but before rename. */
  readonly beforeRename?: () => void;
}

/** Atomically replaces `target` with `data` (see module doc). Refuses to write through a symlink. */
export function atomicWriteSync(target: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = lstatOrUndefined(target);
  if (existing?.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${target}`);

  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(tmp, flags, options.mode ?? 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  options.beforeRename?.();
  fs.renameSync(tmp, target);
  fsyncDir(dir);
}

/** Appends one line durably (audit NDJSON). Returns the byte offset at which the line starts. */
export function appendLineSync(file: string, line: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (lstatOrUndefined(file)?.isSymbolicLink()) throw new Error(`refusing to append through symlink: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const offset = fs.fstatSync(fd).size;
    fs.writeSync(fd, `${line}\n`);
    fs.fsyncSync(fd);
    return offset;
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256OfFile(file: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

export function sha256OfText(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function lstatOrUndefined(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (e) {
    // Some platforms (e.g. Windows) cannot fsync directories; durability then relies on the OS.
    if (!['EISDIR', 'EPERM', 'EINVAL', 'EBADF'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Loads a per-install secret key (`keys/<name>.key`, 32 random bytes, 0600), creating it on first use. Refuses a key
 * file that is not 0600 or is a symlink. Used for HMAC cursors (mcp-tool-contracts §2.3).
 */
export function loadOrCreateKey(root: string, name: string): Buffer {
  const file = dataRootPaths(root).key(name);
  const st = lstatOrUndefined(file);
  if (!st) {
    try {
      atomicWriteSync(file, randomBytes(32));
    } catch (e) {
      if (!lstatOrUndefined(file)) throw e;
    }
  }
  const now = fs.lstatSync(file);
  if (now.isSymbolicLink() || !now.isFile() || (now.mode & 0o077) !== 0)
    throw new InsecureDataRootError(`key file must be a private regular file: ${file}`);
  const key = fs.readFileSync(file);
  if (key.length < 32) throw new InsecureDataRootError(`key file too short: ${file}`);
  return key;
}
