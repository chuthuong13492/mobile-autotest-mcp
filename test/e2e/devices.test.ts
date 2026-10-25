/**
 * Opt-in (they take minutes and need simulators or emulators): AUTOTEST_E2E_DEVICES=1.
 * DEV-001/DEV-002 end to end on this host's real simulators and emulators (macOS with Xcode for iOS; the Android SDK
 * with a system image for Android). Skips the platforms the host cannot run. Never touches a device it did not
 * create: the "not owned" cases use a simulator this test creates directly with simctl, outside AutoTest (no lease),
 * and name it like an AutoTest device on purpose (a spoofed name must not grant ownership).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeServer } from '@autotest/mcp-server';

const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const SDK = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'] ?? '';
const tools: Record<string, string> = {};
if (process.platform === 'darwin' && which('xcrun')) tools['xcrun'] = fs.realpathSync(which('xcrun'));
for (const [n, rel] of [
  ['adb', 'platform-tools/adb'],
  ['emulator', 'emulator/emulator'],
  ['avdmanager', 'cmdline-tools/latest/bin/avdmanager'],
] as const)
  if (SDK && fs.existsSync(path.join(SDK, rel))) tools[n] = path.join(SDK, rel);
const OPT_IN = process.env['AUTOTEST_E2E_DEVICES'] === '1';
const IOS = OPT_IN && 'xcrun' in tools && spawnSync(tools['xcrun']!, ['simctl', 'help']).status === 0;
const ANDROID_IMAGE = SDK && fs.existsSync(path.join(SDK, 'system-images', 'android-36'));
const ANDROID = OPT_IN && 'adb' in tools && 'emulator' in tools && 'avdmanager' in tools && ANDROID_IMAGE;
const FREE_GB =
  Number(spawnSync('/bin/df', ['-k', os.homedir()], { encoding: 'utf8' }).stdout.split('\n')[1]?.split(/\s+/)[3] ?? 0) /
  1048576;

function server() {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-dev-')));
  fs.chmodSync(data, 0o700);
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nexecutables:\n${Object.entries(tools)
      .map(([n, p]) => `  ${n}: { path: ${p} }`)
      .join('\n')}\n`,
  );
  return composeServer({
    dataRoot: data,
    env: { ...process.env, AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'dev-host' },
    stderr: { write: () => true },
  });
}
type R = { structuredContent: Record<string, unknown>; isError?: boolean };
const sc = <T>(r: R) => r.structuredContent as T;
const err = (r: R) => (r.structuredContent as { error?: { code: string } }).error?.code;
const cleanup: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanup.reverse())
    try {
      c();
    } catch {
      // best effort: the device may already be gone
    }
});

describe.skipIf(!IOS)('DEV-001/002 iOS simulators (real simctl)', () => {
  it(
    'lists, creates an owned simulator, boots, erases and deletes it; never acts on one it does not own',
    { timeout: 600_000 },
    async () => {
      const c = await server();
      const list = sc<{ host: { simctl: boolean }; devices: { deviceId: string; owned: boolean }[] }>(
        (await c.call('list_devices', { platform: 'ios' })) as R,
      );
      expect(list.host.simctl).toBe(true);
      expect(list.devices.every((d) => !d.owned)).toBe(true);

      // A simulator created outside AutoTest with an AutoTest-like name: not owned, so destructive actions need approval.
      const spoof = execFileSync(tools['xcrun']!, ['simctl', 'create', 'autotest-spoofed-name', 'iPhone 17e'], {
        encoding: 'utf8',
      }).trim();
      cleanup.push(() => execFileSync(tools['xcrun']!, ['simctl', 'delete', spoof]));
      const listed = sc<{ devices: { deviceId: string; owned: boolean }[] }>(
        (await c.call('list_devices', { platform: 'ios' })) as R,
      );
      expect(listed.devices.find((d) => d.deviceId === spoof)).toMatchObject({ owned: false });
      for (const action of ['erase', 'delete', 'boot'])
        expect(err((await c.call('manage_simulator', { action, deviceId: spoof })) as R), action).toBe(
          'E_APPROVAL_REQUIRED',
        );

      const created = sc<{ deviceId: string; owned: boolean; leaseId: string; tierApplied: string }>(
        (await c.call('manage_simulator', {
          action: 'create',
          create: { platform: 'ios', deviceType: 'iPhone 17e', runtime: 'iOS 26.4' },
        })) as R,
      );
      expect(created).toMatchObject({ owned: true, tierApplied: 'P1' });
      expect(created.leaseId).toMatch(/^lease_/);
      cleanup.push(() => execFileSync(tools['xcrun']!, ['simctl', 'delete', created.deviceId]));
      const id = created.deviceId;
      expect(
        sc<{ state: string; result: string }>(
          (await c.call('manage_simulator', { action: 'boot', deviceId: id })) as R,
        ),
      ).toMatchObject({ state: 'Booted', result: 'done' });
      expect(
        sc<{ result: string }>((await c.call('manage_simulator', { action: 'boot', deviceId: id })) as R).result,
      ).toBe('already_in_state');
      expect(
        sc<{ state: string }>((await c.call('manage_simulator', { action: 'erase', deviceId: id })) as R).state,
      ).toBe('Shutdown');
      expect(
        sc<{ leaseId: string | null }>((await c.call('manage_simulator', { action: 'delete', deviceId: id })) as R)
          .leaseId,
      ).toBeNull();
      const after = sc<{ devices: { deviceId: string }[] }>((await c.call('list_devices', { platform: 'ios' })) as R);
      expect(after.devices.some((d) => d.deviceId === id)).toBe(false);
      expect(after.devices.some((d) => d.deviceId === spoof)).toBe(true);
      await c.close();
    },
  );
});

describe.skipIf(!ANDROID || FREE_GB < 8)('DEV-001/002 Android emulators (real emulator)', () => {
  it('creates an owned AVD, boots it headless, shuts it down and deletes it', { timeout: 900_000 }, async () => {
    const c = await server();
    const created = sc<{ deviceId: string; owned: boolean }>(
      (await c.call('manage_simulator', {
        action: 'create',
        create: { platform: 'android', deviceType: 'pixel_7', runtime: 'android-36' },
      })) as R,
    );
    expect(created.owned).toBe(true);
    cleanup.push(() =>
      execFileSync(tools['avdmanager']!, ['delete', 'avd', '-n', created.deviceId], { stdio: 'ignore' }),
    );
    const boot = (await c.call('manage_simulator', { action: 'boot', deviceId: created.deviceId })) as R;
    expect(sc<{ state: string }>(boot).state, JSON.stringify(boot.structuredContent)).toBe('Booted');
    const listed = sc<{ devices: { deviceId: string; state: string; owned: boolean }[] }>(
      (await c.call('list_devices', { platform: 'android' })) as R,
    );
    expect(listed.devices.find((d) => d.deviceId === created.deviceId)).toMatchObject({ state: 'Booted', owned: true });
    expect(
      sc<{ state: string }>((await c.call('manage_simulator', { action: 'shutdown', deviceId: created.deviceId })) as R)
        .state,
    ).toBe('Shutdown');
    expect(
      sc<{ state: string }>((await c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId })) as R)
        .state,
    ).toBe('Deleted');
    await c.close();
  });
});
