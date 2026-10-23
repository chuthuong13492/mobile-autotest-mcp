/**
 * Workspace reader (WS-001; SR-003, SR-012, FR-008; ADR-0009; T-04).
 *
 * Read-only, bounded access to one allowlisted workspace. Every path goes through the policy path guard
 * (`checkPath`), so `..`, encoded traversal and symlink escapes are refused. Listing walks the tree without
 * following directory symlinks; a symlinked *file* is listed only when it resolves inside the root. Limits are
 * enforced and reported (`truncated`), never silently applied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkPath, nodeFsPort, type FsPort, type ResolvedWorkspace } from '@autotest/policy';
import { compileGlob, matchesAny } from './glob.ts';

/** Directories that are never listed: VCS metadata, dependency caches and build outputs. */
export const DEFAULT_EXCLUDED_DIRS = [
  '.git',
  '.dart_tool',
  'node_modules',
  'build',
  '.gradle',
  'Pods',
  '.build',
  'DerivedData',
  '.fvm',
] as const;

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
export const DEFAULT_MAX_FILES = 5000;
/** Upper bound on directory entries examined by one `list` call (keeps a hostile tree from exhausting memory/time). */
export const DEFAULT_MAX_SCANNED = 500_000;

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
  readonly code: 'E_PATH_ESCAPE' | 'E_NOT_FOUND' | 'E_VALIDATION';
  constructor(code: WorkspaceError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ReadResult {
  readonly text: string;
  /** Size of the file on disk. */
  readonly sizeBytes: number;
  readonly truncated: boolean;
  /** True when the first block contains NUL bytes; `text` is then empty. */
  readonly binary: boolean;
}

export interface ListOptions {
  readonly maxFiles?: number;
  readonly maxScanned?: number;
  readonly exclude?: readonly string[];
  /** Directory names skipped anywhere in the tree (defaults to {@link DEFAULT_EXCLUDED_DIRS}). */
  readonly excludeDirs?: readonly string[];
}

export interface ListResult {
  /** Workspace-relative POSIX paths, sorted. */
  readonly files: readonly string[];
  /** Total matching files seen (may exceed `files.length` when truncated). */
  readonly matched: number;
  readonly scanned: number;
  readonly truncated: boolean;
  /** Why the listing is incomplete: too many matches, too many entries scanned, or both. */
  readonly truncatedBy: readonly ('maxFiles' | 'maxScanned')[];
  readonly skippedSymlinks: number;
}

export interface WorkspaceReader {
  readonly id: string;
  readonly root: string;
  readText(rel: string, maxBytes?: number): ReadResult;
  exists(rel: string): boolean;
  list(globs: readonly string[], options?: ListOptions): ListResult;
}

export function createWorkspaceReader(workspace: ResolvedWorkspace, fsp: FsPort = nodeFsPort()): WorkspaceReader {
  const root = workspace.realPath;

  const resolve = (rel: string, mustExist: boolean): string => {
    const r = checkPath(fsp, root, rel, { mustExist });
    if (r.ok) return r.path;
    if (r.reason === 'not_found') throw new WorkspaceError('E_NOT_FOUND', `not found: ${rel.slice(0, 200)}`);
    throw new WorkspaceError('E_PATH_ESCAPE', `path refused (${r.reason})`);
  };

  return {
    id: workspace.id,
    root,
    readText(rel, maxBytes = DEFAULT_MAX_READ_BYTES) {
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
        throw new WorkspaceError('E_VALIDATION', 'maxBytes out of range');
      const abs = resolve(rel, true);
      // The resolved path has no symlinks left; O_NOFOLLOW closes the race where one is swapped in afterwards.
      const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw new WorkspaceError('E_VALIDATION', 'not a regular file');
        const want = Math.min(st.size, maxBytes);
        const buf = Buffer.alloc(want);
        let off = 0;
        while (off < want) {
          const n = fs.readSync(fd, buf, off, want - off, off);
          if (n === 0) break;
          off += n;
        }
        const data = buf.subarray(0, off);
        const binary = data.subarray(0, 8192).includes(0);
        return {
          text: binary ? '' : new TextDecoder('utf-8', { fatal: false }).decode(data),
          sizeBytes: st.size,
          truncated: st.size > off,
          binary,
        };
      } finally {
        fs.closeSync(fd);
      }
    },
    exists(rel) {
      try {
        return checkPath(fsp, root, rel, { mustExist: true }).ok;
      } catch {
        return false;
      }
    },
    list(globs, options = {}) {
      const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
      const maxScanned = options.maxScanned ?? DEFAULT_MAX_SCANNED;
      if (globs.length === 0 || globs.length > 50)
        throw new WorkspaceError('E_VALIDATION', 'between 1 and 50 globs required');
      let include: RegExp[];
      let exclude: RegExp[];
      try {
        include = globs.map(compileGlob);
        exclude = (options.exclude ?? []).map(compileGlob);
      } catch (e) {
        throw new WorkspaceError('E_VALIDATION', (e as Error).message);
      }
      const excludeDirs = new Set(options.excludeDirs ?? DEFAULT_EXCLUDED_DIRS);
      const files: string[] = [];
      let matched = 0;
      let scanned = 0;
      let skippedSymlinks = 0;
      let scanCapped = false;
      const stack: string[] = [''];
      while (stack.length > 0 && !scanCapped) {
        const dirRel = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dirRel ? path.join(root, dirRel) : root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (++scanned > maxScanned) {
            scanCapped = true;
            break;
          }
          const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (!excludeDirs.has(e.name)) stack.push(rel);
            continue;
          }
          if (e.isSymbolicLink()) {
            const r = checkPath(fsp, root, rel, { mustExist: true });
            if (!r.ok || !fsp.lstat(r.path)?.isFile) {
              skippedSymlinks++;
              continue;
            }
          } else if (!e.isFile()) continue;
          if (!matchesAny(rel, include) || matchesAny(rel, exclude)) continue;
          matched++;
          if (files.length < maxFiles) files.push(rel);
        }
      }
      const truncatedBy: ('maxFiles' | 'maxScanned')[] = [];
      if (matched > files.length) truncatedBy.push('maxFiles');
      if (scanCapped) truncatedBy.push('maxScanned');
      return {
        files: files.sort(),
        matched,
        scanned: Math.min(scanned, maxScanned),
        truncated: truncatedBy.length > 0,
        truncatedBy,
        skippedSymlinks,
      };
    },
  };
}
