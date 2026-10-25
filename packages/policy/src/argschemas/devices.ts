/**
 * Argument schemas for the device tools (DEV-001, DEV-002; ADR-0014; T-10). Listing forms are `probe`; forms that
 * change a device are `device_tool`. Names AutoTest creates always match `autotest-…`, and identifiers are matched
 * exactly (UDIDs, `com.apple.CoreSimulator.*` ids, system-image package strings), so no form can reach a file, a
 * shell or another program. `adb` gets its target from `ANDROID_SERIAL` in the environment, never from argv.
 * Ownership is decided by the lease store, not by these names (TL-14).
 */
import type { ArgSchema, CommandForm } from './types.ts';

/** Names of devices AutoTest creates. */
export const OWNED_DEVICE_NAME = /^autotest-[a-z0-9-]{4,60}$/;
const UDID = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/;
const DEVICE_TYPE = /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]{1,100}$/;
const RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]{1,100}$/;
const SCREENSHOT = /^attempts\/\d{1,2}\/runner\/[a-z0-9_-]{1,64}\.png$/;
/** Any AVD name `emulator -list-avds` can print (booting one AutoTest does not own needs a P2 approval). */
const AVD_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SYSTEM_IMAGE = /^system-images;android-[0-9]{2,3}(?:\.[0-9])?;[a-z0-9_]{1,40};(?:arm64-v8a|x86_64)$/;
const HW_PROFILE = /^[a-z0-9_]{1,40}$/;
/** Even console ports 5554 – 5682 (the emulator's range). */
const PORT = /^(?:555[468]|55[6-9][02468]|56[0-7][02468]|568[02])$/;

const form = (id: string, cls: CommandForm['class'], words: readonly string[], extra: Partial<CommandForm> = {}) =>
  ({ id, class: cls, words: [...words], flags: [], requiredFlags: [], ...extra }) as CommandForm;
const udidAction = (action: string) =>
  form(`simctl.${action}`, 'device_tool', ['simctl', action], { positionals: [{ kind: 'word', pattern: UDID }] });

export const XCRUN_SCHEMA: ArgSchema = {
  executable: 'xcrun',
  forbiddenFlags: [],
  forms: [
    form('simctl.list_devices', 'probe', ['simctl', 'list', 'devices', '--json']),
    form('simctl.list_runtimes', 'probe', ['simctl', 'list', 'runtimes', '--json']),
    form('simctl.list_devicetypes', 'probe', ['simctl', 'list', 'devicetypes', '--json']),
    form('simctl.create', 'device_tool', ['simctl', 'create'], {
      positionals: [
        { kind: 'word', pattern: OWNED_DEVICE_NAME },
        { kind: 'word', pattern: DEVICE_TYPE },
        { kind: 'word', pattern: RUNTIME },
      ],
    }),
    udidAction('boot'),
    udidAction('shutdown'),
    udidAction('erase'),
    udidAction('delete'),
    form('simctl.bootstatus', 'probe', ['simctl', 'bootstatus'], {
      positionals: [{ kind: 'word', pattern: UDID }],
      flags: [{ name: '-b', value: { kind: 'none' } }],
      requiredFlags: ['-b'],
    }),
    // IOS-003: reading a run's result bundle (stdout is the JSON the adapter parses); test_runner like the run itself.
    form('xcresulttool.tests', 'test_runner', ['xcresulttool', 'get', 'test-results', 'tests'], {
      flags: [
        { name: '--path', value: { kind: 'runPath', prefix: '' } },
        { name: '--compact', value: { kind: 'none' } },
      ],
      requiredFlags: ['--path'],
    }),
    form('xcresulttool.build', 'test_runner', ['xcresulttool', 'get', 'build-results'], {
      flags: [
        { name: '--path', value: { kind: 'runPath', prefix: '' } },
        { name: '--compact', value: { kind: 'none' } },
      ],
      requiredFlags: ['--path'],
    }),
    form('simctl.screenshot', 'probe', ['simctl', 'io'], {
      positionals: [
        { kind: 'word', pattern: UDID },
        { kind: 'word', pattern: /^screenshot$/ },
        { kind: 'runPath', pattern: SCREENSHOT },
      ],
    }),
  ],
};

export const ADB_SCHEMA: ArgSchema = {
  executable: 'adb',
  forbiddenFlags: ['-s', '-H', '-P', '-L', '-a'],
  forms: [
    form('adb.version', 'probe', ['version']),
    form('adb.devices', 'probe', ['devices', '-l']),
    form('adb.boot_completed', 'probe', ['shell', 'getprop', 'sys.boot_completed']),
    form('adb.avd_name', 'probe', ['emu', 'avd', 'name']),
    form('adb.logcat_dump', 'probe', ['logcat', '-d']),
    form('adb.screencap', 'probe', ['exec-out', 'screencap', '-p']),
    form('adb.emu_kill', 'device_tool', ['emu', 'kill']),
  ],
};

export const EMULATOR_SCHEMA: ArgSchema = {
  executable: 'emulator',
  forbiddenFlags: ['-qemu', '-shell', '-shell-serial', '-http-proxy', '-dns-server', '-tcpdump', '-sdcard', '-kernel'],
  forms: [
    form('emulator.list_avds', 'probe', ['-list-avds']),
    form('emulator.boot', 'device_tool', [], {
      flags: [
        { name: '-avd', value: { kind: 'pattern', pattern: AVD_NAME } },
        { name: '-port', value: { kind: 'pattern', pattern: PORT } },
        { name: '-no-window', value: { kind: 'none' } },
        { name: '-no-snapshot', value: { kind: 'none' } },
        { name: '-no-audio', value: { kind: 'none' } },
        { name: '-no-boot-anim', value: { kind: 'none' } },
        { name: '-wipe-data', value: { kind: 'none' } },
        { name: '-partition-size', value: { kind: 'pattern', pattern: /^[0-9]{3,5}$/ } },
      ],
      requiredFlags: ['-avd', '-port', '-no-window'],
    }),
  ],
};

export const AVDMANAGER_SCHEMA: ArgSchema = {
  executable: 'avdmanager',
  forbiddenFlags: ['-p', '--path'],
  forms: [
    form('avdmanager.create', 'device_tool', ['create', 'avd'], {
      flags: [
        { name: '-n', value: { kind: 'pattern', pattern: OWNED_DEVICE_NAME } },
        { name: '-k', value: { kind: 'pattern', pattern: SYSTEM_IMAGE } },
        { name: '-d', value: { kind: 'pattern', pattern: HW_PROFILE } },
      ],
      requiredFlags: ['-n', '-k', '-d'],
    }),
    form('avdmanager.delete', 'device_tool', ['delete', 'avd'], {
      flags: [{ name: '-n', value: { kind: 'pattern', pattern: OWNED_DEVICE_NAME } }],
      requiredFlags: ['-n'],
    }),
  ],
};
