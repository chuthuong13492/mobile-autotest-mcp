import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchesRequest,
  parseAvdConfig,
  parseAdbDevices,
  parseAvdList,
  parseSimctlDevices,
  parseSimctlDeviceTypes,
  parseSimctlRuntimes,
  platformOf,
  resolveSystemImage,
} from '@autotest/devices';

const corpus = (f: string) =>
  fs.readFileSync(path.join(import.meta.dirname, '../../../fixtures/devices-corpus', f), 'utf8');

describe('DEV-001 device listing parsers (Xcode 26.4.1, platform-tools)', () => {
  it('reads simulators with their runtime, state and availability', () => {
    const devices = parseSimctlDevices(corpus('simctl-devices.json'));
    expect(devices.length).toBe(11);
    expect(devices.find((d) => d.name === 'autotest-spike-ios')).toMatchObject({
      udid: 'A59793A1-207D-4223-9A07-7A25E3124218',
      state: 'Booted',
      osVersion: 'iOS 26.4',
      available: true,
    });
    expect(new Set(devices.map((d) => d.osVersion))).toEqual(new Set(['iOS 26.4', 'iOS 18.1', 'iOS 26.3', 'iOS 15.5']));
  });

  it('reads runtimes and device types', () => {
    expect(parseSimctlRuntimes(corpus('simctl-runtimes.json')).map((r) => r.name)).toContain('iOS 26.4');
    expect(parseSimctlDeviceTypes(corpus('simctl-devicetypes.json'))).toContainEqual({
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17e',
      name: 'iPhone 17e',
    });
  });

  it('reads adb devices and AVD names, and ignores noise', () => {
    expect(parseAdbDevices(corpus('adb-devices.txt'))).toEqual([
      { serial: 'emulator-5584', state: 'device', model: 'sdk_gphone64_arm64', emulator: true },
    ]);
    expect(parseAdbDevices('List of devices attached\nR58M123ABC\tunauthorized usb:1-1 transport_id:3\n\n')).toEqual([
      { serial: 'R58M123ABC', state: 'unauthorized', model: null, emulator: false },
    ]);
    expect(parseAvdList(corpus('emulator-list-avds.txt'))).toEqual(['Medium_Phone', 'autotest-spike-android']);
    expect(parseAvdList('INFO    | Storing crashdata\nPixel_7\n')).toEqual(['Pixel_7']);
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', 'not json', '{"devices": 3}', '{"devices": {"x": [{"udid": 1}]}}']) {
      expect(parseSimctlDevices(bad)).toEqual([]);
      expect(parseSimctlRuntimes(bad)).toEqual([]);
    }
  });

  it('tells simulators from emulators by id, and resolves system images per ABI', () => {
    expect(platformOf('A59793A1-207D-4223-9A07-7A25E3124218')).toBe('ios');
    expect(platformOf('autotest-a1b2')).toBe('android');
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-sdk-'));
    fs.mkdirSync(path.join(sdk, 'system-images/android-36/google_apis_playstore/arm64-v8a'), { recursive: true });
    fs.mkdirSync(path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a'), { recursive: true });
    expect(resolveSystemImage(sdk, 'android-36', 'arm64')).toBe('system-images;android-36;google_apis;arm64-v8a');
    expect(resolveSystemImage(sdk, 'android-36', 'x64')).toBeUndefined();
    expect(resolveSystemImage(sdk, 'android-99', 'arm64')).toBeUndefined();
    expect(resolveSystemImage(sdk, 'system-images;android-35;default;x86_64')).toBe(
      'system-images;android-35;default;x86_64',
    );
  });
});

describe('B3 device matching facts', () => {
  it('reads AVD hardware and API level, runtime-supported types, and matches requests', () => {
    expect(
      parseAvdConfig('hw.device.name=pixel_7\nimage.sysdir.1=system-images/android-36/google_apis/arm64-v8a/\n'),
    ).toEqual({ hardware: 'pixel_7', runtime: 'android-36' });
    expect(parseAvdConfig('avd.ini.encoding=UTF-8\n')).toEqual({ hardware: null, runtime: null });
    const rts = parseSimctlRuntimes(
      JSON.stringify({
        runtimes: [
          {
            identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
            name: 'iOS 26.4',
            isAvailable: true,
            supportedDeviceTypes: [{ name: 'iPhone 17 Pro' }, { name: 'iPhone 11' }],
          },
        ],
      }),
    );
    expect(rts[0]!.supported).toEqual(['iPhone 17 Pro', 'iPhone 11']);
    const sim = {
      deviceId: 'X',
      platform: 'ios' as const,
      kind: 'simulator' as const,
      name: 'Mine',
      osVersion: 'iOS 26.4',
      state: 'Booted',
      usable: true,
      deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      runtime: 'iOS 26.4',
    };
    expect(matchesRequest(sim, {})).toBe(true);
    expect(matchesRequest(sim, { deviceType: 'iPhone 17 Pro', runtime: 'iOS 26.4' })).toBe(true);
    expect(matchesRequest(sim, { deviceType: 'iPhone 17 Pro Max' })).toBe(false);
    expect(matchesRequest({ ...sim, deviceType: null }, { deviceType: 'iPhone 17 Pro' })).toBe(false);
  });
});
