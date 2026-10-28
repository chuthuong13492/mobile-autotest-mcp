/**
 * Pull request intake from GitHub (GH-002; FR-002, FR-004). Fetches the PR and its changed files (paged, capped at
 * 3,000, which is also GitHub's own limit for the files endpoint). The returned text is raw and untrusted: the
 * workflow normalizes and redacts it exactly like manual input before anything is stored.
 */
import type { GitHubClient } from './client.ts';

export interface PrRef {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

export interface FetchedPr {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: string;
  readonly draft: boolean;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly changedFiles: readonly {
    readonly path: string;
    readonly status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
    readonly additions: number;
    readonly deletions: number;
  }[];
  readonly filesTruncated: boolean;
  readonly htmlUrl: string;
}

export const MAX_PR_FILES = 3000;
const STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);

interface RawPr {
  title?: string;
  body?: string | null;
  labels?: { name?: string }[];
  state?: string;
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; sha?: string };
  changed_files?: number;
  html_url?: string;
}
interface RawFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

export async function fetchPullRequest(client: GitHubClient, pr: PrRef): Promise<FetchedPr> {
  const base = `/repos/${pr.owner}/${pr.name}/pulls/${pr.number}`;
  const { data } = await client.request<RawPr>('GET', base);
  const files = await client.paginate<RawFile>(`${base}/files`, { max: MAX_PR_FILES });
  return {
    title: data.title ?? '',
    body: data.body ?? '',
    labels: (data.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
    state: data.state ?? 'unknown',
    draft: data.draft === true,
    head: { ref: data.head?.ref ?? '', sha: data.head?.sha ?? '' },
    base: { ref: data.base?.ref ?? '', sha: data.base?.sha ?? '' },
    changedFiles: files.items
      .filter((f) => typeof f.filename === 'string')
      .map((f) => ({
        path: f.filename!,
        status: (STATUSES.has(f.status ?? '') ? f.status : 'changed') as FetchedPr['changedFiles'][number]['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
    filesTruncated: files.truncated || (data.changed_files ?? 0) > files.items.length,
    htmlUrl: data.html_url ?? '',
  };
}

/** The URL of a remote in git's config text (`[remote "origin"] url = …`). */
function remoteUrl(configText: string, remote: string): string | undefined {
  const section = new RegExp(`\\[remote\\s+"${remote}"\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`).exec(configText)?.[1];
  return /^\s*url\s*=\s*(\S+)\s*$/m.exec(section ?? '')?.[1];
}

/**
 * The host of a remote in git's config text, for https, ssh and scp-form URLs (B0: the GitHub host of a workspace,
 * e.g. a GitHub Enterprise Server). Lower-case; undefined when the remote is missing or not one of those forms.
 */
export function gitRemoteHost(configText: string, remote = 'origin'): string | undefined {
  const url = remoteUrl(configText, remote);
  if (!url) return undefined;
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/[^@/]+@)([A-Za-z0-9.-]{1,253})(?::\d+)?\/|^[^@/:]+@([A-Za-z0-9.-]{1,253}):/.exec(
      url,
    );
  return (m?.[1] ?? m?.[2])?.toLowerCase();
}

/**
 * The GitHub `owner/name` of a remote in git's config text (`[remote "origin"] url = …`), for URLs on `host`
 * (github.com or a GitHub Enterprise host) in https, ssh or scp form. Returns undefined when the remote is missing
 * or not on `host`.
 */
export function parseGitRemote(
  configText: string,
  host = 'github.com',
  remote = 'origin',
): { owner: string; name: string } | undefined {
  const url = remoteUrl(configText, remote);
  if (!url) return undefined;
  const h = host.replace(/\./g, '\\.');
  const m = new RegExp(
    `^(?:https?://(?:[^@/]+@)?${h}/|ssh://git@${h}(?::\\d+)?/|git@${h}:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?$`,
  ).exec(url);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

/**
 * `owner/name#123` or a PR URL on one of `hosts` (github.com by default; B0: the configured GitHub Enterprise hosts
 * too). A URL also returns its host; the short form leaves the host to the caller.
 */
export function parsePrRef(
  text: string,
  hosts: string | readonly string[] = 'github.com',
): (PrRef & { readonly host?: string }) | undefined {
  const t = text.trim();
  const short = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,9})$/.exec(t);
  if (short) return { owner: short[1]!, name: short[2]!, number: Number(short[3]) };
  for (const host of typeof hosts === 'string' ? [hosts] : hosts) {
    const url = new RegExp(
      `^https://${host.replace(/\./g, '\\.')}/([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})/pull/(\\d{1,9})(?:[/?#].*)?$`,
      'i',
    ).exec(t);
    if (url) return { owner: url[1]!, name: url[2]!, number: Number(url[3]), host };
  }
  return undefined;
}
