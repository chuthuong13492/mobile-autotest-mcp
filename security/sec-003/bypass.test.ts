/**
 * SEC-003: approval and authorization cannot be bypassed (T-15, T-18; T-06 while publication is unavailable). Every
 * case goes through the real server and `run_tests`, and must be denied with its documented error and reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Approval } from '@autotest/core';
import { grantApproval } from '@autotest/workflow';
import { composeRuns, runnablePlan, sc, setupRunData } from '../../apps/mcp-server/test/runSetup.ts';

type Composed = Awaited<ReturnType<typeof composeRuns>>;
const covered = new Set<string>();
const T = (ids: string, name: string, fn: () => Promise<void>) => {
  for (const id of ids.split(',')) covered.add(id.trim());
  it(`[${ids}] ${name}`, { timeout: 90_000 }, fn);
};
const err = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string; details?: { reasons?: string[] } } }).error;

async function setup() {
  const f = setupRunData({ 'test/a_test.dart': 'pass', 'test/b_test.dart': 'pass' });
  const c = await composeRuns(f.data, { background: false });
  const plan = await runnablePlan(c, ['test/a_test.dart', 'test/b_test.dart'], { weak: true });
  expect(plan.decision).toBe('needs_review');
  return { f, c, plan };
}

async function approve(
  c: Composed,
  planId: string,
  planHash: string,
  over: { assurance?: 'AL1' | 'AL2'; targets?: string[]; environment?: string } = {},
): Promise<Approval> {
  const req = sc<{ approvalRequestId: string }>(
    await c.call('request_approval', {
      scope: { kind: 'plan_execution', planId, planHash, ...(over.targets ? { targets: over.targets } : {}) },
      justification: 'review',
      offerElicitation: false,
    }),
  );
  const request = (await c.ports.approvals.getRequest(req.approvalRequestId))!;
  if (!c.policy.ok) throw new Error('policy');
  const g = await grantApproval(c.ports, {
    request,
    source: over.assurance === 'AL1' ? 'elicitation' : 'cli',
    assurance: over.assurance ?? 'AL2',
    approver: { osUser: 'tester' },
    environment: over.environment ?? 'local:test-host',
    policyVersion: c.policy.policy.policyVersion,
    actor: 'cli',
  });
  if (!g.ok) throw new Error(g.error.error.message);
  return g.approval;
}
const run = (c: Composed, p: { planId: string; planHash: string }, extra: Record<string, unknown> = {}) =>
  c.call('run_tests', { planId: p.planId, planHash: p.planHash, ...extra });

describe('SEC-003 approval and authorization bypass', () => {
  T('T-15', 'no approval, or an approval at AL1 where AL2 is required, is denied', async () => {
    const { c, plan } = await setup();
    expect(err(await run(c, plan))?.code).toBe('E_APPROVAL_REQUIRED');
    await approve(c, plan.planId, plan.planHash, { assurance: 'AL1' });
    expect(err(await run(c, plan))).toMatchObject({ code: 'E_ASSURANCE_INSUFFICIENT' });
    await c.close();
  });

  T('T-15', 'an approval for a subset of targets does not authorize the whole plan', async () => {
    const { c, plan } = await setup();
    const stored = (await c.ports.plans.getByHash(plan.planHash))!;
    const first = stored.testCases[0]!.id;
    await approve(c, plan.planId, plan.planHash, { targets: [first] });
    expect(err(await run(c, plan))?.code).toBe('E_APPROVAL_REQUIRED');
    const ok = await run(c, plan, { targets: [first] });
    expect(ok.isError, JSON.stringify(ok.structuredContent)).toBeFalsy();
    await c.close();
  });

  T('T-15', 'expired, revoked and exhausted approvals are denied with their own codes', async () => {
    const expired = await setup();
    await approve(expired.c, expired.plan.planId, expired.plan.planHash);
    // Lazy expiry as seen from two days later (approvals for plan execution last 24 h).
    await expired.c.ports.approvals.expireDue(new Date(Date.now() + 48 * 3_600_000));
    expect(err(await run(expired.c, expired.plan))).toMatchObject({
      code: 'E_APPROVAL_EXPIRED',
      details: { reasons: ['approval_expired'] },
    });
    await expired.c.close();

    const revoked = await setup();
    const b = await approve(revoked.c, revoked.plan.planId, revoked.plan.planHash);
    await revoked.c.ports.approvals.revoke(b.id, 'tester', new Date());
    expect(err(await run(revoked.c, revoked.plan))).toMatchObject({
      code: 'E_APPROVAL_REVOKED',
      details: { reasons: ['approval_revoked'] },
    });
    await revoked.c.close();

    const exhausted = await setup();
    const d = await approve(exhausted.c, exhausted.plan.planId, exhausted.plan.planHash);
    for (let i = 0; i < d.maxUses; i++) await exhausted.c.ports.approvals.consume(d.id, new Date());
    expect(err(await run(exhausted.c, exhausted.plan))).toMatchObject({
      code: 'E_APPROVAL_EXHAUSTED',
      details: { reasons: ['approval_exhausted'] },
    });
    await exhausted.c.close();
  });

  T('T-15', 'an approval bound to another environment or an older policy version is not usable', async () => {
    const { f, c, plan } = await setup();
    await approve(c, plan.planId, plan.planHash, { environment: 'local:other-host' });
    expect(err(await run(c, plan))?.code).toMatch(/E_APPROVAL_/);
    await approve(c, plan.planId, plan.planHash);
    await c.close();
    // Any policy change is a new policy version: earlier approvals and coverage decisions go stale.
    fs.appendFileSync(
      path.join(f.data, 'config.yaml'),
      'execution: { maxRetries: 0, cancelGraceMs: 1000 }\n'.replace(
        'execution',
        'retention: { runArtifactsDays: 13 }\n#',
      ),
    );
    const c2 = await composeRuns(f.data, { background: false });
    const e = err(await run(c2, plan));
    expect(e?.code).toMatch(/E_COVERAGE_STALE|E_APPROVAL_STALE|E_APPROVAL_REQUIRED/);
    await c2.close();
  });

  T('T-15', 'a tampered approval file or a forged index row is never usable (E_STORAGE_CORRUPT)', async () => {
    const { f, c, plan } = await setup();
    const a = await approve(c, plan.planId, plan.planHash);
    const file = path.join(f.data, 'approvals', `${a.id}.json`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"maxUses":3', '"maxUses":99'));
    expect(err(await run(c, plan))?.code).toBe('E_STORAGE_CORRUPT');
    expect(err(await c.call('get_approval_status', { approvalId: a.id }))?.code).toBe('E_STORAGE_CORRUPT');
    await c.close();
  });

  T('T-15', 'a failed coverage gate cannot be approved or run', async () => {
    const f = setupRunData({ 'test/a_test.dart': 'pass' });
    const c = await composeRuns(f.data, { background: false });
    const prc = sc<{ prContextId: string }>(
      await c.call('get_pr_context', {
        workspace: 'ws_app',
        source: 'manual',
        manual: { title: 'x', body: '## Acceptance criteria\n- [ ] a shows "ok"\n' },
      }),
    );
    const prj = sc<{ projectProfileId: string }>(
      await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
    );
    const inv = sc<{ inventoryId: string }>(
      await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
    );
    const rqs = sc<{ requirementSetId: string }>(
      await c.call('extract_requirements', { prContextId: prc.prContextId }),
    );
    const plan = sc<{ planId: string; planHash: string }>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs.requirementSetId,
        inventoryId: inv.inventoryId,
        platformsInScope: ['host'],
        draft: {
          testCases: [
            {
              clientKey: 'a',
              title: 'Only positive',
              requirementRefs: ['REQ-001'],
              acRefs: ['REQ-001.AC-01'],
              level: 'unit',
              technique: 'positive',
              priority: 'must',
              platforms: ['host'],
              steps: ['run'],
              expectedResults: ["Text 'ok' is visible"],
              targetPath: 'test/a_test.dart',
              automation: 'existing_test',
            },
          ],
        },
      }),
    );
    const ids = { planId: plan.planId, planHash: plan.planHash };
    expect(sc<{ decision: string }>(await c.call('validate_test_coverage', ids)).decision).toBe('fail');
    expect(
      err(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', ...ids },
          justification: 'x',
          offerElicitation: false,
        }),
      )?.code,
    ).toBe('E_COVERAGE_FAILED');
    expect(err(await run(c, plan))?.code).toBe('E_COVERAGE_FAILED');
    await c.close();
  });

  T('T-18', 'an edited plan supersedes its approvals; a tampered plan snapshot is refused', async () => {
    const { f, c, plan } = await setup();
    await approve(c, plan.planId, plan.planHash);
    const stored = (await c.ports.plans.getByHash(plan.planHash))!;
    const inventory = (await c.ports.inventories.get(stored.inventoryId))!;
    const edited = sc<{ planHash: string }>(
      await c.call('generate_test_plan', {
        basePlanId: plan.planId,
        requirementSetId: stored.requirementSetId,
        inventoryId: stored.inventoryId,
        platformsInScope: ['host'],
        draft: {
          testCases: stored.testCases.map((tc) => ({
            clientKey: tc.clientKey!,
            title: `${tc.title}!`,
            requirementRefs: tc.requirementRefs,
            acRefs: tc.acRefs,
            level: tc.level,
            technique: tc.technique,
            priority: tc.priority,
            platforms: tc.platforms,
            steps: tc.steps,
            expectedResults: tc.expectedResults,
            targetPath: inventory.targets.find((x) => x.id === tc.targetRef)!.path,
            automation: tc.automation,
          })),
        },
      }),
    );
    expect(err(await run(c, plan))?.code).toBe('E_PLAN_HASH_MISMATCH');
    await c.call('validate_test_coverage', { planId: plan.planId, planHash: edited.planHash });
    expect(err(await run(c, { planId: plan.planId, planHash: edited.planHash }))?.code).toBe('E_APPROVAL_REQUIRED');
    // Tamper with the stored snapshot of the new version: its recomputed hash no longer matches.
    const snapDir = path.join(f.data, 'plans', plan.planId);
    const snap = fs
      .readdirSync(snapDir)
      .map((n) => path.join(snapDir, n))
      .find((p) => fs.readFileSync(p, 'utf8').includes(edited.planHash))!;
    fs.writeFileSync(snap, fs.readFileSync(snap, 'utf8').replace('"priority":"must"', '"priority":"could"'));
    const tampered = await run(c, { planId: plan.planId, planHash: edited.planHash });
    expect(tampered.isError).toBe(true);
    expect(err(tampered)?.code).toBe('E_STORAGE_CORRUPT');
    await c.close();
  });

  T('T-06', 'GitHub publication cannot be requested or performed in v0.1', async () => {
    const { c } = await setup();
    expect(
      err(
        await c.call('request_approval', {
          scope: {
            kind: 'github_publish',
            publish: { reportId: 'rpt_01JC0000000000000000000001', mechanisms: ['comment'] },
          },
          justification: 'x',
          offerElicitation: false,
        }),
      )?.code,
    ).toBe('E_CAPABILITY_UNAVAILABLE');
    expect(
      err(
        await c.call('publish_github_report', { reportId: 'rpt_01JC0000000000000000000001', mechanisms: ['comment'] }),
      )?.code,
    ).toMatch(/E_CAPABILITY_UNAVAILABLE|E_VALIDATION/);
    await c.close();
  });

  it('T-ID coverage report: every threat SEC-003 owns has a case', () => {
    const owned = ['T-06', 'T-15', 'T-18'];
    console.log(
      `SEC-003 T-ID coverage: ${owned.map((t) => `${t}:${covered.has(t) ? 'covered' : 'MISSING'}`).join(' ')}`,
    );
    expect(owned.filter((t) => !covered.has(t))).toEqual([]);
  });
});
