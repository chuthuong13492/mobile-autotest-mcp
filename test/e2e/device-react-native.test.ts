/**
 * Opt-in (minutes; needs the React Native fixture installed and built, and simulators or emulators):
 * AUTOTEST_E2E_DEVICES=1. Prepare the fixture once (fixtures/fixture-react-native/README.md): `npm install`,
 * `pod install`, a Release simulator build and the Android release and test APKs.
 * RN-002 / RN-003 / E2E-006: Jest on the host, then on an AutoTest-owned simulator and emulator: install the app
 * (`manage_simulator install`), Maestro flows and Detox tests through the whole workflow. Detox on iOS also needs
 * `applesimutils` on PATH. Devices are deleted at the end.
 * APM-001 / E2E-006 (Appium part): the fixture's pinned Appium suite on an emulator, with the Appium server as a
 * background service; needs `appium` (3.4.2) on PATH and APPIUM_HOME with the pinned UiAutomator2 driver
 * (`APPIUM_HOME=~/.appium-autotest appium driver install uiautomator2@8.7.0`).
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
const FIXTURE = path.join(ROOT, 'fixtures/fixture-react-native');
const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const SDK = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? '';
const JAVA_HOME = process.env['JAVA_HOME'] ?? '';
const MAESTRO = [path.join(os.homedir(), '.maestro/bin/maestro'), which('maestro')].find((p) => p && fs.existsSync(p));
const IOS_APP = 'ios/build/Build/Products/Release-iphonesimulator/FixtureRn.app';
const APK = 'android/app/build/outputs/apk/release/app-release.apk';
const tools: Record<string, string> = {};
if (process.platform === 'darwin' && which('xcrun')) tools['xcrun'] = fs.realpathSync(which('xcrun'));
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
const PREPARED = fs.existsSync(path.join(FIXTURE, 'node_modules/jest/bin/jest.js'));
const JEST = OPT_IN && PREPARED;
const IOS = JEST && !!MAESTRO && 'xcrun' in tools && fs.existsSync(path.join(FIXTURE, IOS_APP));
const DETOX_IOS = IOS && !!which('applesimutils');
const ANDROID =
  JEST && !!MAESTRO && 'adb' in tools && 'emulator' in tools && FREE_GB >= 8 && fs.existsSync(path.join(FIXTURE, APK));
const APPIUM_HOME = process.env['APPIUM_HOME'] ?? path.join(os.homedir(), '.appium-autotest');
const APPIUM = which('appium');
const APPIUM_OK =
  ANDROID && !!APPIUM && fs.existsSync(path.join(APPIUM_HOME, 'node_modules/appium-uiautomator2-driver/package.json'));
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-rn-host' };

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
    fs.mkdtempSync(path.join(process.env['AUTOTEST_E2E_KEEP'] || os.tmpdir(), 'autotest-rn-')),
  );
  const ws = path.join(base, 'ws');
  // A copy-on-write clone on APFS (node_modules, Pods and the prebuilt apps come along at no cost).
  const cp = spawnSync('cp', [process.platform === 'darwin' ? '-cR' : '-R', FIXTURE, ws]);
  expect(cp.status).toBe(0);
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const exes = {
    node: process.execPath,
    ...(MAESTRO ? { maestro: fs.realpathSync(MAESTRO) } : {}),
    ...(APPIUM ? { appium: fs.realpathSync(APPIUM) } : {}),
    ...tools,
  };
  // Detox runs xcrun, applesimutils and adb by name; Maestro needs java; the appium launcher needs node.
  const pathDirs = [
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.dirname(which('applesimutils') || '/opt/homebrew/bin/x'),
    path.dirname(process.execPath),
  ];
  if (JAVA_HOME) pathDirs.push(path.join(JAVA_HOME, 'bin'));
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_rn, path: ${ws} }]\nexecutables:\n${Object.entries(exes)
      .map(([n, p]) => `  ${n}: { path: ${p} }`)
      .join(
        '\n',
      )}\nexecution: { defaultTimeoutMs: 1800000, runDiskQuotaBytes: 8589934592 }\nenv:\n  allow: [ANDROID_HOME, JAVA_HOME, APPIUM_HOME]\n  pathDirs: [${pathDirs.join(', ')}]\n`,
  );
  const c = await composeServer({
    dataRoot: data,
    env: {
      ...process.env,
      ...HOST,
      APPIUM_HOME,
      ...(SDK ? { ANDROID_HOME: SDK } : {}),
      ...(JAVA_HOME ? { JAVA_HOME } : {}),
    },
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
      justification: 'react native e2e',
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

interface Case {
  readonly key: string;
  readonly level: string;
  readonly platform: 'host' | 'ios' | 'android';
  readonly targetPath: string;
  readonly technique: string;
}

async function plan(c: C, data: string, cases: readonly Case[]) {
  const prj = sc<{ projectProfileId: string; frameworks: { adapterId: string }[] }>(
    await c.call('inspect_project', { workspace: 'ws_rn', probeToolchains: false }),
  );
  expect(prj.frameworks.map((f) => f.adapterId)).toContain('react-native');
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
  );
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', {
      workspace: 'ws_rn',
      source: 'manual',
      manual: {
        title: 'Counter',
        body: cases
          .map((_, i) => `- [ ] criterion ${i + 1} holds`)
          .join('\n')
          .replace(/^/, '## Acceptance criteria\n'),
      },
    }),
  );
  const rqs = sc<{ requirementSetId: string }>(await c.call('extract_requirements', { prContextId: prc.prContextId }));
  const platforms = [...new Set(cases.map((k) => k.platform))];
  const p = sc<{ planId: string; planHash: string; testCases: { eligibility: string }[] }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs.requirementSetId,
      inventoryId: inv.inventoryId,
      platformsInScope: platforms,
      draft: {
        testCases: cases.map((k, i) => ({
          clientKey: k.key,
          title: `Case ${k.key}`,
          requirementRefs: ['REQ-001'],
          acRefs: [`REQ-001.AC-0${i + 1}`],
          level: k.level,
          technique: k.technique,
          priority: 'must',
          platforms: [k.platform],
          steps: ['Run it'],
          expectedResults: ['It holds'],
          targetPath: k.targetPath,
          automation: 'existing_test',
        })),
      },
    }),
  );
  expect(
    p.testCases.map((t) => t.eligibility),
    JSON.stringify(p.testCases),
  ).toEqual(cases.map(() => 'eligible'));
  const gate = sc<{ decision: string; findings: unknown[] }>(
    await c.call('validate_test_coverage', { planId: p.planId, planHash: p.planHash }),
  );
  expect(gate.decision, JSON.stringify(gate.findings)).not.toBe('fail');
  await approveIfNeeded(c, data, p, gate.decision);
  return p;
}

async function runAndResults(c: C, p: { planId: string; planHash: string }, devices: string[] = []) {
  const run = sc<{ runId: string; error?: unknown }>(
    await c.call('run_tests', { planId: p.planId, planHash: p.planHash, ...(devices.length ? { devices } : {}) }),
  );
  expect(run.error).toBeUndefined();
  expect(await waitTerminal(c, run.runId, 1_700_000)).toMatchObject({ state: 'completed' });
  const results = await allResults(c, run.runId);
  const rep = sc<{ verdict: string }>(
    await c.call('generate_pr_test_report', { planId: p.planId, planHash: p.planHash, runIds: [run.runId] }),
  );
  return { results, by: Object.fromEntries(results.map((r) => [r.name, r.outcome])), verdict: rep.verdict };
}

async function deviceWithApp(c: C, platform: 'ios' | 'android') {
  const created = sc<{ deviceId: string }>(
    await c.call('manage_simulator', {
      action: 'create',
      create:
        platform === 'ios'
          ? { platform, deviceType: 'iPhone 17e', runtime: 'iOS 26.4' }
          : { platform, deviceType: 'pixel_7', runtime: 'android-36' },
    }),
  );
  cleanups.push(async () => void (await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })));
  const booted = await c.call('manage_simulator', { action: 'boot', deviceId: created.deviceId });
  expect(sc<{ state: string }>(booted).state, JSON.stringify(booted.structuredContent)).toBe('Booted');
  const installed = await c.call('manage_simulator', {
    action: 'install',
    deviceId: created.deviceId,
    install: { workspace: 'ws_rn', appPath: platform === 'ios' ? IOS_APP : APK },
  });
  expect(sc<{ result: string }>(installed).result, JSON.stringify(installed.structuredContent)).toBe('done');
  return created.deviceId;
}

const MAESTRO_EXPECTED = { counter: 'passed', 'wrong-count': 'failed' };
const DETOX_EXPECTED = {
  'counter tapping increment shows Count: 1': 'passed',
  'counter shows Count: 5 on purpose': 'failed',
};

describe.skipIf(!JEST)('RN-002 Jest on the host (real Jest)', () => {
  it('runs the Jest files and reports pass, fail and skip', { timeout: 900_000 }, async () => {
    const { c, data } = await setup();
    const p = await plan(c, data, [
      {
        key: 'a',
        level: 'unit',
        platform: 'host',
        targetPath: '__tests__/calculator.test.ts',
        technique: 'regression',
      },
      {
        key: 'b',
        level: 'unit',
        platform: 'host',
        targetPath: '__tests__/scenario.test.ts',
        technique: 'error_handling',
      },
      { key: 'c', level: 'component', platform: 'host', targetPath: '__tests__/App.test.tsx', technique: 'positive' },
    ]);
    const r = await runAndResults(c, p);
    expect(r.by, JSON.stringify(r.results)).toEqual({
      'calculator add returns the sum': 'passed',
      'calculator dividing by zero returns null': 'passed',
      'add is wrong on purpose': 'failed',
      'skipped on purpose': 'skipped',
      'renders the count': 'passed',
    });
    expect(r.verdict).toBe('fail');
  });
});

describe.skipIf(!IOS)('RN-003 Maestro (and Detox with applesimutils) on an AutoTest-owned simulator', () => {
  it('installs the app and runs the flows on the run simulator', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    const deviceId = await deviceWithApp(c, 'ios');
    const p = await plan(c, data, [
      { key: 'a', level: 'e2e', platform: 'ios', targetPath: '.maestro/counter.yaml', technique: 'positive' },
      { key: 'b', level: 'e2e', platform: 'ios', targetPath: '.maestro/wrong-count.yaml', technique: 'regression' },
      ...(DETOX_IOS
        ? [
            {
              key: 'c',
              level: 'e2e',
              platform: 'ios' as const,
              targetPath: 'e2e/counter.test.js',
              technique: 'positive',
            },
          ]
        : []),
    ]);
    const r = await runAndResults(c, p, [deviceId]);
    expect(r.by, JSON.stringify(r.results)).toEqual({ ...MAESTRO_EXPECTED, ...(DETOX_IOS ? DETOX_EXPECTED : {}) });
    expect(r.verdict).toBe('fail');
  });
});

describe.skipIf(!ANDROID)('RN-003 Maestro and Detox on an AutoTest-owned emulator', () => {
  it('installs the app and runs the flows and Detox tests on the run emulator', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    const deviceId = await deviceWithApp(c, 'android');
    const p = await plan(c, data, [
      { key: 'a', level: 'e2e', platform: 'android', targetPath: '.maestro/counter.yaml', technique: 'positive' },
      { key: 'b', level: 'e2e', platform: 'android', targetPath: '.maestro/wrong-count.yaml', technique: 'regression' },
      { key: 'c', level: 'e2e', platform: 'android', targetPath: 'e2e/counter.test.js', technique: 'positive' },
    ]);
    const r = await runAndResults(c, p, [deviceId]);
    expect(r.by, JSON.stringify(r.results)).toEqual({ ...MAESTRO_EXPECTED, ...DETOX_EXPECTED });
    expect(r.verdict).toBe('fail');
  });
});

describe.skipIf(!APPIUM_OK)('APM-001 the pinned Appium suite on an AutoTest-owned emulator (real Appium)', () => {
  it('starts Appium as a background service and runs each scenario', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    const deviceId = await deviceWithApp(c, 'android');
    const p = await plan(c, data, [
      {
        key: 'a',
        level: 'e2e',
        platform: 'android',
        targetPath: 'appium/scenario-list.json#counterIncrements',
        technique: 'positive',
      },
      {
        key: 'b',
        level: 'e2e',
        platform: 'android',
        targetPath: 'appium/scenario-list.json#counterIsFiveOnPurpose',
        technique: 'regression',
      },
    ]);
    const r = await runAndResults(c, p, [deviceId]);
    expect(r.by, JSON.stringify(r.results)).toEqual({ counterIncrements: 'passed', counterIsFiveOnPurpose: 'failed' });
    expect(r.verdict).toBe('fail');
  });
});
