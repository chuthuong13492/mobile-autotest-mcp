/**
 * Opt-in (they take minutes and need simulators or emulators): AUTOTEST_E2E_DEVICES=1.
 * FL-006 / E2E-005 (Flutter part): `integration_test` on an AutoTest-owned simulator or emulator through the whole
 * workflow with real Flutter — create and boot a device, plan an integration case for that platform, gate, run on the
 * device, results, report — and the device is deleted at the end. Skips a platform this host cannot run.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import { composeServer } from '@autotest/mcp-server';
import { allResults, sc, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const FLUTTER = process.env['AUTOTEST_E2E_FLUTTER'] ?? which('flutter');
const SDK = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? '';
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
const IOS = OPT_IN && !!FLUTTER && 'xcrun' in tools;
const ANDROID = OPT_IN && !!FLUTTER && 'adb' in tools && 'emulator' in tools && 'avdmanager' in tools && FREE_GB >= 8;
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-device-host' };
/** What `autotest setup` gives the server for Android device runs (env.allow + values). */
const JAVA_HOME = process.env['JAVA_HOME'] ?? spawnSync('/usr/libexec/java_home', { encoding: 'utf8' }).stdout.trim();
const ANDROID_ENV = {
  ...(SDK ? { ANDROID_HOME: SDK } : {}),
  ...(JAVA_HOME ? { JAVA_HOME } : {}),
  GRADLE_USER_HOME: process.env['GRADLE_USER_HOME'] ?? path.join(os.homedir(), '.gradle'),
};

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
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-devflutter-')));
  const ws = path.join(base, 'ws');
  fs.cpSync(path.join(ROOT, 'fixtures/fixture-flutter'), ws, { recursive: true });
  execFileSync(fs.realpathSync(FLUTTER), ['pub', 'get', '--offline'], { cwd: ws, stdio: 'ignore', timeout: 240_000 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  const exes = { flutter: fs.realpathSync(FLUTTER), ...tools };
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables:\n${Object.entries(exes)
      .map(([n, p]) => `  ${n}: { path: ${p} }`)
      .join(
        '\n',
      )}\nexecution: { defaultTimeoutMs: 1800000 }\nenv: { allow: [ANDROID_HOME, JAVA_HOME, GRADLE_USER_HOME] }\n`,
  );
  const c = await composeServer({
    dataRoot: data,
    env: { ...process.env, ...HOST, ...ANDROID_ENV },
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
      justification: 'device e2e',
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

async function devicePlan(c: C, platform: 'ios' | 'android') {
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', {
      workspace: 'ws_app',
      source: 'manual',
      manual: {
        title: 'Counter',
        body: '## Acceptance criteria\n- [ ] Tapping increment shows "Count: 1" on the device\n',
      },
    }),
  );
  const prj = sc<{ projectProfileId: string }>(
    await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
  );
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
  );
  const rqs = sc<{ requirementSetId: string }>(await c.call('extract_requirements', { prContextId: prc.prContextId }));
  const plan = sc<{ planId: string; planHash: string; testCases: { eligibility: string }[] }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs.requirementSetId,
      inventoryId: inv.inventoryId,
      platformsInScope: [platform],
      draft: {
        testCases: [
          {
            clientKey: 'k1',
            title: `Counter on ${platform}`,
            requirementRefs: ['REQ-001'],
            acRefs: ['REQ-001.AC-01'],
            level: 'integration',
            technique: 'regression',
            priority: 'must',
            platforms: [platform],
            steps: ['Tap increment'],
            expectedResults: [`Text 'Count: 1' is visible`],
            targetPath: 'integration_test/app_test.dart',
            automation: 'existing_test',
          },
        ],
      },
    }),
  );
  expect(plan.testCases[0]!.eligibility).toBe('eligible');
  const d = sc<{ decision: string }>(
    await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }),
  );
  expect(d.decision, JSON.stringify((d as unknown as { findings: unknown }).findings)).not.toBe('fail');
  return { plan, decision: d.decision };
}

async function runOnDevice(c: C, data: string, platform: 'ios' | 'android', create: Record<string, string>) {
  const created = sc<{ deviceId: string }>(
    await c.call('manage_simulator', { action: 'create', create: { platform, ...create } }),
  );
  cleanups.push(async () => void (await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })));
  const booted = await c.call('manage_simulator', { action: 'boot', deviceId: created.deviceId });
  expect(sc<{ state: string }>(booted).state, JSON.stringify(booted.structuredContent)).toBe('Booted');
  const { plan, decision } = await devicePlan(c, platform);
  await approveIfNeeded(c, data, plan, decision);
  // Without the device the integration target cannot run.
  expect(
    sc<{ error?: { code: string } }>(await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash })).error
      ?.code,
  ).toBe('E_VALIDATION');
  const run = sc<{ runId: string; error?: unknown }>(
    await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, devices: [created.deviceId] }),
  );
  expect(run.error).toBeUndefined();
  // The device is busy while the run holds it.
  expect(
    sc<{ error?: { code: string } }>(await c.call('manage_simulator', { action: 'erase', deviceId: created.deviceId }))
      .error?.code,
  ).toBe('E_DEVICE_UNAVAILABLE');
  expect(await waitTerminal(c, run.runId, 1_500_000)).toMatchObject({ state: 'completed' });
  const results = await allResults(c, run.runId);
  const by = Object.fromEntries(results.map((r) => [r.name, r.outcome]));
  expect(by['tapping increment shows Count: 1 on the device'], JSON.stringify(results)).toBe('passed');
  expect(by['the count is wrong on purpose']).toBe('failed');
  const rep = sc<{ verdict: string }>(
    await c.call('generate_pr_test_report', { planId: plan.planId, planHash: plan.planHash, runIds: [run.runId] }),
  );
  expect(rep.verdict).toBeDefined();
  // The run released the device: it can be deleted again (P1, owned).
  expect(
    sc<{ state: string }>(await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })).state,
  ).toBe('Deleted');
}

describe.skipIf(!IOS)('FL-006 integration_test on an iOS simulator (real Flutter, real Xcode)', () => {
  it('runs the integration test on an AutoTest-owned simulator', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    await runOnDevice(c, data, 'ios', { deviceType: 'iPhone 17e', runtime: 'iOS 26.4' });
  });
});

describe.skipIf(!ANDROID)('FL-006 integration_test on an Android emulator (real Flutter, real emulator)', () => {
  it('runs the integration test on an AutoTest-owned emulator', { timeout: 1_800_000 }, async () => {
    const { c, data } = await setup();
    await runOnDevice(c, data, 'android', { deviceType: 'pixel_7', runtime: 'android-36' });
  });
});
