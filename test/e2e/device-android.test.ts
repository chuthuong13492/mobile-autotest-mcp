/**
 * Opt-in (they take minutes and need the Android SDK, a JDK and, for instrumented tests, an emulator):
 * AUTOTEST_E2E_DEVICES=1.
 * AND-003 / AND-004 / E2E-005 (Android part): native Android tests through the whole workflow with real Gradle —
 * inspect, plan per test class, gate, run, results, report. Unit tests run on the host JVM; instrumented tests run on
 * an AutoTest-owned emulator, which is deleted at the end. Gradle runs offline, so the fixture's dependencies must
 * already be in GRADLE_USER_HOME (build the fixture once, see fixtures/fixture-android/README.md).
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
const SDK = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? '';
const JAVA_HOME =
  process.env['JAVA_HOME'] ??
  (process.platform === 'darwin' ? spawnSync('/usr/libexec/java_home', { encoding: 'utf8' }).stdout.trim() : '');
const JAVA = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java') : '';
const GRADLE_USER_HOME = process.env['GRADLE_USER_HOME'] ?? path.join(os.homedir(), '.gradle');
const tools: Record<string, string> = {};
for (const [n, rel] of [
  ['adb', 'platform-tools/adb'],
  ['emulator', 'emulator/emulator'],
  ['avdmanager', 'cmdline-tools/latest/bin/avdmanager'],
] as const)
  if (SDK && fs.existsSync(path.join(SDK, rel))) tools[n] = path.join(SDK, rel);
const FREE_GB =
  Number(spawnSync('/bin/df', ['-k', os.homedir()], { encoding: 'utf8' }).stdout.split('\n')[1]?.split(/\s+/)[3] ?? 0) /
  1048576;
const OPT_IN = process.env['AUTOTEST_E2E_DEVICES'] === '1';
const UNIT = OPT_IN && !!SDK && !!JAVA && fs.existsSync(JAVA);
const INSTRUMENTED = UNIT && 'adb' in tools && 'emulator' in tools && 'avdmanager' in tools && FREE_GB >= 8;
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-android-host' };

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse())
    try {
      await c();
    } catch {
      // best effort
    }
});

async function setup() {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env['AUTOTEST_E2E_KEEP'] || os.tmpdir(), 'autotest-and-')),
  );
  const ws = path.join(base, 'ws');
  // The fixture without local build outputs, caches or local.properties (the SDK comes from ANDROID_HOME).
  fs.cpSync(path.join(ROOT, 'fixtures/fixture-android'), ws, {
    recursive: true,
    filter: (src) => !/[/\\](?:build|\.gradle)(?:[/\\]|$)|local\.properties$/.test(path.relative(ROOT, src)),
  });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const exes = { java: fs.realpathSync(JAVA), ...tools };
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_and, path: ${ws} }]\nexecutables:\n${Object.entries(exes)
      .map(([n, p]) => `  ${n}: { path: ${p} }`)
      .join(
        '\n',
      )}\nexecution: { defaultTimeoutMs: 1800000 }\nenv: { allow: [ANDROID_HOME, JAVA_HOME, GRADLE_USER_HOME] }\n`,
  );
  const c = await composeServer({
    dataRoot: data,
    env: { ...process.env, ...HOST, ANDROID_HOME: SDK, JAVA_HOME, GRADLE_USER_HOME },
    stderr: { write: () => true },
  });
  cleanups.push(() => c.close());
  return { c, data };
}

type C = Awaited<ReturnType<typeof setup>>['c'];

async function approveIfNeeded(c: C, data: string, plan: { planId: string; planHash: string }, decision: string) {
  if (decision !== 'needs_review') return;
  const req = sc<{ approvalRequestId: string; scopeDigest: string }>(
    await c.call('request_approval', {
      scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
      justification: 'android e2e',
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

const kase = (k: string, ac: string, level: string, technique: string, targetPath: string, expected: string) => ({
  clientKey: k,
  title: `Case ${k}`,
  requirementRefs: ['REQ-001'],
  acRefs: [ac],
  level,
  technique,
  priority: 'must',
  platforms: ['android'],
  steps: ['Run the test class'],
  expectedResults: [expected],
  targetPath,
  automation: 'existing_test',
});

async function plan(c: C, data: string, body: string, cases: ReturnType<typeof kase>[]) {
  const prj = sc<{ projectProfileId: string; frameworks: { adapterId: string }[] }>(
    await c.call('inspect_project', { workspace: 'ws_and', probeToolchains: false }),
  );
  expect(prj.frameworks.map((f) => f.adapterId)).toEqual(['android']);
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
  );
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', { workspace: 'ws_and', source: 'manual', manual: { title: 'Calculator', body } }),
  );
  const rqs = sc<{ requirementSetId: string }>(await c.call('extract_requirements', { prContextId: prc.prContextId }));
  const p = sc<{ planId: string; planHash: string; testCases: { eligibility: string }[] }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs.requirementSetId,
      inventoryId: inv.inventoryId,
      platformsInScope: ['android'],
      draft: { testCases: cases },
    }),
  );
  expect(p.testCases.map((t) => t.eligibility)).toEqual(cases.map(() => 'eligible'));
  const gate = sc<{ decision: string; findings: unknown[] }>(
    await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash }),
  );
  expect(gate.decision, JSON.stringify(gate.findings)).not.toBe('fail');
  await approveIfNeeded(c, data, p, gate.decision);
  return p;
}

const SRC = 'app/src';

describe.skipIf(!UNIT)('AND-003 native Android unit tests on the host JVM (real Gradle)', () => {
  it('runs JUnit classes and reports pass, fail and skip per test', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    const p = await plan(
      c,
      data,
      '## Acceptance criteria\n- [ ] add returns the sum\n- [ ] dividing by zero throws\n',
      [
        kase(
          'a',
          'REQ-001.AC-01',
          'unit',
          'regression',
          `${SRC}/test/java/dev/autotest/fixture/CalculatorTest.java`,
          'Returns 42',
        ),
        kase(
          'b',
          'REQ-001.AC-02',
          'unit',
          'error_handling',
          `${SRC}/test/java/dev/autotest/fixture/ScenarioTest.java`,
          'Throws',
        ),
      ],
    );
    const run = sc<{ runId: string; error?: unknown }>(
      await c.call('run_tests', { planId: p.planId, planHash: p.planHash }),
    );
    expect(run.error).toBeUndefined();
    expect(await waitTerminal(c, run.runId, 1_500_000)).toMatchObject({ state: 'completed' });
    const by = Object.fromEntries((await allResults(c, run.runId)).map((r) => [r.name, r.outcome]));
    expect(by).toEqual({
      'CalculatorTest/addReturnsTheSum': 'passed',
      'CalculatorTest/divideByZeroThrows': 'passed',
      'ScenarioTest/addIsWrongOnPurpose': 'failed',
      'ScenarioTest/skippedOnPurpose': 'skipped',
    });
    const rep = sc<{ verdict: string }>(
      await c.call('generate_pr_test_report', { planId: p.planId, planHash: p.planHash, runIds: [run.runId] }),
    );
    expect(rep.verdict).toBe('fail');
  });
});

describe.skipIf(!INSTRUMENTED)('AND-004 instrumented tests on an AutoTest-owned emulator (real Gradle)', () => {
  it('runs the instrumented class on the run emulator and releases it', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    const created = sc<{ deviceId: string }>(
      await c.call('manage_simulator', {
        action: 'create',
        create: { platform: 'android', deviceType: 'pixel_7', runtime: 'android-36' },
      }),
    );
    cleanups.push(
      async () => void (await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })),
    );
    const booted = await c.call('manage_simulator', { action: 'boot', deviceId: created.deviceId });
    expect(sc<{ state: string }>(booted).state, JSON.stringify(booted.structuredContent)).toBe('Booted');
    const p = await plan(c, data, '## Acceptance criteria\n- [ ] the app package is right on the device\n', [
      kase(
        'a',
        'REQ-001.AC-01',
        'integration',
        'regression',
        `${SRC}/androidTest/java/dev/autotest/fixture/CalculatorInstrumentedTest.java`,
        'Package name matches',
      ),
    ]);
    // Instrumented targets cannot run without the device.
    expect(
      sc<{ error?: { code: string } }>(await c.call('run_tests', { planId: p.planId, planHash: p.planHash })).error
        ?.code,
    ).toBe('E_VALIDATION');
    const run = sc<{ runId: string; error?: unknown }>(
      await c.call('run_tests', { planId: p.planId, planHash: p.planHash, devices: [created.deviceId] }),
    );
    expect(run.error).toBeUndefined();
    expect(await waitTerminal(c, run.runId, 1_500_000)).toMatchObject({ state: 'completed' });
    const results = await allResults(c, run.runId);
    const by = Object.fromEntries(results.map((r) => [r.name, r.outcome]));
    expect(by, JSON.stringify(results)).toEqual({
      'CalculatorInstrumentedTest/runsOnTheDevice': 'passed',
      'CalculatorInstrumentedTest/addIsWrongOnTheDevice': 'failed',
    });
    const rep = sc<{ verdict: string }>(
      await c.call('generate_pr_test_report', { planId: p.planId, planHash: p.planHash, runIds: [run.runId] }),
    );
    expect(rep.verdict).toBe('fail');
    expect(
      sc<{ state: string }>(await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })).state,
    ).toBe('Deleted');
  });
});
