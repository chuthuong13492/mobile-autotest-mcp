/** Shared GitHub test setup: mock GitHub, a fake `gh`, a workspace whose origin is acme/app, and helpers. */
import fs from 'node:fs';
import path from 'node:path';
import { startMockGitHub, type MockGitHub } from '@autotest/github/testing';
import { composeServer } from '@autotest/mcp-server';
import { grantApproval } from '@autotest/workflow';
import { composeRuns, sc, setupRunData, waitTerminal } from './runSetup.ts';

export const TOKEN = 'gho_' + 'CanaryGhToken0123456789abcdefABCDEF';
export const HEAD = 'c'.repeat(40);
export type Composed = Awaited<ReturnType<typeof composeRuns>>;
export const err = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string; details?: Record<string, unknown> } }).error;
export const mocks: MockGitHub[] = [];

export async function setup(
  o: {
    publication?: boolean;
    checksForbidden?: boolean;
    gh?: boolean;
    remote?: string | null;
    /** B0: a GitHub Enterprise host: configured in github.hosts, served under /api/v3, the only host gh logs in to. */
    host?: string;
  } = {},
) {
  const host = o.host ?? 'github.com';
  const gh = await startMockGitHub({
    token: TOKEN,
    ...(o.checksForbidden ? { checksForbidden: true } : {}),
    ...(o.host ? { prefix: '/api/v3' } : {}),
  });
  mocks.push(gh);
  gh.prs.set('acme/app#7', {
    title: 'Add calculator division',
    body: '## Acceptance criteria\n- [ ] Given 7 and 2, divide returns 3\n- [ ] Dividing by zero shows "error"\n',
    labels: ['feature'],
    head: { ref: 'feat/div', sha: HEAD },
    base: { ref: 'main', sha: 'd'.repeat(40) },
    files: [
      { filename: 'lib/a.dart', status: 'modified', additions: 10, deletions: 2 },
      { filename: 'test/a_test.dart', status: 'added', additions: 20, deletions: 0 },
    ],
  });
  const f = setupRunData(
    { 'test/a_test.dart': 'pass', 'test/b_test.dart': 'fail' },
    {
      extraConfig: `github: { ${
        o.host ? `hosts: [{ host: github.com }, { host: ${o.host}, apiBaseUrl: "https://${o.host}/api/v3" }], ` : ''
      }${o.publication === false ? '' : 'publication: { enabled: true, mechanisms: [comment, check_run, commit_status] } '}}\n`,
    },
  );
  // A fake gh that answers only `auth token --hostname <host>` with the canary token.
  const ghBin = path.join(f.base, 'gh');
  fs.writeFileSync(
    ghBin,
    `#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname ${host}" ] && echo ${TOKEN} && exit 0\nexit 1\n`,
    { mode: 0o755 },
  );
  if (o.gh !== false) {
    const cfg = path.join(f.data, 'config.yaml');
    fs.writeFileSync(
      cfg,
      fs
        .readFileSync(cfg, 'utf8')
        .replace('executables: { flutter: {', `executables: { gh: { path: ${ghBin} }, flutter: {`),
    );
  }
  if (o.remote !== null) {
    fs.mkdirSync(path.join(f.ws, '.git'));
    fs.writeFileSync(
      path.join(f.ws, '.git', 'config'),
      `[remote "origin"]\n\turl = ${o.remote ?? 'git@github.com:acme/app.git'}\n`,
    );
  }
  const c = await composeRuns(f.data);
  return { gh, f, c };
}

export async function reportFor(c: Composed, prContextId: string) {
  const prj = sc<{ projectProfileId: string }>(
    await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
  );
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
  );
  const rqs = sc<{ requirementSetId: string }>(await c.call('extract_requirements', { prContextId }));
  const kase = (k: string, ac: string, p: string, technique: string) => ({
    clientKey: k,
    title: `Case ${k}`,
    requirementRefs: ['REQ-001'],
    acRefs: [ac],
    level: 'unit',
    technique,
    priority: 'must',
    platforms: ['host'],
    steps: ['run'],
    expectedResults: ["Text 'ok' is visible"],
    targetPath: p,
    automation: 'existing_test',
  });
  const plan = sc<{ planId: string; planHash: string }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs.requirementSetId,
      inventoryId: inv.inventoryId,
      platformsInScope: ['host'],
      draft: {
        testCases: [
          kase('a', 'REQ-001.AC-01', 'test/a_test.dart', 'regression'),
          kase('b', 'REQ-001.AC-02', 'test/b_test.dart', 'error_handling'),
        ],
      },
    }),
  );
  const gate = sc(await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }));
  const started = await c.call('run_tests', {
    planId: plan.planId,
    planHash: plan.planHash,
    retry: { maxAttempts: 1 },
  });
  if (started.isError)
    throw new Error(
      `run_tests: ${JSON.stringify(started.structuredContent)} gate: ${JSON.stringify(gate).slice(0, 600)}`,
    );
  const runId = sc<{ runId: string }>(started).runId;
  await waitTerminal(c, runId);
  return sc<{ reportId: string; verdict: string }>(
    await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
  );
}

export async function approve(c: Composed, reportId: string, mechanisms: string[], assurance: 'AL1' | 'AL2' = 'AL2') {
  const req = sc<{ approvalRequestId: string }>(
    await c.call('request_approval', {
      scope: { kind: 'github_publish', publish: { reportId, mechanisms } },
      justification: 'publish',
      offerElicitation: false,
    }),
  );
  if (!c.policy.ok) throw new Error('policy');
  const g = await grantApproval(c.ports, {
    request: (await c.ports.approvals.getRequest(req.approvalRequestId))!,
    source: assurance === 'AL1' ? 'elicitation' : 'cli',
    assurance,
    approver: { osUser: 'tester' },
    environment: 'local:test-host',
    policyVersion: c.policy.policy.policyVersion,
    actor: 'cli',
  });
  if (!g.ok) throw new Error(g.error.error.message);
  return g.approval;
}

export const pr = { workspace: 'ws_app', source: 'github', github: { owner: 'acme', name: 'app', number: 7 } };

export async function composeAgainst(gh: MockGitHub, data: string) {
  return composeServer({
    dataRoot: data,
    env: { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'test-host' },
    stderr: { write: () => true },
    github: { baseUrl: gh.url },
  });
}
