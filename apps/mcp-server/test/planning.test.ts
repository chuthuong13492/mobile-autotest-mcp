import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import { sampleApproval } from '@autotest/core/testing';
import { composeServer } from '@autotest/mcp-server';

const quiet = { write: () => true };
const TOKEN = `gh${'p'}_${'aB3'.repeat(12)}`;

function setup(withConfig = true) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-pln-')));
  const mk = (ws: string) => {
    for (const f of ['example.json', 'test/widget/badge_test.dart', 'test/widget/hidden_test.dart']) {
      fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
      fs.writeFileSync(path.join(ws, f), '');
    }
  };
  const ws = path.join(base, 'ws');
  const other = path.join(base, 'other');
  mk(ws);
  mk(other);
  fs.writeFileSync(path.join(base, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  if (withConfig)
    fs.writeFileSync(
      path.join(data, 'config.yaml'),
      `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }, { id: ws_other, path: ${other} }]\nexecutables: { flutter: { path: ${path.join(base, 'flutter')} } }\n`,
    );
  return { ws, data };
}
const compose = (data: string) =>
  composeServer({
    dataRoot: data,
    env: { AUTOTEST_LOG_LEVEL: 'error' },
    stderr: quiet,
    adapters: [createExampleAdapter()],
  });
const sc = <T>(r: { structuredContent: Record<string, unknown> }) => r.structuredContent as T;

const BODY = '## Acceptance criteria\n- [ ] Badge shows count of new listings\n- [ ] Badge hidden when count is 0\n';

describe('PLN-001 get_pr_context (manual)', () => {
  it('stores redacted, control-free text, canonical changed files and pages the body', async () => {
    const { ws, data } = setup();
    const c = await compose(data);
    const body = `Intro \u0007 with token ${TOKEN}\n${'x'.repeat(40_000)}`;
    const r = sc<{
      prContextId: string;
      body: string;
      bodyNextOffset: number | null;
      changedFilesSample: { path: string }[];
      limitations: { code: string }[];
      repository: { localPath: string };
      untrustedFields: string[];
    }>(
      await c.call('get_pr_context', {
        workspace: 'ws_app',
        source: 'manual',
        manual: { title: 'Badge \u0000', body, changedFiles: ['./lib/a.dart', '../../etc/passwd', '/abs/x'] },
      }),
    );
    expect(r.body).toHaveLength(16_000);
    expect(r.bodyNextOffset).toBe(16_000);
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toContain('\u0007');
    expect(r.changedFilesSample).toEqual([{ path: 'lib/a.dart', status: 'changed' }]);
    expect(r.limitations.map((l) => l.code).sort()).toEqual([
      'changed_files_rejected',
      'control_characters_removed',
      'redacted',
    ]);
    expect(r.repository.localPath).toBe(ws);
    expect(r.untrustedFields).toEqual(expect.arrayContaining(['/title', '/body']));
    const stored = await c.ports.prContexts.get(r.prContextId);
    expect(stored?.body).not.toContain(TOKEN);
    expect(stored?.title).toBe('Badge');
    const page2 = sc<{ body: string; bodyNextOffset: number | null }>(
      await c.call('get_pr_context', { workspace: 'ws_app', source: 'manual', manual: { body }, bodyOffset: 32_000 }),
    );
    expect(page2.bodyNextOffset).toBeNull();
    await c.close();
  });

  it('maps mode, workspace and policy errors', async () => {
    const { data } = setup();
    const c = await compose(data);
    expect(
      sc(
        await c.call('get_pr_context', {
          workspace: 'ws_app',
          source: 'github',
          github: { owner: 'o', name: 'n', number: 1 },
        }),
      ),
    ).toMatchObject({ error: { code: 'E_CAPABILITY_UNAVAILABLE' } });
    expect(sc(await c.call('get_pr_context', { workspace: 'ws_app', source: 'manual' }))).toMatchObject({
      error: { code: 'E_VALIDATION' },
    });
    expect(
      sc(await c.call('get_pr_context', { workspace: 'ws_nope', source: 'manual', manual: { body: BODY } })),
    ).toMatchObject({ error: { code: 'E_WORKSPACE_NOT_ALLOWED' } });
    await c.close();
    const none = setup(false);
    const c2 = await compose(none.data);
    expect(
      sc(await c2.call('get_pr_context', { workspace: 'ws_app', source: 'manual', manual: { body: BODY } })),
    ).toMatchObject({ error: { code: 'E_POLICY_UNAVAILABLE' } });
    await c2.close();
  });
});

describe('PLN-002/003 extract_requirements and generate_test_plan', () => {
  async function prepare() {
    const { data } = setup();
    const c = await compose(data);
    const prc = sc<{ prContextId: string }>(
      await c.call('get_pr_context', {
        workspace: 'ws_app',
        source: 'manual',
        manual: { title: 'Saved search badge', body: BODY },
      }),
    ).prContextId;
    const profile = sc<{ projectProfileId: string }>(
      await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
    ).projectProfileId;
    const inv = sc<{ inventoryId: string }>(
      await c.call('inspect_test_inventory', { projectProfileId: profile }),
    ).inventoryId;
    return { c, prc, inv };
  }
  const draft = (title = 'Badge shows count') => ({
    testCases: [
      {
        clientKey: 'badge-count',
        title,
        requirementRefs: ['REQ-001'],
        acRefs: ['REQ-001.AC-01'],
        level: 'unit',
        technique: 'positive',
        priority: 'must',
        platforms: ['host'],
        steps: ['Pump badge with 3'],
        expectedResults: ["Text '3' is visible"],
        targetPath: 'test/widget/badge_test.dart',
        automation: 'existing_test',
      },
      {
        clientKey: 'badge-hidden',
        title: 'Badge hidden at zero',
        requirementRefs: ['REQ-001'],
        acRefs: ['REQ-001.AC-02'],
        level: 'manual',
        technique: 'positive',
        priority: 'should',
        platforms: ['host'],
        steps: ['Look'],
        expectedResults: ['Badge hides'],
        automation: 'manual',
      },
    ],
  });

  it('extracts an idempotent requirement set and reports errors', async () => {
    const { c, prc } = await prepare();
    const a = sc<{
      requirementSetId: string;
      requirementSetHash: string;
      requirements: { id: string; riskTier: string; acIds: string[] }[];
    }>(await c.call('extract_requirements', { prContextId: prc }));
    expect(a.requirements).toEqual([
      expect.objectContaining({ id: 'REQ-001', riskTier: 'R2', acIds: ['REQ-001.AC-01', 'REQ-001.AC-02'] }),
    ]);
    const b = sc<typeof a>(await c.call('extract_requirements', { prContextId: prc }));
    expect(b.requirementSetId).toBe(a.requirementSetId);
    expect(sc(await c.call('extract_requirements', { prContextId: 'prc_01JC0000000000000000000000' }))).toMatchObject({
      error: { code: 'E_NOT_FOUND' },
    });
    expect(
      sc(
        await c.call('extract_requirements', {
          prContextId: prc,
          agentRequirements: [
            {
              title: 'Server only',
              statement: 'Server computes the count',
              kind: 'functional',
              testable: false,
              acceptanceCriteria: [],
            },
          ],
        }),
      ),
    ).toMatchObject({
      error: { code: 'E_VALIDATION', details: { issues: [{ pointer: '/agentRequirements/0/nonTestableReason' }] } },
    });
    await c.close();
  });

  it('creates a plan, versions it with approval supersession, and reuses unchanged versions', async () => {
    const { c, prc, inv } = await prepare();
    const rqs = sc<{ requirementSetId: string }>(
      await c.call('extract_requirements', { prContextId: prc }),
    ).requirementSetId;
    const v1 = sc<{
      planId: string;
      version: number;
      planHash: string;
      testCases: { id: string; eligibility: string; targetRef: string | null }[];
      riskSummary: Record<string, number>;
      eligibilitySummary: unknown;
    }>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        platformsInScope: ['host'],
        draft: draft(),
      }),
    );
    expect(v1).toMatchObject({
      version: 1,
      riskSummary: { R0: 0, R1: 0, R2: 2, R3: 0 },
      eligibilitySummary: { eligible: 1, ineligible: { manual: 1 } },
    });
    expect(v1.testCases.map((t) => [t.id, t.eligibility])).toEqual([
      ['TC-001', 'eligible'],
      ['TC-002', 'ineligible:manual'],
    ]);
    expect(v1.testCases[0]!.targetRef).toMatch(/^TT-example-/);
    const approval = sampleApproval({ planHash: v1.planHash as `v1:sha256:${string}` });
    await c.ports.approvals.putApproval(approval);

    const again = sc<typeof v1>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        platformsInScope: ['host'],
        draft: draft(),
      }),
    );
    expect([again.planId, again.version]).toEqual([v1.planId, 1]);

    const v2 = sc<typeof v1 & { supersedes: { version: number } }>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        basePlanId: v1.planId,
        platformsInScope: ['host'],
        draft: draft('Badge shows the new count'),
      }),
    );
    expect(v2).toMatchObject({ planId: v1.planId, version: 2, supersedes: { version: 1, planHash: v1.planHash } });
    expect(v2.testCases.map((t) => t.id)).toEqual(['TC-001', 'TC-002']);
    expect((await c.ports.approvals.getApproval(approval.id))?.state).toBe('superseded');
    const reused = sc<typeof v1>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        basePlanId: v1.planId,
        platformsInScope: ['host'],
        draft: draft('Badge shows the new count'),
      }),
    );
    expect([reused.version, reused.planHash]).toEqual([2, v2.planHash]);
    const versioned = (await c.ports.audit.readAll()).filter((e) => e.kind === 'plan.versioned');
    expect(versioned.map((e) => [e.data['version'], e.data['supersededApprovals']])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    expect(
      sc(
        await c.call('generate_test_plan', {
          requirementSetId: rqs,
          inventoryId: inv,
          platformsInScope: ['host'],
          draft: { testCases: [{ ...draft().testCases[0]!, requirementRefs: ['REQ-404'] }] },
        }),
      ),
    ).toMatchObject({ error: { code: 'E_VALIDATION' } });
    await c.close();
  });

  it('refuses an inventory from another workspace (E_REPO_MISMATCH)', async () => {
    const { c, inv } = await prepare();
    const otherPrc = sc<{ prContextId: string }>(
      await c.call('get_pr_context', { workspace: 'ws_other', source: 'manual', manual: { body: BODY } }),
    ).prContextId;
    const rqs = sc<{ requirementSetId: string }>(
      await c.call('extract_requirements', { prContextId: otherPrc }),
    ).requirementSetId;
    expect(
      sc(
        await c.call('generate_test_plan', {
          requirementSetId: rqs,
          inventoryId: inv,
          platformsInScope: ['host'],
          draft: draft(),
        }),
      ),
    ).toMatchObject({ error: { code: 'E_REPO_MISMATCH' } });
    await c.close();
  });
});
