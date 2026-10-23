import { describe, expect, it } from 'vitest';
import { composeRuns, runnablePlan, sc, setupRunData, waitTerminal } from './runSetup.ts';

type Composed = Awaited<ReturnType<typeof composeRuns>>;
const err = (r: { structuredContent: Record<string, unknown> }) =>
  (r.structuredContent as { error?: { code: string } }).error?.code;

async function runToEnd(c: Composed, plan: { planId: string; planHash: string }) {
  const r = await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash });
  if (r.isError) throw new Error(JSON.stringify(r.structuredContent));
  const runId = sc<{ runId: string }>(r).runId;
  await waitTerminal(c, runId);
  return runId;
}

interface Evidence {
  partial: boolean;
  artifacts: {
    artifactId: string;
    kind: string;
    quarantined: boolean;
    redactionApplied: boolean;
    excerpt: string | null;
    uri: string;
  }[];
  quarantinedCount: number;
}

describe('EVD-001/002 evidence through collect_test_evidence', () => {
  it(
    'collects redacted logs, runner output and merged JUnit; results link their artifacts',
    { timeout: 60_000 },
    async () => {
      const f = setupRunData({ 'test/noisy_test.dart': 'noisy', 'test/fail_test.dart': 'fail' });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/noisy_test.dart', 'test/fail_test.dart']);
      const runId = await runToEnd(c, plan);
      const ev = sc<Evidence>(await c.call('collect_test_evidence', { runId, include: 'excerpt', excerptBytes: 8192 }));
      expect(ev.partial).toBe(false);
      const kinds = ev.artifacts.map((a) => a.kind);
      expect(kinds.filter((k) => k === 'runner_json')).toHaveLength(2);
      expect(kinds.filter((k) => k === 'stdout')).toHaveLength(2);
      expect(kinds).toContain('junit');
      const all = ev.artifacts.map((a) => a.excerpt ?? '').join('\n');
      expect(all).not.toContain('A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
      expect(all).not.toContain('hunter2-very-secret');
      expect(all).toContain('[REDACTED:');
      expect(ev.artifacts.every((a) => a.redactionApplied && !a.quarantined)).toBe(true);
      expect(ev.artifacts[0]!.uri).toBe(`autotest://runs/${runId}/artifacts/${ev.artifacts[0]!.artifactId}`);
      const junit = ev.artifacts.find((a) => a.kind === 'junit')!;
      expect(junit.excerpt).toMatch(/<testsuites[^>]*tests="\d+"/);
      const results = sc<{ results: { name: string; artifactIds: string[] }[] }>(
        await c.call('get_run_results', { runId }),
      );
      expect(results.results.every((r) => r.artifactIds.length > 0)).toBe(true);
      const meta = sc<Evidence>(await c.call('collect_test_evidence', { runId, kinds: ['stderr'] }));
      expect(meta.artifacts.every((a) => a.kind === 'stderr' && a.excerpt === null)).toBe(true);
      const audit = (await c.ports.audit.readAll()).map((e) => e.kind);
      expect(audit).toContain('artifact.ingested');
      await c.close();
    },
  );

  it('binary runner output is quarantined and never excerpted', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/bin_test.dart': 'binary' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/bin_test.dart']);
    const runId = await runToEnd(c, plan);
    const ev = sc<Evidence>(await c.call('collect_test_evidence', { runId }));
    const q = ev.artifacts.find((a) => a.quarantined)!;
    expect(q.kind).toBe('runner_json');
    expect(ev.quarantinedCount).toBe(1);
    expect(err(await c.call('collect_test_evidence', { runId, artifactIds: [q.artifactId], include: 'excerpt' }))).toBe(
      'E_ARTIFACT_QUARANTINED',
    );
    expect((await c.ports.audit.readAll()).some((e) => e.kind === 'artifact.quarantined')).toBe(true);
    await c.close();
  });
});

describe('ANL-003 analyze_test_failures', () => {
  it(
    'classifies failures and flaky passes with ruleset anl-1, persistently and idempotently',
    { timeout: 60_000 },
    async () => {
      const f = setupRunData({
        'test/fail_test.dart': 'fail',
        'test/flaky_test.dart': 'flaky',
        'test/ok_test.dart': 'pass',
      });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/fail_test.dart', 'test/flaky_test.dart', 'test/ok_test.dart']);
      const runId = await runToEnd(c, plan);
      type Out = {
        rulesetVersion: string;
        summary: Record<string, number>;
        analyses: {
          analysisId: string;
          class: string;
          subtype: string;
          strength: string;
          confidence: number;
          observations: { artifactId: string | null }[];
        }[];
      };
      const a = sc<Out>(await c.call('analyze_test_failures', { runId }));
      expect(a.rulesetVersion).toBe('anl-1');
      expect(a.summary).toEqual({ product_defect: 1, test_defect: 1 });
      const byClass = Object.fromEntries(a.analyses.map((x) => [x.class, x]));
      expect(byClass['product_defect']).toMatchObject({ subtype: 'behavior', strength: 'hypothesis', confidence: 0.6 });
      expect(byClass['test_defect']).toMatchObject({ subtype: 'flaky' });
      expect(byClass['product_defect']!.observations[0]!.artifactId).toMatch(/^art_/);
      const again = sc<Out>(await c.call('analyze_test_failures', { runId }));
      expect(again.analyses.map((x) => x.analysisId)).toEqual(a.analyses.map((x) => x.analysisId));
      await c.close();
    },
  );
});

describe('RPT-004 generate_pr_test_report', () => {
  it('fail verdict with three artifacts; the same content returns the same report', { timeout: 60_000 }, async () => {
    const f = setupRunData({ 'test/fail_test.dart': 'fail', 'test/ok_test.dart': 'pass' });
    const c = await composeRuns(f.data);
    const plan = await runnablePlan(c, ['test/fail_test.dart', 'test/ok_test.dart']);
    const runId = await runToEnd(c, plan);
    type Rep = {
      reportId: string;
      verdict: string;
      verdictRule: number;
      artifacts: { kind: string }[];
      markdownPreview: string;
      plannedVsExecuted: Record<string, number>;
    };
    const r = sc<Rep>(
      await c.call('generate_pr_test_report', {
        planId: plan.planId,
        planHash: plan.planHash,
        runIds: [runId],
        narrative: 'Ran <b>both</b> files.',
      }),
    );
    expect(r).toMatchObject({
      verdict: 'fail',
      verdictRule: 3,
      plannedVsExecuted: { planned: 2, executed: 2, notRun: 0, blocked: 0 },
    });
    expect(r.artifacts.map((a) => a.kind)).toEqual(['report', 'report', 'junit']);
    expect(r.markdownPreview).toContain('# AutoTest report: FAIL');
    expect(r.markdownPreview).toContain('&lt;b&gt;both&lt;/b&gt;');
    expect(r.markdownPreview).toMatch(/possibly \*\*product_defect\/behavior\*\*/);
    const again = sc<Rep>(
      await c.call('generate_pr_test_report', {
        planId: plan.planId,
        planHash: plan.planHash,
        runIds: [runId],
        narrative: 'Ran <b>both</b> files.',
      }),
    );
    expect(again.reportId).toBe(r.reportId);
    expect(again.artifacts).toHaveLength(3);
    expect((await c.ports.audit.readAll()).filter((e) => e.kind === 'report.generated')).toHaveLength(1);
    await c.close();
  });

  it(
    'pass verdict; blocked without runs; not ready while running; runs of another plan are refused',
    { timeout: 90_000 },
    async () => {
      const { waitRunning } = await import('./runSetup.ts');
      const f = setupRunData({
        'test/ok_test.dart': 'pass',
        'test/b_test.dart': 'pass',
        'test/slow_test.dart': 'slow',
      });
      const c = await composeRuns(f.data);
      const plan = await runnablePlan(c, ['test/ok_test.dart', 'test/b_test.dart']);
      const runId = await runToEnd(c, plan);
      const pass = sc<{ verdict: string; verdictRule: number }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
      );
      expect(pass).toMatchObject({ verdict: 'pass', verdictRule: 5 });
      const blocked = sc<{ verdict: string; verdictRule: number; artifacts: unknown[] }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash }),
      );
      expect(blocked).toMatchObject({ verdict: 'blocked', verdictRule: 1, artifacts: [] });
      const slowPlan = await runnablePlan(c, ['test/slow_test.dart']);
      const slow = sc<{ runId: string }>(
        await c.call('run_tests', { planId: slowPlan.planId, planHash: slowPlan.planHash }),
      );
      await waitRunning(c, slow.runId);
      expect(
        err(
          await c.call('generate_pr_test_report', {
            planId: slowPlan.planId,
            planHash: slowPlan.planHash,
            runIds: [slow.runId],
          }),
        ),
      ).toBe('E_REPORT_NOT_READY');
      expect(err(await c.call('analyze_test_failures', { runId: slow.runId }))).toBe('E_REPORT_NOT_READY');
      expect(
        err(
          await c.call('generate_pr_test_report', {
            planId: plan.planId,
            planHash: plan.planHash,
            runIds: [slow.runId],
          }),
        ),
      ).toBe('E_VALIDATION');
      await c.call('cancel_test_run', { runId: slow.runId });
      await waitTerminal(c, slow.runId);
      await c.close();
    },
  );
});
