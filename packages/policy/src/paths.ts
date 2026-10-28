/**
 * Path guard and workspace resolution (POL-002; SR-003, FR-003; ADR-0014; T-04).
 *
 * `checkPath` contains a candidate inside a root by comparing canonical segments, after Unicode NFC normalization
 * and realpath resolution of the deepest existing ancestor (so not-yet-created outputs can be checked too). A path
 * that is lexically inside the root but resolves outside it is a symlink escape. Comparison is case-insensitive when
 * the root's filesystem is. All filesystem access goes through {@link FsPort}.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PolicyConfig } from './config.ts';

export interface FsStat {
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly isFile: boolean;
}

/** The filesystem operations policy needs. Tests inject fakes. */
export interface FsPort {
  /** Canonical absolute path; throws an error with `code: 'ENOENT'` when the path does not exist. */
  realpath(p: string): string;
  lstat(p: string): FsStat | undefined;
  /** Whether names under `dir` compare case-insensitively (APFS default, NTFS). */
  isCaseInsensitive(dir: string): boolean;
  sha256(file: string): `sha256:${string}`;
}

/** {@link FsPort} over `node:fs`. Case sensitivity is probed once per root by looking up a case-flipped name. */
export function nodeFsPort(): FsPort {
  const caseCache = new Map<string, boolean>();
  return {
    realpath: (p) => fs.realpathSync.native(p),
    lstat: (p) => {
      try {
        const s = fs.lstatSync(p);
        return { isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(), isFile: s.isFile() };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR')
          return undefined;
        throw e;
      }
    },
    isCaseInsensitive: (dir) => {
      let v = caseCache.get(dir);
      if (v === undefined) {
        const flipped = dir.replace(/[a-zA-Z](?=[^a-zA-Z]*$)/, (c) =>
          c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
        );
        v = flipped !== dir && fs.existsSync(flipped) && fs.statSync(flipped).ino === fs.statSync(dir).ino;
        caseCache.set(dir, v);
      }
      return v;
    },
    sha256: (file) => `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`,
  };
}

export type PathDenial = 'invalid' | 'outside_root' | 'symlink_escape' | 'not_found' | 'root_unavailable';

export type PathCheck =
  | { readonly ok: true; readonly path: string; readonly exists: boolean }
  | { readonly ok: false; readonly reason: PathDenial };

export interface CheckPathOptions {
  readonly mustExist?: boolean;
}

/** Encoded separators/dots and other forms that have no business in a path we are asked to contain. */
const SUSPICIOUS = /%(2e|2f|5c|00)|\\|\0|[\r\n]/i;

/**
 * Checks that `candidate` (absolute, or relative to `root`) stays inside `root` after canonicalization.
 * `root` is canonicalized here too, so callers may pass the configured path.
 */
export function checkPath(fsp: FsPort, root: string, candidate: string, options: CheckPathOptions = {}): PathCheck {
  if (candidate.length === 0 || candidate.length > 4096 || SUSPICIOUS.test(candidate) || !path.isAbsolute(root))
    return { ok: false, reason: 'invalid' };
  let realRoot: string;
  try {
    realRoot = fsp.realpath(root).normalize('NFC');
  } catch {
    return { ok: false, reason: 'root_unavailable' };
  }
  const ci = fsp.isCaseInsensitive(realRoot);
  const lexical = path.resolve(realRoot, candidate.normalize('NFC'));
  if (!contains(realRoot, lexical, ci)) return { ok: false, reason: 'outside_root' };

  // Resolve the deepest existing ancestor; the remainder does not exist, so it cannot contain symlinks.
  const rest: string[] = [];
  let probe = lexical;
  let resolved: string | undefined;
  for (;;) {
    try {
      resolved = fsp.realpath(probe).normalize('NFC');
      break;
    } catch {
      if (probe === path.dirname(probe)) return { ok: false, reason: 'not_found' };
      rest.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
  const real = path.join(resolved, ...rest);
  if (!contains(realRoot, real, ci)) return { ok: false, reason: 'symlink_escape' };
  const exists = rest.length === 0;
  if (options.mustExist && !exists) return { ok: false, reason: 'not_found' };
  return { ok: true, path: real, exists };
}

function contains(root: string, p: string, caseInsensitive: boolean): boolean {
  const norm = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const r = norm(root).split(path.sep).filter(Boolean);
  const c = norm(p).split(path.sep).filter(Boolean);
  return c.length >= r.length && r.every((seg, i) => seg === c[i]);
}

export interface ResolvedWorkspace {
  readonly id: string;
  readonly configuredPath: string;
  readonly realPath: string;
  readonly readOnlyReference: boolean;
  readonly github?: PolicyConfig['workspaces'][number]['github'];
  /** Run options from the user config (1.3.0). */
  readonly run?: PolicyConfig['workspaces'][number]['run'];
  /** B2 (1.4.0): the Flutter executable bound to this workspace. */
  readonly flutterSdk?: string;
}

export interface WorkspaceResolution {
  readonly workspaces: readonly ResolvedWorkspace[];
  /** Configured workspaces whose path does not exist or is not a directory (reported by doctor; never matched). */
  readonly unavailable: readonly string[];
}

/** Canonicalizes every configured workspace root once, at load time. */
export function resolveWorkspaces(fsp: FsPort, workspaces: PolicyConfig['workspaces']): WorkspaceResolution {
  const ok: ResolvedWorkspace[] = [];
  const unavailable: string[] = [];
  for (const w of workspaces) {
    try {
      const realPath = fsp.realpath(w.path).normalize('NFC');
      if (!fsp.lstat(realPath)?.isDirectory) throw new Error('not a directory');
      ok.push({
        id: w.id,
        configuredPath: w.path,
        realPath,
        readOnlyReference: w.readOnlyReference,
        ...(w.github ? { github: w.github } : {}),
        ...(w.run ? { run: w.run } : {}),
        ...(w.flutterSdk ? { flutterSdk: w.flutterSdk } : {}),
      });
    } catch {
      unavailable.push(w.id);
    }
  }
  return { workspaces: ok, unavailable };
}

/** Finds a workspace by id, or by a path that canonicalizes to a listed root. */
export function findWorkspace(
  fsp: FsPort,
  resolution: WorkspaceResolution,
  ref: string,
): ResolvedWorkspace | undefined {
  const byId = resolution.workspaces.find((w) => w.id === ref);
  if (byId) return byId;
  if (!path.isAbsolute(ref) || SUSPICIOUS.test(ref)) return undefined;
  let real: string;
  try {
    real = fsp.realpath(ref).normalize('NFC');
  } catch {
    return undefined;
  }
  return resolution.workspaces.find((w) => {
    const ci = fsp.isCaseInsensitive(w.realPath);
    return ci ? w.realPath.toLowerCase() === real.toLowerCase() : w.realPath === real;
  });
}
