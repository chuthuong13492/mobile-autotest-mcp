import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approve, composeAgainst, err, HEAD, mocks, pr, reportFor, setup, TOKEN } from './githubSetup.ts';
import { sc } from './runSetup.ts';

afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});

describe('GH-002 get_pr_context GitHub mode', () => {
  it('fetches the PR through the gh credential and normalizes it like manual input', { timeout: 60_000 }, async () => {
    const { gh, c } = await setup();
    // composeRuns has no GitHub override: re-compose against the mock server.
    await c.close();
    const { composeServer } = await import('@autotest/mcp-server');
    const c2 = await composeServer({
      dataRoot: c.dataRoot,
      env: { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'test-host' },
      stderr: { write: () => true },
      github: { baseUrl: gh.url },
    });
    const out = sc<{
      source: string;
      number: number;
      title: string;
      head: { sha: string };
      changedFilesCount: number;
      changedFilesSample: { path: string; status: string }[];
      limitations: { code: string }[];
    }>(await c2.call('get_pr_context', pr));
    expect(out).toMatchObject({
      source: 'github',
      number: 7,
      title: 'Add calculator division',
      head: { sha: HEAD },
      changedFilesCount: 2,
    });
    expect(out.changedFilesSample).toContainEqual({
      path: 'test/a_test.dart',
      status: 'added',
      additions: 20,
      deletions: 0,
    });
    expect(out.limitations.map((l) => l.code)).not.toContain('repository_unverified');
    expect(gh.requests.every((r) => r.authorized)).toBe(true);
    expect(
      err(await c2.call('get_pr_context', { ...pr, github: { owner: 'other', name: 'repo', number: 7 } }))?.code,
    ).toBe('E_REPO_MISMATCH');
    expect(
      err(await c2.call('get_pr_context', { ...pr, github: { owner: 'acme', name: 'app', number: 99 } }))?.code,
    ).toBe('E_GITHUB_NOT_FOUND');
    await c2.close();
  });
});

describe('B0 GitHub Enterprise Server', () => {
  it(
    'takes the host from the workspace origin when it is configured, and pages under /api/v3',
    { timeout: 60_000 },
    async () => {
      const s = await setup({ host: 'ghe.example.com', remote: 'git@ghe.example.com:acme/app.git' });
      // More changed files than one page, so the Link header (under /api/v3) is followed.
      s.gh.prs.get('acme/app#7')!.files = Array.from({ length: 130 }, (_, i) => ({
        filename: `lib/f${i}.dart`,
        status: 'modified',
      }));
      await s.c.close();
      const c = await composeAgainst(s.gh, s.f.data);
      // No host in the request: the workspace's origin (ghe.example.com, configured) decides.
      const out = sc<{ number: number; changedFilesCount: number; limitations: { code: string }[] }>(
        await c.call('get_pr_context', pr),
      );
      expect(out).toMatchObject({ number: 7, changedFilesCount: 130 });
      expect(out.limitations.map((l) => l.code)).not.toContain('repository_unverified');
      expect(s.gh.requests.filter((r) => r.path.includes('/files')).length).toBeGreaterThan(1);
      expect(s.gh.requests.every((r) => r.authorized)).toBe(true);
      // A host that is not configured is never contacted.
      expect(
        err(await c.call('get_pr_context', { ...pr, github: { ...pr.github, host: 'ghe.other.example' } }))?.code,
      ).toBe('E_GITHUB_AUTH');
      await c.close();
    },
  );
});

describe('GH-002 failure modes', () => {
  it('no git remote is a limitation; gh missing from the allowlist is E_GITHUB_AUTH', { timeout: 60_000 }, async () => {
    const a = await setup({ remote: null });
    await a.c.close();
    const ca = await composeAgainst(a.gh, a.f.data);
    const out = sc<{ limitations: { code: string }[] }>(await ca.call('get_pr_context', pr));
    expect(out.limitations.map((l) => l.code)).toContain('repository_unverified');
    await ca.close();
    const b = await setup({ gh: false });
    await b.c.close();
    const cb = await composeAgainst(b.gh, b.f.data);
    expect(err(await cb.call('get_pr_context', pr))?.code).toBe('E_GITHUB_AUTH');
    expect(b.gh.requests).toEqual([]);
    await cb.close();
  });
});

describe('GH-005 publish_github_report', () => {
  it(
    'needs enabled publication and an approval; dry run writes nothing; publishes comment and check-run fallback once',
    { timeout: 120_000 },
    async () => {
      const s = await setup({ checksForbidden: true });
      await s.c.close();
      const c = await composeAgainst(s.gh, s.f.data);
      const prc = sc<{ prContextId: string }>(await c.call('get_pr_context', pr)).prContextId;
      const report = await reportFor(c, prc);
      expect(report.verdict).toBe('fail');
      const mechanisms = ['comment', 'check_run'];
      const dry = sc<{ dryRun: boolean; results: { status: string }[] }>(
        await c.call('publish_github_report', { reportId: report.reportId, mechanisms, dryRun: true }),
      );
      expect(dry).toMatchObject({ dryRun: true, results: [{ status: 'would_publish' }, { status: 'would_publish' }] });
      expect(s.gh.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      const denied = err(await c.call('publish_github_report', { reportId: report.reportId, mechanisms }));
      expect(denied?.code).toBe('E_APPROVAL_REQUIRED');
      expect(s.gh.comments).toEqual([]);

      const a = await approve(c, report.reportId, mechanisms);
      const first = sc<{ results: { mechanism: string; status: string; errorCode: string | null }[] }>(
        await c.call('publish_github_report', { reportId: report.reportId, mechanisms }),
      );
      expect(first.results.map((r) => [r.mechanism, r.status, r.errorCode])).toEqual([
        ['comment', 'published', null],
        ['check_run', 'failed', 'E_GITHUB_FEATURE_UNAVAILABLE'],
        ['commit_status', 'published', null],
      ]);
      expect(s.gh.comments).toHaveLength(1);
      expect(s.gh.comments[0]!.body).toMatch(/^<!-- autotest:report plan_[0-9A-Z]+ -->\n# AutoTest report: FAIL/);
      expect(s.gh.statuses).toEqual([expect.objectContaining({ sha: HEAD, state: 'failure', context: 'autotest' })]);
      expect((await c.ports.approvals.getApproval(a.id))?.state).toBe('consumed');
      expect(err(await c.call('publish_github_report', { reportId: report.reportId, mechanisms }))?.code).toBe(
        'E_APPROVAL_REQUIRED',
      );
      await approve(c, report.reportId, mechanisms);
      const again = sc<{ results: { mechanism: string; status: string }[] }>(
        await c.call('publish_github_report', { reportId: report.reportId, mechanisms }),
      );
      expect(again.results[0]).toMatchObject({ mechanism: 'comment', status: 'skipped' });
      expect(s.gh.comments).toHaveLength(1);
      const audit = (await c.ports.audit.readAll()).filter((e) => e.kind === 'github.write');
      expect(audit.map((e) => e.data['mechanism'])).toEqual(['comment', 'commit_status', 'commit_status']);
      await c.close();
      // The token never reaches the data root (logs, audit, database, run files).
      const walk = (d: string): string[] =>
        fs
          .readdirSync(d, { withFileTypes: true })
          .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const file of walk(s.f.data)) expect(fs.readFileSync(file).includes(TOKEN), file).toBe(false);
    },
  );

  it(
    'a check run with annotations when the checks API is available; disabled publication is refused',
    { timeout: 120_000 },
    async () => {
      const s = await setup();
      await s.c.close();
      const c = await composeAgainst(s.gh, s.f.data);
      const prc = sc<{ prContextId: string }>(await c.call('get_pr_context', pr)).prContextId;
      const report = await reportFor(c, prc);
      await approve(c, report.reportId, ['check_run']);
      const r = sc<{ results: { mechanism: string; status: string }[] }>(
        await c.call('publish_github_report', { reportId: report.reportId, mechanisms: ['check_run'] }),
      );
      expect(r.results).toEqual([expect.objectContaining({ mechanism: 'check_run', status: 'published' })]);
      expect(s.gh.checkRuns[0]).toMatchObject({ head_sha: HEAD, conclusion: 'failure', annotations: 1 });
      expect(s.gh.statuses).toEqual([]);
      await c.close();

      const off = await setup({ publication: false });
      await off.c.close();
      const c3 = await composeAgainst(off.gh, off.f.data);
      const prc3 = sc<{ prContextId: string }>(await c3.call('get_pr_context', pr)).prContextId;
      const rep3 = await reportFor(c3, prc3);
      expect(
        err(await c3.call('publish_github_report', { reportId: rep3.reportId, mechanisms: ['comment'] }))?.code,
      ).toBe('E_POLICY_DENIED');
      await c3.close();
    },
  );

  it('a report of a manual PR context cannot be published', { timeout: 60_000 }, async () => {
    const s = await setup();
    const prc = sc<{ prContextId: string }>(
      await s.c.call('get_pr_context', {
        workspace: 'ws_app',
        source: 'manual',
        manual: { title: 'x', body: '## Acceptance criteria\n- [ ] a shows "ok"\n- [ ] b shows "ok"\n' },
      }),
    ).prContextId;
    const report = await reportFor(s.c, prc);
    const pubErr = err(await s.c.call('publish_github_report', { reportId: report.reportId, mechanisms: ['comment'] }));
    expect(pubErr?.code, JSON.stringify(pubErr)).toBe('E_VALIDATION');
    expect(
      err(
        await s.c.call('request_approval', {
          scope: { kind: 'github_publish', publish: { reportId: report.reportId, mechanisms: ['comment'] } },
          justification: 'x',
          offerElicitation: false,
        }),
      )?.code,
    ).toBe('E_VALIDATION');
    await s.c.close();
  });
});
