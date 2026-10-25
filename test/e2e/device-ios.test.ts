/**
 * Opt-in (they take minutes and need simulators or emulators): AUTOTEST_E2E_DEVICES=1.
 * IOS-003 / E2E-005 (iOS part): native XCTest and XCUITest through the whole workflow on an AutoTest-owned simulator
 * with real Xcode — inspect, plan per test class, gate, run (xcodebuild + xcresulttool), results, report — and the
 * simulator is deleted at the end. Skips without macOS and Xcode.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import { composeServer } from '@autotest/mcp-server';
import { allResults, sc, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const XCRUN = process.platform === 'darwin' ? which('xcrun') : '';
const XCODEBUILD = process.platform === 'darwin' ? which('xcodebuild') : '';
const OK =
  process.env['AUTOTEST_E2E_DEVICES'] === '1' &&
  !!XCRUN &&
  !!XCODEBUILD &&
  spawnSync(XCODEBUILD, ['-version']).status === 0;
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-ios-host' };
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse())
    try {
      await c();
    } catch {
      // best effort
    }
});

describe.skipIf(!OK)('IOS-003 native iOS tests on an AutoTest-owned simulator (real Xcode)', () => {
  it('runs XCTest and XCUITest classes and reports pass, fail and skip per test', { timeout: 1_800_000 }, async () => {
    // AUTOTEST_E2E_KEEP=<dir> keeps the data root for inspection after a failure.
    const base = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env['AUTOTEST_E2E_KEEP'] || os.tmpdir(), 'autotest-ios-')),
    );
    const ws = path.join(base, 'ws');
    fs.cpSync(path.join(ROOT, 'fixtures/fixture-ios'), ws, { recursive: true });
    const data = path.join(base, 'data');
    fs.mkdirSync(data, { mode: 0o700 });
    fs.writeFileSync(
      path.join(data, 'config.yaml'),
      `version: 1\nworkspaces: [{ id: ws_ios, path: ${ws} }]\nexecutables:\n  xcrun: { path: ${fs.realpathSync(XCRUN)} }\n  xcodebuild: { path: ${fs.realpathSync(XCODEBUILD)} }\nexecution: { defaultTimeoutMs: 1800000, runDiskQuotaBytes: 8589934592 }\n`,
    );
    const c = await composeServer({ dataRoot: data, env: { ...process.env, ...HOST }, stderr: { write: () => true } });
    cleanups.push(() => c.close());

    const created = sc<{ deviceId: string }>(
      await c.call('manage_simulator', {
        action: 'create',
        create: { platform: 'ios', deviceType: 'iPhone 17e', runtime: 'iOS 26.4' },
      }),
    );
    cleanups.push(
      async () => void (await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })),
    );
    expect(
      sc<{ state: string }>(await c.call('manage_simulator', { action: 'boot', deviceId: created.deviceId })).state,
    ).toBe('Booted');

    const prj = sc<{ projectProfileId: string; frameworks: { adapterId: string }[] }>(
      await c.call('inspect_project', { workspace: 'ws_ios', probeToolchains: false }),
    );
    expect(prj.frameworks.map((f) => f.adapterId)).toEqual(['ios']);
    const inv = sc<{ inventoryId: string; targets: { path: string; level: string }[] }>(
      await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
    );
    expect(inv.targets.map((t) => [t.path, t.level])).toEqual([
      ['FixtureAppTests/CalculatorTests.swift', 'unit'],
      ['FixtureAppTests/ScenarioTests.swift', 'unit'],
      ['FixtureAppUITests/CounterUITests.swift', 'e2e'],
    ]);
    const prc = sc<{ prContextId: string }>(
      await c.call('get_pr_context', {
        workspace: 'ws_ios',
        source: 'manual',
        manual: {
          title: 'Calculator and counter',
          body: '## Acceptance criteria\n- [ ] add returns the sum\n- [ ] dividing by zero returns nil\n- [ ] tapping increment shows "Count: 1"\n',
        },
      }),
    );
    const rqs = sc<{ requirementSetId: string }>(
      await c.call('extract_requirements', { prContextId: prc.prContextId }),
    );
    const kase = (k: string, ac: string, level: string, technique: string, targetPath: string, expected: string) => ({
      clientKey: k,
      title: `Case ${k}`,
      requirementRefs: ['REQ-001'],
      acRefs: [ac],
      level,
      technique,
      priority: 'must',
      platforms: ['ios'],
      steps: ['Run the test class'],
      expectedResults: [expected],
      targetPath,
      automation: 'existing_test',
    });
    const plan = sc<{ planId: string; planHash: string; testCases: { eligibility: string }[] }>(
      await c.call('generate_test_plan', {
        requirementSetId: rqs.requirementSetId,
        inventoryId: inv.inventoryId,
        platformsInScope: ['ios'],
        draft: {
          testCases: [
            kase('a', 'REQ-001.AC-01', 'unit', 'regression', 'FixtureAppTests/CalculatorTests.swift', `Returns 42`),
            kase('b', 'REQ-001.AC-02', 'unit', 'error_handling', 'FixtureAppTests/ScenarioTests.swift', `Returns nil`),
            kase(
              'c',
              'REQ-001.AC-03',
              'e2e',
              'positive',
              'FixtureAppUITests/CounterUITests.swift',
              `Text 'Count: 1' is visible`,
            ),
          ],
        },
      }),
    );
    expect(plan.testCases.map((t) => t.eligibility)).toEqual(['eligible', 'eligible', 'eligible']);
    const gate = sc<{ decision: string; findings: unknown[] }>(
      await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }),
    );
    expect(gate.decision, JSON.stringify(gate.findings)).not.toBe('fail');
    if (gate.decision === 'needs_review') {
      const req = sc<{ approvalRequestId: string; scopeDigest: string }>(
        await c.call('request_approval', {
          scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
          justification: 'ios e2e',
          offerElicitation: false,
        }),
      );
      const digest = req.scopeDigest.slice('sha256:'.length);
      const io: Io = {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        out: () => undefined,
        err: () => undefined,
        ask: async (p) =>
          /positions ([\d, ]+):/
            .exec(p)![1]!
            .split(',')
            .map((n) => digest[Number(n.trim()) - 1])
            .join(''),
      };
      expect(await cli(['approve', req.approvalRequestId], io, { env: { ...HOST, AUTOTEST_HOME: data } })).toBe(0);
    }
    const run = sc<{ runId: string; error?: unknown }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, devices: [created.deviceId] }),
    );
    expect(run.error).toBeUndefined();
    const status = await waitTerminal(c, run.runId, 1_500_000);
    const decisions = (await c.ports.audit.readAll())
      .filter((e) => e.kind === 'authorization.decision')
      .map((e) => e.data);
    expect(status, JSON.stringify({ status, decisions })).toMatchObject({ state: 'completed' });
    const by = Object.fromEntries((await allResults(c, run.runId)).map((r) => [r.name, r.outcome]));
    expect(by).toEqual({
      'CalculatorTests/testAddReturnsTheSum()': 'passed',
      'CalculatorTests/testDivideByZeroReturnsNil()': 'passed',
      'ScenarioTests/testAddIsWrongOnPurpose()': 'failed',
      'ScenarioTests/testSkippedOnPurpose()': 'skipped',
      'CounterUITests/testTapIncrementShowsOne()': 'passed',
    });
    const rep = sc<{ verdict: string }>(
      await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [run.runId] }),
    );
    expect(rep.verdict).toBe('fail');
  });
});
