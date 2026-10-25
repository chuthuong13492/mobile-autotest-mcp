/**
 * Copies result files a runner wrote inside the workspace into the attempt's runner directory (AND-003; the
 * `collect` entries of an ExecutionSpec). Gradle writes JUnit XML under the module's `build/` folder and has no flag to
 * put it elsewhere, so the supervisor fetches it after the process exits.
 *
 * Bounded and contained: each `dir` is re-checked inside the workspace root; the walk never follows symbolic links
 * (directories or files), descends at most {@link MAX_DEPTH} levels, and takes only regular files with the entry's
 * suffix modified since the spawn (stale results from earlier builds are ignored), at most {@link MAX_FILES} files
 * of {@link MAX_FILE_BYTES} each and {@link MAX_TOTAL_BYTES} per call. Files are read with O_NOFOLLOW and written
 * exclusively (`wx`, 0600) under flattened names, so nothing outside the runner directory can be touched.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionSpec } from '@autotest/contracts';
import { checkPath, type FsPort } from '@autotest/policy';

export const MAX_DEPTH = 6;
export const MAX_FILES = 50;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** Clock skew allowed between the spawn time and file modification times. */
const SKEW_MS = 2000;

export interface CollectRequest {
  readonly fs: FsPort;
  readonly workspaceRoot: string;
  readonly entries: NonNullable<ExecutionSpec['collect']>;
  /** Absolute `attempts/<n>/runner` directory. */
  readonly destDir: string;
  /** Spawn time (epoch ms); older files are skipped. */
  readonly sinceMs: number;
}

export interface CollectResult {
  /** Names written into `destDir`. */
  readonly files: readonly string[];
  /** True when a cap stopped the collection early. */
  readonly truncated: boolean;
}

/** Flattens a relative path into one runner-output file name (`[A-Za-z0-9._-]`, at most 100 characters). */
export function flatName(prefix: string, rel: string): string {
  const flat = rel.replace(/[^A-Za-z0-9._-]+/g, '_');
  // Long paths keep their tail, which holds the file name and its suffix.
  return `${prefix}-${flat.slice(-(99 - prefix.length))}`;
}

export function collectOutputs(req: CollectRequest): CollectResult {
  const files: string[] = [];
  let total = 0;
  let truncated = false;
  const taken = new Set<string>();

  const copy = (src: string, name: string, size: number) => {
    let unique = name;
    for (let i = 2; taken.has(unique); i++) unique = `${i}-${name}`.slice(0, 100);
    let fd: number | undefined;
    try {
      fd = fs.openSync(src, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const buf = Buffer.alloc(size);
      const n = size ? fs.readSync(fd, buf, 0, size, 0) : 0;
      fs.writeFileSync(path.join(req.destDir, unique), buf.subarray(0, n), { flag: 'wx', mode: 0o600 });
      taken.add(unique);
      files.push(unique);
      total += n;
    } catch {
      // vanished, replaced by a link, or a name clash: skip it
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };

  for (const entry of req.entries) {
    const checked = checkPath(req.fs, req.workspaceRoot, entry.dir, { mustExist: true });
    if (!checked.ok) continue;
    const root = checked.path;
    const walk = (dir: string, depth: number): void => {
      if (truncated || depth > MAX_DEPTH) return;
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (truncated) return;
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p, depth + 1);
        if (!d.isFile() || !d.name.endsWith(entry.suffix)) continue;
        let st: fs.Stats;
        try {
          st = fs.lstatSync(p);
        } catch {
          continue;
        }
        if (!st.isFile() || st.mtimeMs < req.sinceMs - SKEW_MS || st.size > MAX_FILE_BYTES) continue;
        if (files.length >= MAX_FILES || total + st.size > MAX_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        copy(p, flatName(entry.prefix, path.relative(root, p)), st.size);
      }
    };
    walk(root, 0);
  }
  return { files, truncated };
}
