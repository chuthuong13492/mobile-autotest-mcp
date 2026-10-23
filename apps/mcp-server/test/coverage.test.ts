import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import { sampleApproval } from '@autotest/core/testing';
import { composeServer } from '@autotest/mcp-server';
import { coverageExceptionScope } from '@autotest/policy';

const quiet = { write: () => true };
const ENV = { id: 'local:test-host', kind: 'local' as const };
const sc = <T>(r: { structuredContent: Record<string, unknown> }) => r.structuredContent as T;

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-cov-')));
  const ws = path.join(base, 'ws');
  for (const f of ['example.json', 'test/widgets/badge_test.dart', 'test/widgets/hidden_test.dart']) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), '');
  }
  fs.writeFileSync(path.join(base, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const config = (extra = '') =>
    fs.writeFileSync(
      path.join(data, 'config.yaml'),
      `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${path.join(base, 'flutter')} } }\n${extra}`,
    );
  config();
  return { data, config };
}
const compose = (data: string) =>
  composeServer({
    dataRoot: data,
    env: { AUTOTEST_LOG_LEVEL: 'error' },
    stderr: quiet,
    adapters: [createExampleAdapter()],
    serverEnvironment: ENV,
  });

const BODY = '## Acceptance criteria\n- [ ] Badge shows count of new listings\n- [ ] Badge hidden when count is 0\n';
const kase = (key: string, ac: string, over: Record<string, unknown> = {}) => ({
  clientKey: key,
  title: `Case ${key}`,
  requirementRefs: [ac.split('.')[0]],
  acRefs: [ac],
  level: 'unit',
  technique: 'positive',
  priority: 'must',
  platforms: ['host'],
  steps: [`Pump ${key}`],
  expectedResults: [`Text '${key}' is visible`],
  targetPath: 'test/widgets/badge_test.dart',
  automation: 'existing_test',
  ...over,
});

async function prepare(c: Awaited<ReturnType<typeof compose>>, agentRequirements: unknown[] = []) {
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', {
      workspace: 'ws_app',
      source: 'manual',
      manual: { title: 'Badge', body: BODY, changedFiles: ['lib/widgets/badge.dart'] },
    }),
  ).prContextId;
  const profile = sc<{ projectProfileId: string }>(
    await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
  ).projectProfileId;
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: profile }),
  ).inventoryId;
  const rqs = sc<{ requirementSetId: string }>(
    await c.call('extract_requirements', { prContextId: prc, agentRequirements }),
  ).requirementSetId;
  const plan = async (draft: Record<string, unknown>, basePlanId?: string) =>
    sc<{ planId: string; planHash: string; version: number }>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs,
        inventoryId: inv,
        platformsInScope: ['host'],
        draft,
        ...(basePlanId ? { basePlanId } : {}),
      }),
    );
  return { plan };
}

type Decision = {
  coverageDecisionId: string;
  decision: string;
  current: boolean;
  gatePolicyVersion: string;
  findings: { ruleId: string; severity: string }[];
  findingsNextCursor: string | null;
  metrics: Record<string, { numerator: number; denominator: number } | null>;
  requirementStatus: { requirementId: string; status: string }[];
  nextSteps: string[];
};

describe('COV-004 validate_test_coverage', () => {
  it('fails a plan with blockers, passes a complete one, and is idempotent for identical bindings', async () => {
    const { data } = setup();
    const c = await compose(data);
    const { plan } = await prepare(c);
    const weak = await plan({ testCases: [kase('count', 'REQ-001.AC-01')] });
    const fail = sc<Decision>(await c.call('validate_test_coverage', { planId: weak.planId, planHash: weak.planHash }));
    expect(fail.decision).toBe('fail');
    expect(
      fail.findings
        .filter((f) => f.severity === 'blocker')
        .map((f) => f.ruleId)
        .sort(),
    ).toEqual(['GB-04', 'GB-05']);
    expect(fail.nextSteps[0]).toMatch(/blocker/);

    const good = await plan({
      testCases: [
        kase('count', 'REQ-001.AC-01'),
        kase('hidden', 'REQ-001.AC-02', { technique: 'regression', targetPath: 'test/widgets/hidden_test.dart' }),
      ],
    });
    const pass = sc<Decision>(await c.call('validate_test_coverage', { planId: good.planId, planHash: good.planHash }));
    expect(pass.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(pass).toMatchObject({
      decision: 'pass',
      current: true,
      metrics: {
        requirementCoverage: { numerator: 1, denominator: 1 },
        regressionCoverage: { numerator: 1, denominator: 1 },
        sourceCodeCoverage: null,
        executionCoverage: null,
      },
    });
    expect(pass.requirementStatus).toEqual([{ requirementId: 'REQ-001', status: 'eligible' }]);
    const again = sc<Decision>(
      await c.call('validate_test_coverage', { planId: good.planId, planHash: good.planHash }),
    );
    expect(again.coverageDecisionId).toBe(pass.coverageDecisionId);
    expect((await c.ports.audit.readAll()).filter((e) => e.kind === 'coverage.decision')).toHaveLength(2);
    expect(await c.ports.decisions.get(pass.coverageDecisionId)).toMatchObject({
      planHash: good.planHash,
      decision: 'pass',
    });

    expect(sc(await c.call('validate_test_coverage', { planId: good.planId, planHash: weak.planHash }))).toMatchObject({
      error: { code: 'E_PLAN_HASH_MISMATCH' },
    });
    expect(
      sc(
        await c.call('validate_test_coverage', { planId: 'plan_01JC0000000000000000000000', planHash: good.planHash }),
      ),
    ).toMatchObject({ error: { code: 'E_PLAN_NOT_FOUND' } });
    expect(
      sc(
        await c.call('validate_test_coverage', {
          planId: good.planId,
          planHash: good.planHash,
          findingsCursor: 'cur_forged',
        }),
      ),
    ).toMatchObject({ error: { code: 'E_CURSOR_INVALID' } });
    await c.close();
  });

  it('a plan edit or a gate-policy change makes the old decision stale (SEC-003)', async () => {
    const { data, config } = setup();
    let c = await compose(data);
    const { plan } = await prepare(c);
    const draft = {
      testCases: [kase('count', 'REQ-001.AC-01'), kase('hidden', 'REQ-001.AC-02', { technique: 'regression' })],
    };
    const v1 = await plan(draft);
    const d1 = sc<Decision>(await c.call('validate_test_coverage', { planId: v1.planId, planHash: v1.planHash }));
    const v2 = await plan(
      { testCases: [...draft.testCases, kase('extra', 'REQ-001.AC-01', { steps: ['other'] })] },
      v1.planId,
    );
    const old = sc<Decision>(await c.call('validate_test_coverage', { planId: v1.planId, planHash: v1.planHash }));
    expect([old.coverageDecisionId, old.current]).toEqual([d1.coverageDecisionId, false]);
    expect(old.nextSteps[0]).toMatch(/newer plan version/);
    const d2 = sc<Decision>(await c.call('validate_test_coverage', { planId: v2.planId, planHash: v2.planHash }));
    expect(d2.coverageDecisionId).not.toBe(d1.coverageDecisionId);
    await c.close();

    config('coverageGate: { thresholds: { platformCoverageMin: 0.5 } }\n');
    c = await compose(data);
    const d3 = sc<Decision>(await c.call('validate_test_coverage', { planId: v2.planId, planHash: v2.planHash }));
    expect(d3.coverageDecisionId).not.toBe(d2.coverageDecisionId);
    expect(d3.gatePolicyVersion).not.toBe(d2.gatePolicyVersion);
    await c.close();
  });

  it('an exception counts only with a matching human approval', async () => {
    const { data } = setup();
    const c = await compose(data);
    const { plan } = await prepare(c, [
      {
        title: 'Server computes the count',
        statement: 'The backend computes the new-listing count',
        kind: 'functional',
        testable: true,
        platforms: [],
        riskFactors: {
          functionalImpact: 2,
          securityPrivacyImpact: 1,
          dataIntegrityImpact: 1,
          criticalJourney: false,
          regressionLikelihood: 1,
          changeSurface: 1,
          uncertainty: 1,
        },
        acceptanceCriteria: [{ text: 'Count equals the backend value', format: 'freeform' }],
      },
    ]);
    const exception = {
      requirementRefs: ['REQ-002'],
      reason: 'not_testable',
      rationale: 'Server-side only change, verified by the backend suite',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    const p = await plan({
      testCases: [kase('count', 'REQ-001.AC-01'), kase('hidden', 'REQ-001.AC-02', { technique: 'regression' })],
      exceptions: [exception],
    });
    const before = sc<Decision>(await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash }));
    expect(before.findings.map((f) => f.ruleId)).toEqual(expect.arrayContaining(['GB-01', 'GB-02']));

    const stored = (await c.ports.plans.getByHash(p.planHash))!;
    const scope = coverageExceptionScope({ planHash: p.planHash, exception: stored.exceptions[0]! });
    if (!c.policy.ok) throw new Error('policy');
    await c.ports.approvals.putApproval(
      sampleApproval({
        scope,
        planHash: p.planHash as never,
        environment: ENV.id,
        policyVersion: c.policy.policy.policyVersion as never,
        source: 'cli',
        assuranceLevel: 'AL2',
      }),
    );
    const after = sc<Decision>(await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash }));
    expect(after.coverageDecisionId).not.toBe(before.coverageDecisionId);
    expect(after.findings.map((f) => f.ruleId)).not.toEqual(expect.arrayContaining(['GB-02']));
    expect(after.findings.map((f) => f.ruleId)).not.toContain('GB-01');
    expect(after.requirementStatus).toEqual(expect.arrayContaining([{ requirementId: 'REQ-002', status: 'excepted' }]));
    // The latest decision for the bindings is the one authorization will read.
    expect(
      (
        await c.ports.decisions.findCurrent({
          planHash: p.planHash,
          requirementSetHash: stored.requirementSetHash,
          gatePolicyVersion: after.gatePolicyVersion,
        })
      )?.id,
    ).toBe(after.coverageDecisionId);
    // An approval for another plan hash, environment or policy version would not count (verified in AUTH-002 tests).
    await c.close();
  });

  it('pages a long findings list with cursors and loses nothing', async () => {
    const { data } = setup();
    const c = await compose(data);
    const { plan } = await prepare(c);
    const cases = Array.from({ length: 120 }, (_, i) =>
      kase(`k${i}`, 'REQ-001.AC-01', { expectedResults: ['It works properly'], steps: [`step ${i}`] }),
    );
    const p = await plan({ testCases: cases });
    const first = sc<Decision>(await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash }));
    const all = [...first.findings];
    let cursor = first.findingsNextCursor;
    while (cursor) {
      const next = sc<Decision>(
        await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash, findingsCursor: cursor }),
      );
      all.push(...next.findings);
      cursor = next.findingsNextCursor;
    }
    const stored = (await c.ports.decisions.get(first.coverageDecisionId))!;
    expect(all).toEqual(stored.findings);
    expect(all.filter((f) => f.ruleId === 'GR-02')).toHaveLength(120);
    await c.close();
  });
});
