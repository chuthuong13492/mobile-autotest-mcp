/**
 * E2E-002 (Phase 1 exit): the whole workflow through the MCP server with **real Flutter** on the fixture app:
 * manual PR → inspection → requirements → plan → gate (`pass`, `needs_review` approved through the CLI challenge,
 * `fail` blocked) → run (flaky retry, failures, load error, cancellation) → evidence → analysis → report, and the
 * audit chain verifies. Skips (with the reason) when no Flutter SDK is on PATH or in AUTOTEST_E2E_FLUTTER.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import { composeServer } from '@autotest/mcp-server';
import { verifyAuditFiles } from '@autotest/storage';
import { allResults, runnablePlan, sc, waitRunning, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FLUTTER =
  process.env['AUTOTEST_E2E_FLUTTER'] ??
  spawnSync('/bin/sh', ['-c', 'command -v flutter'], { encoding: 'utf8' }).stdout.trim();
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-host' };

/** A fixture copy with the given scenario files moved into test/, dependencies resolved, and a data root. */
function fixtureApp(scenarios: readonly string[]) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-e2e-')));
  const ws = path.join(base, 'ws');
  fs.cpSync(path.join(ROOT, 'fixtures/fixture-flutter'), ws, { recursive: true });
  for (const s of scenarios) {
    const src = path.join(ws, 'test_scenarios', s);
    fs.copyFileSync(src, path.join(ws, 'test', s.replace(/\.txt$/, '')));
  }
  execFileSync(fs.realpathSync(FLUTTER), ['pub', 'get', '--offline'], { cwd: ws, stdio: 'ignore', timeout: 240_000 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${fs.realpathSync(FLUTTER)} } }\nexecution: { cancelGraceMs: 2000 }\n`,
  );
  return { ws, data };
}
const compose = (data: string) => composeServer({ dataRoot: data, env: HOST, stderr: { write: () => true } });

const suite = FLUTTER ? describe : describe.skip;
suite(`E2E-002 local Flutter end to end (${FLUTTER || 'no Flutter SDK found'})`, () => {
  it(
    'pass: flaky retried and labelled, coverage evidence, analysis, pass report, audit chain intact',
    { timeout: 300_000 },
    async () => {
      const f = fixtureApp(['flaky_test.dart']);
      const c = await compose(f.data);
      const plan = await runnablePlan(c, [
        'test/calculator_test.dart',
        'test/counter_widget_test.dart',
        'test/flaky_test.dart',
      ]);
      expect(plan.decision).toBe('pass');
      const runId = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, evidence: { coverage: true } }),
      ).runId;
      expect(await waitTerminal(c, runId, 240_000)).toMatchObject({ state: 'completed' });
      const results = await allResults(c, runId);
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.outcome === 'passed')).toBe(true);
      expect(results.find((r) => r.name === 'passes on the second attempt')).toMatchObject({
        flaky: true,
        attemptNo: 2,
      });
      const ev = sc<{ artifacts: { kind: string; quarantined: boolean }[] }>(
        await c.call('collect_test_evidence', { runId }),
      );
      expect(new Set(ev.artifacts.map((a) => a.kind))).toEqual(
        new Set(['stdout', 'stderr', 'runner_json', 'coverage', 'junit']),
      );
      expect(ev.artifacts.some((a) => a.quarantined)).toBe(false);
      const an = sc<{ analyses: { class: string; subtype: string }[] }>(
        await c.call('analyze_test_failures', { runId }),
      );
      expect(an.analyses).toEqual([expect.objectContaining({ class: 'test_defect', subtype: 'flaky' })]);
      const rep = sc<{ verdict: string; verdictRule: number; artifacts: unknown[] }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
      );
      expect(rep).toMatchObject({ verdict: 'pass', verdictRule: 5 });
      expect(rep.artifacts).toHaveLength(3);
      expect(verifyAuditFiles(f.data)).toMatchObject({ ok: true });
      await c.close();
    },
  );

  it(
    'needs_review: refused until a human approves with the CLI challenge, then runs',
    { timeout: 300_000 },
    async () => {
      const f = fixtureApp([]);
      const c = await compose(f.data);
      const plan = await runnablePlan(c, ['test/calculator_test.dart', 'test/counter_widget_test.dart'], {
        weak: true,
      });
      expect(plan.decision).toBe('needs_review');
      expect((await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash })).isError).toBe(true);
      const req = sc<{ approvalRequestId: string; scopeDigest: string }>(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
          justification: 'GR-02',
          offerElicitation: false,
        }),
      );
      const io: Io = {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        out: () => undefined,
        err: () => undefined,
        ask: async (p) => (/\[y\/N\] $/.test(p) ? 'y' : ''),
      };
      expect(await cli(['approve', req.approvalRequestId], io, { env: { ...HOST, AUTOTEST_HOME: f.data } })).toBe(0);
      const runId = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      ).runId;
      expect(await waitTerminal(c, runId, 240_000)).toMatchObject({ state: 'completed' });
      const rep = sc<{ verdict: string }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
      );
      expect(rep.verdict).toBe('pass');
      await c.close();
    },
  );

  it(
    'failures: assertion, exception and load error are reported and analyzed; the verdict is fail',
    { timeout: 300_000 },
    async () => {
      const f = fixtureApp(['fail_test.dart', 'error_test.dart', 'skip_test.dart', 'load_error_test.dart.txt']);
      const c = await compose(f.data);
      const plan = await runnablePlan(c, [
        'test/fail_test.dart',
        'test/error_test.dart',
        'test/load_error_test.dart',
        'test/calculator_test.dart',
      ]);
      const runId = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
      ).runId;
      expect(await waitTerminal(c, runId, 240_000)).toMatchObject({ state: 'completed' });
      const by = Object.fromEntries(
        (await allResults(c, runId)).map((r) => [r.name, [r.outcome, r.failureKind, r.attemptNo]]),
      );
      expect(by['add is wrong on purpose']).toEqual(['failed', 'assertion', 2]);
      expect(by['divide by zero is not caught']).toEqual(['failed', 'exception', 2]);
      expect(by['loading test/load_error_test.dart']).toEqual(['failed', 'load_error', 1]);
      expect(by['add returns the sum']).toEqual(['passed', null, 1]);
      const an = sc<{ summary: Record<string, number> }>(await c.call('analyze_test_failures', { runId }));
      expect(an.summary['product_defect']).toBe(2);
      const rep = sc<{ verdict: string; verdictRule: number }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [runId] }),
      );
      expect(rep).toMatchObject({ verdict: 'fail', verdictRule: 3 });
      await c.close();
    },
  );

  it(
    'a failed gate blocks the run; a slow run is cancelled and nothing is reported as passed',
    { timeout: 300_000 },
    async () => {
      const f = fixtureApp(['slow_test.dart']);
      const c = await compose(f.data);
      const prc = sc<{ prContextId: string }>(
        await c.call('get_pr_context', {
          workspace: 'ws_app',
          source: 'manual',
          manual: {
            title: 'x',
            body: '## Acceptance criteria\n- [ ] Card payments reject an expired card with "card_expired"\n',
          },
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
      const failing = sc<{ planId: string; planHash: string }>(
        await c.call('generate_test_plan', {
          requirementSetId: rqs.requirementSetId,
          inventoryId: inv.inventoryId,
          platformsInScope: ['host'],
          draft: {
            testCases: [
              {
                clientKey: 'p',
                title: 'Expired card is rejected',
                requirementRefs: ['REQ-001'],
                acRefs: ['REQ-001.AC-01'],
                level: 'unit',
                technique: 'positive',
                priority: 'must',
                platforms: ['host'],
                steps: ['pay'],
                expectedResults: ['Returns "card_expired"'],
                automation: 'new_test_required',
              },
            ],
          },
        }),
      );
      expect(
        sc<{ decision: string }>(
          await c.call('validate_test_coverage', { planId: failing.planId, planHash: failing.planHash }),
        ).decision,
      ).toBe('fail');
      expect(
        (await c.call('run_tests', { planId: failing.planId, planHash: failing.planHash })).structuredContent,
      ).toMatchObject({ error: { code: 'E_COVERAGE_FAILED' } });

      const slow = await runnablePlan(c, ['test/slow_test.dart']);
      const runId = sc<{ runId: string }>(
        await c.call('run_tests', { planId: slow.planId, planHash: slow.planHash }),
      ).runId;
      await waitRunning(c, runId, 120_000);
      await new Promise((r) => setTimeout(r, 3000));
      await c.call('cancel_test_run', { runId });
      expect(await waitTerminal(c, runId, 60_000)).toMatchObject({ state: 'cancelled' });
      expect((await allResults(c, runId)).some((r) => r.outcome === 'passed')).toBe(false);
      await c.close();
    },
  );
  it(
    'baseline (ANL-002): a failure that also fails at the base commit is pre_existing, with real Flutter',
    { timeout: 300_000 },
    async () => {
      const f = fixtureApp(['fail_test.dart']);
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
          cwd: f.ws,
          encoding: 'utf8',
        }).trim();
      fs.writeFileSync(path.join(f.ws, '.gitignore'), '.dart_tool/\nbuild/\n');
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('branch', 'base');
      fs.appendFileSync(path.join(f.ws, 'lib/calculator.dart'), '// head change\n');
      git('commit', '-qam', 'head');
      const gitPath = fs.realpathSync(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
      const cfg = path.join(f.data, 'config.yaml');
      fs.writeFileSync(
        cfg,
        fs.readFileSync(cfg, 'utf8').replace('executables: {', `executables: { git: { path: ${gitPath} },`),
      );
      const c = await compose(f.data);
      const plan = await runnablePlan(c, ['test/fail_test.dart', 'test/calculator_test.dart']);
      const head = sc<{ runId: string }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }));
      expect(await waitTerminal(c, head.runId, 240_000)).toMatchObject({ state: 'completed' });
      const base = sc<{ runId: string }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, baseline: { ref: 'base' } }),
      );
      expect(await waitTerminal(c, base.runId, 240_000)).toMatchObject({ state: 'completed' });
      const baseResults = await allResults(c, base.runId);
      const seen = JSON.stringify(baseResults.map((r) => [r.name, r.outcome, r.failureKind]));
      expect(baseResults.find((r) => r.name === 'add returns the sum')?.outcome, seen).toBe('passed');
      expect(baseResults.find((r) => r.name === 'add is wrong on purpose')?.outcome).toBe('failed');
      expect(fs.existsSync(path.join(f.data, 'runs', base.runId, 'baseline'))).toBe(false);
      const an = sc<{ analyses: { class: string; subtype: string }[] }>(
        await c.call('analyze_test_failures', { runId: head.runId }),
      );
      expect(an.analyses.map((a) => `${a.class}/${a.subtype}`)).toContain('pre_existing/baseline_failure');
      const rep = sc<{ verdict: string }>(
        await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [head.runId] }),
      );
      // Every failure is pre-existing, so the PR itself introduced no failure.
      expect(rep.verdict).not.toBe('fail');
      await c.close();
    },
  );
});
