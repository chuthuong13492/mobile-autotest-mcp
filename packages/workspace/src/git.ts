/**
 * Read-only git metadata (WS-001). Reads `.git/HEAD`, the ref it names (loose or packed) and the remotes in
 * `.git/config`. Never runs git, never touches the network, never reads outside the workspace: a `.git` *file*
 * (worktree or submodule) whose `gitdir` points outside the root yields no metadata. Credentials in remote URLs are
 * stripped.
 */
import { checkPath, nodeFsPort, type FsPort } from '@autotest/policy';
import type { WorkspaceReader } from './reader.ts';

export interface GitInfo {
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
  /** Why some metadata is missing, e.g. `gitdir_outside_root`, `ref_unresolved`. */
  readonly limitations: readonly string[];
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SMALL = 64 * 1024;

/** Strips `user:pass@` and `user@` from URL-style remotes; scp-style `git@host:path` keeps its (non-secret) user. */
export function stripUrlCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

export function readGitInfo(reader: WorkspaceReader, fsp: FsPort = nodeFsPort()): GitInfo | null {
  const limitations: string[] = [];
  let gitDir = '.git';
  const dotGit = checkPath(fsp, reader.root, '.git', { mustExist: true });
  if (!dotGit.ok) return null;
  if (fsp.lstat(dotGit.path)?.isFile) {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(reader.readText('.git', SMALL).text);
    const target = m?.[1]?.trim();
    const inside = target ? checkPath(fsp, reader.root, target, { mustExist: true }) : undefined;
    if (!inside?.ok)
      return { headSha: null, branch: null, detached: false, remotes: [], limitations: ['gitdir_outside_root'] };
    gitDir = inside.path.slice(reader.root.length + 1);
  }
  const read = (rel: string): string | undefined => {
    try {
      const r = reader.readText(`${gitDir}/${rel}`, SMALL);
      return r.binary ? undefined : r.text;
    } catch {
      return undefined;
    }
  };

  const head = read('HEAD')?.trim();
  if (!head) return null;
  let headSha: string | null = null;
  let branch: string | null = null;
  let detached = false;
  const ref = /^ref:\s*(refs\/[A-Za-z0-9._/-]{1,200})$/.exec(head)?.[1];
  if (ref && !ref.split('/').includes('..')) {
    branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    const loose = read(ref)?.trim();
    headSha = loose && SHA.test(loose) ? loose : packedRef(read('packed-refs'), ref);
    if (!headSha) limitations.push('ref_unresolved');
  } else if (SHA.test(head)) {
    headSha = head;
    detached = true;
  } else limitations.push('head_unrecognized');

  return { headSha, branch, detached, remotes: parseRemotes(read('config') ?? ''), limitations };
}

function packedRef(text: string | undefined, ref: string): string | null {
  for (const line of (text ?? '').split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return null;
}

function parseRemotes(config: string): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  let current: string | null = null;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    const section = /^\[remote\s+"([^"]{1,100})"\]$/.exec(line);
    if (section) {
      current = section[1]!;
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    const url = /^url\s*=\s*(.{1,1000})$/.exec(line)?.[1];
    if (current && url) out.push({ name: current, url: stripUrlCredentials(url.trim()) });
  }
  return out.slice(0, 20);
}
