import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, nodeFsPort, validateSpec, type ValidationContext } from '@autotest/policy';
import { tree } from './helpers.ts';

const nfs = nodeFsPort();
const bin = tree({
  'b/xcrun': '#!/bin/sh\n',
  'b/adb': '#!/bin/sh\n',
  'b/emulator': '#!/bin/sh\n',
  'b/avdmanager': '#!/bin/sh\n',
});
const runDir = tree({ 'attempts/1/runner/.keep': '' });
const ctx: ValidationContext = {
  fs: nfs,
  registry: buildRegistry(
    nfs,
    Object.fromEntries(['xcrun', 'adb', 'emulator', 'avdmanager'].map((n) => [n, { path: path.join(bin, 'b', n) }])),
  ),
  workspaceRoot: runDir,
  runDir,
  allowDependencyResolution: false,
};
const w = (value: string): ArgToken => ({ kind: 'word', value });
const f = (name: string, value?: string): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
});
const spec = (executable: string, ...args: ArgToken[]): ExecutionSpec => ({
  executable,
  args,
  cwd: '.',
  envNeeds: [],
  expectedOutputs: [],
  timeoutMs: 60_000,
  cancellation: 'process_group',
  requires: { host: 'any', device: 'none' },
});
const ok = (s: ExecutionSpec) => validateSpec(s, ctx).ok;
const UDID = 'A59793A1-207D-4223-9A07-7A25E3124218';

describe('DEV-001/002 device argument schemas', () => {
  it('accepts the listing, lifecycle and capture forms', () => {
    expect(ok(spec('xcrun', w('simctl'), w('list'), w('devices'), w('--json')))).toBe(true);
    expect(
      ok(
        spec(
          'xcrun',
          w('simctl'),
          w('create'),
          w('autotest-01m5q9'),
          w('com.apple.CoreSimulator.SimDeviceType.iPhone-17e'),
          w('com.apple.CoreSimulator.SimRuntime.iOS-26-4'),
        ),
      ),
    ).toBe(true);
    for (const a of ['boot', 'shutdown', 'erase', 'delete'])
      expect(ok(spec('xcrun', w('simctl'), w(a), w(UDID))), a).toBe(true);
    expect(ok(spec('xcrun', w('simctl'), w('bootstatus'), w(UDID), f('-b')))).toBe(true);
    expect(
      ok(
        spec('xcrun', w('simctl'), w('io'), w(UDID), w('screenshot'), {
          kind: 'runPath',
          rel: 'attempts/1/runner/fail_1.png',
        }),
      ),
    ).toBe(true);
    expect(ok(spec('adb', w('devices'), w('-l')))).toBe(true);
    expect(ok(spec('adb', w('emu'), w('kill')))).toBe(true);
    expect(ok(spec('emulator', w('-list-avds')))).toBe(true);
    expect(
      ok(spec('emulator', f('-avd', 'autotest-a1b2'), f('-port', '5584'), f('-no-window'), f('-no-snapshot'))),
    ).toBe(true);
    expect(
      ok(
        spec(
          'avdmanager',
          w('create'),
          w('avd'),
          f('-n', 'autotest-a1b2'),
          f('-k', 'system-images;android-36;google_apis_playstore;arm64-v8a'),
          f('-d', 'pixel_7'),
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ['a create name AutoTest would not use', spec('xcrun', w('simctl'), w('create'), w('My Phone'), w('x'), w('y'))],
    ['a lowercase or short UDID', spec('xcrun', w('simctl'), w('erase'), w('a59793a1'))],
    ['simctl spawn (runs a program on the device)', spec('xcrun', w('simctl'), w('spawn'), w(UDID), w('launchctl'))],
    ['another xcrun tool', spec('xcrun', w('clang'), w('-v'))],
    [
      'a screenshot outside the run',
      spec('xcrun', w('simctl'), w('io'), w(UDID), w('screenshot'), { kind: 'runPath', rel: '../x.png' }),
    ],
    ['adb shell with a command', spec('adb', w('shell'), w('rm'), w('-rf'), w('/sdcard'))],
    ['adb install', spec('adb', w('install'), w('x.apk'))],
    ['adb -s in argv', spec('adb', f('-s', 'emulator-5554'), w('devices'), w('-l'))],
    ['an odd emulator port', spec('emulator', f('-avd', 'x'), f('-port', '5585'), f('-no-window'))],
    [
      'an emulator -qemu passthrough',
      spec('emulator', f('-avd', 'x'), f('-port', '5584'), f('-no-window'), f('-qemu', '-x')),
    ],
    [
      'an AVD created under another name',
      spec(
        'avdmanager',
        w('create'),
        w('avd'),
        f('-n', 'Pixel'),
        f('-k', 'system-images;android-36;google_apis;arm64-v8a'),
        f('-d', 'pixel_7'),
      ),
    ],
    ['deleting an AVD AutoTest did not name', spec('avdmanager', w('delete'), w('avd'), f('-n', 'Medium_Phone'))],
  ])('denies %s', (_name, s) => expect(ok(s)).toBe(false));
});
