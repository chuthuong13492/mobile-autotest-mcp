/**
 * Publication primitives (GH-003, GH-004; ADR-0013). Only called by the publish use case after P3 authorization.
 *
 * - Comment: one comment per plan, found by a hidden marker among the comments written by the authenticated
 *   identity; created once, then updated in place; identical content is `skipped`.
 * - Check run: `AutoTest` on the PR head with annotations in batches of 50 (the API limit per request). A 403/422
 *   from the checks API (a `gh` user token cannot create check runs; GitHub reserves them for Apps and Actions)
 *   is reported as `unavailable`, never hidden.
 * - Commit status: `autotest` context on the head SHA (the fallback when check runs are unavailable).
 */
import { GitHubError, type GitHubClient } from './client.ts';

export type PublishOutcome = 'created' | 'updated' | 'skipped' | 'unavailable' | 'failed';

export interface PublishResult {
  readonly status: PublishOutcome;
  readonly remoteId: string | null;
  readonly url: string | null;
  readonly errorCode: string | null;
  readonly detail?: string;
}

export interface PrTarget {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly headSha: string;
}

export const commentMarker = (key: string) => `<!-- autotest:report ${key.replace(/[^A-Za-z0-9_-]/g, '')} -->`;
export const ANNOTATIONS_PER_REQUEST = 50;
export const CHECK_SUMMARY_MAX = 60_000;

const fail = (e: unknown): PublishResult => ({
  status: 'failed',
  remoteId: null,
  url: null,
  errorCode: e instanceof GitHubError ? e.code : 'E_GITHUB_UNAVAILABLE',
  detail: e instanceof Error ? e.message.slice(0, 300) : 'unknown error',
});

export async function upsertComment(
  client: GitHubClient,
  pr: PrTarget,
  key: string,
  body: string,
): Promise<PublishResult> {
  try {
    const marker = commentMarker(key);
    const full = `${marker}\n${body}`;
    const me = (await client.request<{ login?: string }>('GET', '/user')).data.login;
    const { items } = await client.paginate<{
      id: number;
      body?: string;
      user?: { login?: string };
      html_url?: string;
    }>(`/repos/${pr.owner}/${pr.name}/issues/${pr.number}/comments`, { max: 3000 });
    const mine = items.find((c) => c.user?.login === me && (c.body ?? '').startsWith(marker));
    if (mine) {
      if (mine.body === full)
        return { status: 'skipped', remoteId: String(mine.id), url: mine.html_url ?? null, errorCode: null };
      const r = await client.request<{ id: number; html_url?: string }>(
        'PATCH',
        `/repos/${pr.owner}/${pr.name}/issues/comments/${mine.id}`,
        { body: { body: full } },
      );
      return { status: 'updated', remoteId: String(r.data.id), url: r.data.html_url ?? null, errorCode: null };
    }
    const r = await client.request<{ id: number; html_url?: string }>(
      'POST',
      `/repos/${pr.owner}/${pr.name}/issues/${pr.number}/comments`,
      { body: { body: full } },
    );
    return { status: 'created', remoteId: String(r.data.id), url: r.data.html_url ?? null, errorCode: null };
  } catch (e) {
    return fail(e);
  }
}

export interface CheckRunInput {
  readonly externalId: string;
  readonly conclusion: 'success' | 'failure' | 'neutral' | 'action_required';
  readonly title: string;
  readonly summary: string;
  readonly annotations: readonly {
    readonly path: string;
    readonly message: string;
    readonly title?: string;
  }[];
}

export async function publishCheckRun(
  client: GitHubClient,
  pr: PrTarget,
  input: CheckRunInput,
): Promise<PublishResult> {
  const output = (batch: CheckRunInput['annotations']) => ({
    title: input.title.slice(0, 255),
    summary: input.summary.slice(0, CHECK_SUMMARY_MAX),
    annotations: batch.map((a) => ({
      path: a.path,
      start_line: 1,
      end_line: 1,
      annotation_level: 'failure',
      message: a.message.slice(0, 64_000),
      ...(a.title ? { title: a.title.slice(0, 255) } : {}),
    })),
  });
  const batches: CheckRunInput['annotations'][] = [];
  for (let i = 0; i < input.annotations.length; i += ANNOTATIONS_PER_REQUEST)
    batches.push(input.annotations.slice(i, i + ANNOTATIONS_PER_REQUEST));
  try {
    const existing = await client.request<{ check_runs?: { id: number; external_id?: string; html_url?: string }[] }>(
      'GET',
      `/repos/${pr.owner}/${pr.name}/commits/${pr.headSha}/check-runs`,
      { query: { check_name: 'AutoTest' } },
    );
    const prior = existing.data.check_runs?.find((c) => c.external_id === input.externalId);
    const first = {
      name: 'AutoTest',
      head_sha: pr.headSha,
      external_id: input.externalId,
      status: 'completed',
      conclusion: input.conclusion,
      output: output(batches[0] ?? []),
    };
    const r = prior
      ? await client.request<{ id: number; html_url?: string }>(
          'PATCH',
          `/repos/${pr.owner}/${pr.name}/check-runs/${prior.id}`,
          { body: first },
        )
      : await client.request<{ id: number; html_url?: string }>('POST', `/repos/${pr.owner}/${pr.name}/check-runs`, {
          body: first,
        });
    for (const batch of batches.slice(1))
      await client.request('PATCH', `/repos/${pr.owner}/${pr.name}/check-runs/${r.data.id}`, {
        body: { output: output(batch) },
      });
    return {
      status: prior ? 'updated' : 'created',
      remoteId: String(r.data.id),
      url: r.data.html_url ?? null,
      errorCode: null,
    };
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 422 || e.status === 404))
      return {
        status: 'unavailable',
        remoteId: null,
        url: null,
        errorCode: 'E_GITHUB_FEATURE_UNAVAILABLE',
        detail: 'check runs need a GitHub App or Actions token; a gh user token cannot create them',
      };
    return fail(e);
  }
}

export async function publishCommitStatus(
  client: GitHubClient,
  pr: PrTarget,
  input: { readonly state: 'success' | 'failure' | 'error' | 'pending'; readonly description: string },
): Promise<PublishResult> {
  try {
    const r = await client.request<{ id: number; url?: string }>(
      'POST',
      `/repos/${pr.owner}/${pr.name}/statuses/${pr.headSha}`,
      {
        body: { state: input.state, context: 'autotest', description: input.description.slice(0, 140) },
      },
    );
    return { status: 'created', remoteId: String(r.data.id), url: null, errorCode: null };
  } catch (e) {
    return fail(e);
  }
}
