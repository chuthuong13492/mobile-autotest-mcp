/**
 * DEV-001/DEV-002 tier matrix with fake device tools (fast; the real-device runs are test/e2e/devices.test.ts).
 * The fake xcrun/adb/emulator answer from a JSON state file and log every invocation, so the tests can prove that a
 * refused action never reached the tool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grantApproval } from '@autotest/workflow';
import { composeServer } from '../src/compose.ts';

const USER_SIM = '11111111-2222-3333-4444-555555555555';
const SPOOF_SIM = '66666666-7777-8888-9999-AAAAAAAAAAAA';
const NEW_SIM = 'BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF';

const FAKE = (state: string, log: string) => `#!${process.execPath}
const fs = require('node:fs');
const tool = require('node:path').basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, tool + ' ' + args.join(' ') + (process.env.ANDROID_SERIAL ? ' @' + process.env.ANDROID_SERIAL : '') + '\\n');
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
if (tool === 'xcrun') {
  const [, verb, a, b, c] = args;
  if (verb === 'list' && a === 'devices') { console.log(JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-4': st.sims } })); process.exit(0); }
  if (verb === 'list' && a === 'runtimes') { console.log(JSON.stringify({ runtimes: [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4', name: 'iOS 26.4', isAvailable: true }] })); process.exit(0); }
  if (verb === 'list' && a === 'devicetypes') { console.log(JSON.stringify({ devicetypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17e', name: 'iPhone 17e' }] })); process.exit(0); }
  if (verb === 'create') { st.sims.push({ udid: '${NEW_SIM}', name: a, state: 'Shutdown', isAvailable: true }); save(); console.log('${NEW_SIM}'); process.exit(0); }
  const sim = st.sims.find((s) => s.udid === a);
  if (!sim) { console.error('Invalid device'); process.exit(1); }
  if (verb === 'boot') sim.state = 'Booted';
  if (verb === 'shutdown') sim.state = 'Shutdown';
  if (verb === 'delete') st.sims = st.sims.filter((s) => s !== sim);
  save();
  process.exit(0);
}
if (tool === 'adb' && args[0] === 'devices') { console.log('List of devices attached\\nR58PHYSICAL\\tdevice usb:1 model:Pixel_8\\n'); process.exit(0); }
if (tool === 'emulator' && args[0] === '-list-avds') { console.log('Medium_Phone'); process.exit(0); }
process.exit(0);
`;

async function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-devfake-')));
  const state = path.join(base, 'state.json');
  const log = path.join(base, 'calls.log');
  fs.writeFileSync(
    state,
    JSON.stringify({
      sims: [
        { udid: USER_SIM, name: 'My Phone', state: 'Booted', isAvailable: true },
        { udid: SPOOF_SIM, name: 'autotest-looks-owned', state: 'Shutdown', isAvailable: true },
      ],
    }),
  );
  fs.writeFileSync(log, '');
  for (const t of ['xcrun', 'adb', 'emulator']) fs.writeFileSync(path.join(base, t), FAKE(state, log), { mode: 0o755 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nexecutables: { xcrun: { path: ${base}/xcrun }, adb: { path: ${base}/adb }, emulator: { path: ${base}/emulator } }\n`,
  );
  const c = await composeServer({
    dataRoot: data,
    env: { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'test-host', HOME: base },
    stderr: { write: () => true },
  });
  return { c, log: () => fs.readFileSync(log, 'utf8'), state: () => JSON.parse(fs.readFileSync(state, 'utf8')) };
}
type R = { structuredContent: Record<string, unknown> };
const err = (r: R) => (r.structuredContent as { error?: { code: string } }).error?.code;
const out = <T>(r: R) => r.structuredContent as T;

describe.skipIf(process.platform !== 'darwin')('DEV-001/002 tier matrix (fake tools)', () => {
  it('lists every platform; nothing is owned without a lease, whatever its name', async () => {
    const { c } = await setup();
    const l = out<{ host: object; devices: { deviceId: string; kind: string; owned: boolean }[] }>(
      (await c.call('list_devices', {})) as R,
    );
    expect(l.host).toEqual({ os: 'macos', simctl: true, adb: true, emulator: true });
    expect(l.devices.map((d) => [d.deviceId, d.kind, d.owned])).toEqual([
      [USER_SIM, 'simulator', false],
      [SPOOF_SIM, 'simulator', false],
      ['Medium_Phone', 'emulator', false],
      ['R58PHYSICAL', 'physical', false],
    ]);
    await c.close();
  });

  it('a device AutoTest does not own needs a single-use approval for exactly that action; tools are not called before', async () => {
    const { c, log, state } = await setup();
    for (const action of ['erase', 'delete', 'shutdown', 'boot'])
      expect(err((await c.call('manage_simulator', { action, deviceId: SPOOF_SIM })) as R), action).toBe(
        'E_APPROVAL_REQUIRED',
      );
    expect(log()).not.toMatch(/simctl (erase|delete|shutdown|boot) /);
    // An approval for `boot_non_owned` does not allow erase.
    const req = out<{ approvalRequestId: string }>(
      (await c.call('request_approval', {
        scope: { kind: 'device_action', deviceAction: { action: 'boot_non_owned', deviceId: SPOOF_SIM } },
        justification: 'boot for a run',
        offerElicitation: false,
      })) as R,
    );
    if (!c.policy.ok) throw new Error('policy');
    const g = await grantApproval(c.ports, {
      request: (await c.ports.approvals.getRequest(req.approvalRequestId))!,
      source: 'cli',
      assurance: 'AL2',
      approver: { osUser: 'tester' },
      environment: 'local:test-host',
      policyVersion: c.policy.policy.policyVersion,
      actor: 'cli',
    });
    expect(g.ok).toBe(true);
    expect(err((await c.call('manage_simulator', { action: 'erase', deviceId: SPOOF_SIM })) as R)).toBe(
      'E_APPROVAL_REQUIRED',
    );
    expect(
      out<{ tierApplied: string; owned: boolean }>(
        (await c.call('manage_simulator', { action: 'boot', deviceId: SPOOF_SIM })) as R,
      ),
    ).toMatchObject({ tierApplied: 'P2', owned: false });
    expect(state().sims.find((s: { udid: string }) => s.udid === SPOOF_SIM).state).toBe('Booted');
    // Single use: a second boot (shutdown first by hand) needs a new approval.
    expect(err((await c.call('manage_simulator', { action: 'shutdown', deviceId: SPOOF_SIM })) as R)).toBe(
      'E_APPROVAL_REQUIRED',
    );
    await c.close();
  });

  it('owned devices go through the whole lifecycle at P1; physical devices never; leases expire into cleanup', async () => {
    const { c, state } = await setup();
    expect(err((await c.call('manage_simulator', { action: 'erase', deviceId: 'R58PHYSICAL' })) as R)).toBe(
      'E_POLICY_DENIED',
    );
    const created = out<{ deviceId: string; leaseId: string; tierApplied: string }>(
      (await c.call('manage_simulator', {
        action: 'create',
        create: { platform: 'ios', deviceType: 'iPhone 17e', runtime: 'iOS 26.4' },
      })) as R,
    );
    expect(created).toMatchObject({ deviceId: NEW_SIM, tierApplied: 'P1' });
    expect(state().sims.find((s: { udid: string }) => s.udid === NEW_SIM).name).toMatch(/^autotest-[0-9a-z]{26}$/);
    for (const action of ['boot', 'shutdown', 'erase'])
      expect(
        out<{ tierApplied: string }>((await c.call('manage_simulator', { action, deviceId: NEW_SIM })) as R)
          .tierApplied,
        action,
      ).toBe('P1');
    const lease = (await c.ports.deviceLeases.findByDevice(NEW_SIM))!;
    await c.ports.deviceLeases.put({ ...lease, expiresAt: '2026-01-01T00:00:00Z' });
    const { cleanupExpiredDevices } = await import('@autotest/workflow');
    const deps = {
      ports: c.ports,
      policy: c.policy,
      dataRoot: c.dataRoot,
      hostOs: 'macos' as const,
      serverEnvironment: { id: 'local:test-host', kind: 'local' as const },
      parentEnv: {},
    };
    expect(await cleanupExpiredDevices(deps, { dryRun: true })).toEqual([
      { deviceId: NEW_SIM, result: 'would_delete' },
    ]);
    expect(await cleanupExpiredDevices(deps, { dryRun: false })).toEqual([{ deviceId: NEW_SIM, result: 'deleted' }]);
    expect(state().sims.some((s: { udid: string }) => s.udid === NEW_SIM)).toBe(false);
    expect(await c.ports.deviceLeases.findByDevice(NEW_SIM)).toBeUndefined();
    // The user's simulator was never touched.
    expect(state().sims.find((s: { udid: string }) => s.udid === USER_SIM).state).toBe('Booted');
    await c.close();
  });
});
