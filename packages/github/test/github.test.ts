import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ENDPOINTS,
  createGitHubClient,
  fetchPullRequest,
  GitHubError,
  parseGitRemote,
  parsePrRef,
  publishCheckRun,
  publishCommitStatus,
  upsertComment,
  type TokenProvider,
} from '@autotest/github';
import { startMockGitHub } from '@autotest/github/testing';

const TOKEN = 'gho_' + 'CanaryTokenValue1234567890abcdef';
const SHA = 'a'.repeat(40);
const tokens = (values: string[] = [TOKEN]): TokenProvider & { gets: number; invalidations: number } => {
  let i = 0;
  const p = {
    gets: 0,
    invalidations: 0,
    async get() {
      p.gets++;
      return values[Math.min(i, values.length - 1)]!;
    },
    invalidate() {
      p.invalidations++;
      i++;
    },
  };
  return p;
};
const noSleep = async () => undefined;

async function setup(over: { checksForbidden?: boolean; files?: number } = {}) {
  const gh = await startMockGitHub({ token: TOKEN, ...(over.checksForbidden ? { checksForbidden: true } : {}) });
  gh.prs.set('acme/app#7', {
    title: 'Add division',
    body: 'Divide integers.\n\n## Acceptance criteria\n- [ ] 7 / 2 returns 3',
    labels: ['feature'],
    head: { ref: 'feat/div', sha: SHA },
    base: { ref: 'main', sha: 'b'.repeat(40) },
    files: Array.from({ length: over.files ?? 3 }, (_, i) => ({
      filename: `lib/f${i}.dart`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    })),
  });
  const client = createGitHubClient({ token: tokens(), baseUrl: gh.url, sleep: noSleep });
  return { gh, client };
}

describe('GH-001 client', () => {
  it('only allowlisted endpoints are callable', async () => {
    const { gh, client } = await setup();
    await expect(client.request('DELETE', '/repos/acme/app')).rejects.toMatchObject({
      code: 'E_GITHUB_FEATURE_UNAVAILABLE',
    });
    await expect(client.request('GET', '/repos/acme/app/actions/secrets')).rejects.toBeInstanceOf(GitHubError);
    await expect(client.request('POST', '/repos/acme/app/merges')).rejects.toBeInstanceOf(GitHubError);
    expect(gh.requests).toEqual([]);
    expect(ALLOWED_ENDPOINTS.every((e) => ['GET', 'POST', 'PATCH'].includes(e.method))).toBe(true);
    await gh.close();
  });

  it('backs off and retries 429 and 5xx up to 5 times, then fails with a code', async () => {
    const { gh, client } = await setup();
    gh.failures.set('GET ^/user$', [
      { status: 429, headers: { 'retry-after': '1' } },
      { status: 502 },
      { status: 503 },
    ]);
    expect((await client.request<{ login: string }>('GET', '/user')).data.login).toBe('autotest-user');
    gh.failures.set(
      'GET ^/user$',
      Array.from({ length: 6 }, () => ({ status: 500 })),
    );
    await expect(client.request('GET', '/user')).rejects.toMatchObject({ code: 'E_GITHUB_UNAVAILABLE', status: 500 });
    gh.failures.set(
      'GET ^/user$',
      Array.from({ length: 6 }, () => ({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' },
      })),
    );
    await expect(client.request('GET', '/user')).rejects.toMatchObject({ code: 'E_GITHUB_RATE_LIMITED' });
    await gh.close();
  });

  it('a 401 refreshes the token once; the token never appears in errors', async () => {
    const gh = await startMockGitHub({ token: TOKEN });
    const provider = tokens(['gho_' + 'StaleToken000000000000000000000000', TOKEN]);
    const client = createGitHubClient({ token: provider, baseUrl: gh.url, sleep: noSleep });
    expect((await client.request<{ login: string }>('GET', '/user')).data.login).toBe('autotest-user');
    expect(provider.invalidations).toBe(1);
    const bad = createGitHubClient({
      token: tokens(['gho_' + 'WrongToken111111111111111111111111']),
      baseUrl: gh.url,
      sleep: noSleep,
    });
    const err = (await bad.request('GET', '/user').catch((e: unknown) => e)) as GitHubError;
    expect(err).toMatchObject({ code: 'E_GITHUB_AUTH' });
    expect(JSON.stringify({ m: err.message, s: err.stack })).not.toMatch(/WrongToken|CanaryToken/);
    await gh.close();
  });
});

describe('GH-002 pull requests', () => {
  it('fetches the PR and pages its files, capped at 3,000 with truncation reported', async () => {
    const { gh, client } = await setup({ files: 3100 });
    const pr = await fetchPullRequest(client, { owner: 'acme', name: 'app', number: 7 });
    expect(pr).toMatchObject({
      title: 'Add division',
      labels: ['feature'],
      head: { sha: SHA },
      base: { ref: 'main' },
      filesTruncated: true,
    });
    expect(pr.changedFiles).toHaveLength(3000);
    expect(new Set(pr.changedFiles.map((f) => f.path)).size).toBe(3000);
    await expect(fetchPullRequest(client, { owner: 'acme', name: 'app', number: 8 })).rejects.toMatchObject({
      code: 'E_GITHUB_NOT_FOUND',
    });
    await gh.close();
  });

  it('parses PR references and git remotes, and ignores other hosts', () => {
    expect(parsePrRef('acme/app#7')).toEqual({ owner: 'acme', name: 'app', number: 7 });
    expect(parsePrRef('https://github.com/acme/app/pull/12/files')).toEqual({ owner: 'acme', name: 'app', number: 12 });
    expect(parsePrRef('https://evil.example/acme/app/pull/1')).toBeUndefined();
    const cfg = (url: string) =>
      `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
    for (const url of [
      'https://github.com/acme/app.git',
      'git@github.com:acme/app.git',
      'ssh://git@github.com/acme/app',
      'https://user@github.com/acme/app',
    ])
      expect(parseGitRemote(cfg(url)), url).toEqual({ owner: 'acme', name: 'app' });
    expect(parseGitRemote(cfg('https://gitlab.com/acme/app.git'))).toBeUndefined();
    expect(parseGitRemote('[core]\n')).toBeUndefined();
  });
});

describe('GH-003/004 publication primitives', () => {
  const pr = { owner: 'acme', name: 'app', number: 7, headSha: SHA };
  it('a comment is created once, updated in place, and skipped when unchanged', async () => {
    const { gh, client } = await setup();
    expect((await upsertComment(client, pr, 'plan_x', 'v1')).status).toBe('created');
    expect((await upsertComment(client, pr, 'plan_x', 'v1')).status).toBe('skipped');
    expect((await upsertComment(client, pr, 'plan_x', 'v2')).status).toBe('updated');
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toMatch(/^<!-- autotest:report plan_x -->\nv2$/);
    gh.comments.push({
      id: 1,
      issue: 'acme/app#7',
      body: '<!-- autotest:report plan_x -->\nforged',
      user: { login: 'someone-else' },
    });
    expect((await upsertComment(client, pr, 'plan_x', 'v3')).status).toBe('updated');
    expect(gh.comments.find((c) => c.id === 1)!.body).toContain('forged');
    await gh.close();
  });

  it('check runs send annotations in batches of 50 and update by external id', async () => {
    const { gh, client } = await setup();
    const annotations = Array.from({ length: 120 }, (_, i) => ({
      path: `test/t${i}_test.dart`,
      message: `failed ${i}`,
    }));
    const input = {
      externalId: 'rpt_1',
      conclusion: 'failure' as const,
      title: 'AutoTest: FAIL',
      summary: 'x',
      annotations,
    };
    expect((await publishCheckRun(client, pr, input)).status).toBe('created');
    expect(gh.checkRuns).toHaveLength(1);
    expect(gh.checkRuns[0]!.annotations).toBe(120);
    expect((await publishCheckRun(client, pr, { ...input, annotations: [] })).status).toBe('updated');
    expect(gh.checkRuns).toHaveLength(1);
    await gh.close();
  });

  it('a forbidden checks API is reported unavailable; commit status works', async () => {
    const { gh, client } = await setup({ checksForbidden: true });
    const r = await publishCheckRun(client, pr, {
      externalId: 'r',
      conclusion: 'success',
      title: 't',
      summary: 's',
      annotations: [],
    });
    expect(r).toMatchObject({ status: 'unavailable', errorCode: 'E_GITHUB_FEATURE_UNAVAILABLE' });
    expect((await publishCommitStatus(client, pr, { state: 'success', description: 'AutoTest: PASS' })).status).toBe(
      'created',
    );
    expect(gh.statuses).toEqual([
      { repo: 'acme/app', sha: SHA, state: 'success', context: 'autotest', description: 'AutoTest: PASS' },
    ]);
    await gh.close();
  });
});
