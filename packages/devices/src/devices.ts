/**
 * Device listing and lifecycle (DEV-001 `list_devices`, DEV-002 `manage_simulator` mechanics). This module only runs
 * the allowlisted tools; ownership, leases, approvals and audit are decided by the workflow before it is called.
 *
 * Device ids: an iOS simulator is its UDID; an Android emulator is its AVD name (stable across boots; its running
 * serial `emulator-<port>` is looked up when needed); a physical Android device is its adb serial.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseAdbDevices,
  parseAvdConfig,
  parseAvdList,
  parseSimctlDevices,
  parseSimctlDeviceTypes,
  parseSimctlRuntimes,
} from './parse.ts';
import { flag, runTool, startDetached, word, type DeviceContext, type ToolResult } from './runner.ts';

export type Platform = 'ios' | 'android';

export interface ListedDevice {
  readonly deviceId: string;
  readonly platform: Platform;
  readonly kind: 'simulator' | 'emulator' | 'physical';
  readonly name: string;
  readonly osVersion: string | null;
  readonly state: string;
  readonly usable: boolean;
  /** B3: the device type (simulator type identifier, or the AVD hardware profile), when known. */
  readonly deviceType: string | null;
  /** B3: the runtime (`iOS 26.4`, or `android-36` from the AVD config), when known. */
  readonly runtime: string | null;
}

export interface Listing {
  readonly host: { readonly os: string; readonly simctl: boolean; readonly adb: boolean; readonly emulator: boolean };
  readonly devices: readonly ListedDevice[];
  readonly unsupported: readonly { readonly platform: string; readonly reason: string }[];
}

export type Outcome =
  | { readonly ok: true; readonly deviceId: string; readonly state: string; readonly changed: boolean }
  | {
      readonly ok: false;
      readonly reason: 'unavailable' | 'tool_missing' | 'denied' | 'timeout' | 'failed' | 'not_found';
      readonly message: string;
    };

const fail = (reason: Extract<Outcome, { ok: false }>['reason'], message: string): Outcome => ({
  ok: false,
  reason,
  message,
});
const done = (deviceId: string, state: string, changed = true): Outcome => ({ ok: true, deviceId, state, changed });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UDID = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/;

export const platformOf = (deviceId: string): Platform => (UDID.test(deviceId) ? 'ios' : 'android');

function toolProblem(r: ToolResult, what: string): Outcome | undefined {
  if (r.status === 'missing') return fail('tool_missing', `${what} is not allowlisted (\`autotest setup\` adds it)`);
  if (r.status === 'denied') return fail('denied', `${what} was refused by policy (${r.codes.join(', ')})`);
  if (r.exitCode === 124) return fail('timeout', `${what} timed out`);
  return undefined;
}

// ------------------------------------------------------------------ listing

/** An AVD's `config.ini` (read only; `ANDROID_AVD_HOME` or `~/.android/avd`). */
function avdConfig(ctx: DeviceContext, name: string): { hardware: string | null; runtime: string | null } {
  const home =
    ctx.parentEnv['ANDROID_AVD_HOME'] ??
    path.join(ctx.parentEnv['ANDROID_EMULATOR_HOME'] ?? path.join(ctx.parentEnv['HOME'] ?? '', '.android'), 'avd');
  try {
    return parseAvdConfig(fs.readFileSync(path.join(home, `${name}.avd`, 'config.ini'), 'utf8'));
  } catch {
    return { hardware: null, runtime: null };
  }
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^com\.apple\.coresimulator\.simdevicetype\./, '')
    .replace(/[^a-z0-9]/g, '');

/**
 * B3: whether a listed device matches an acquire request. A device type matches the simulator type (`iPhone 17e` ≙
 * `…SimDeviceType.iPhone-17e`) or the AVD hardware profile (`pixel_7`); a runtime matches `iOS 26.4` or `android-36`.
 * Unknown device facts never match a stated requirement.
 */
export function matchesRequest(
  d: ListedDevice,
  q: { readonly deviceType?: string; readonly runtime?: string },
): boolean {
  if (q.deviceType && (!d.deviceType || norm(d.deviceType) !== norm(q.deviceType))) return false;
  if (q.runtime && (!d.runtime || norm(d.runtime) !== norm(q.runtime))) return false;
  return true;
}

/**
 * B3: what to create when an acquire request names nothing: the newest available iOS runtime with the newest iPhone
 * type it supports, or the newest installed Android system image with the `pixel_7` profile. Undefined when nothing is installed.
 */
export async function defaultDeviceSpec(
  ctx: DeviceContext,
  platform: Platform,
): Promise<{ deviceType: string; runtime: string } | undefined> {
  const num = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  if (platform === 'ios') {
    const types = await runTool(ctx, 'xcrun', [word('simctl'), word('list'), word('devicetypes'), word('--json')]);
    const rts = await runTool(ctx, 'xcrun', [word('simctl'), word('list'), word('runtimes'), word('--json')]);
    if (types.status !== 'ok' || rts.status !== 'ok') return undefined;
    const runtime = parseSimctlRuntimes(rts.stdout)
      .filter((r) => /^iOS \d/.test(r.name))
      .sort((a, b) => newer(num(b.name), num(a.name)))[0];
    // The runtime lists the types it supports newest first; the devicetypes list is not in release order.
    const phone =
      runtime?.supported?.find((n) => /^iPhone \d/.test(n)) ??
      parseSimctlDeviceTypes(types.stdout).find((t) => /^iPhone \d/.test(t.name))?.name;
    return runtime && phone ? { deviceType: phone, runtime: runtime.name } : undefined;
  }
  const sdk = ctx.parentEnv['ANDROID_HOME'] ?? ctx.parentEnv['ANDROID_SDK_ROOT'];
  if (!sdk) return undefined;
  let levels: string[];
  try {
    levels = fs.readdirSync(path.join(sdk, 'system-images')).filter((l) => /^android-\d{2,3}$/.test(l));
  } catch {
    return undefined;
  }
  const level = levels.filter((l) => resolveSystemImage(sdk, l) !== undefined).sort((a, b) => newer(num(b), num(a)))[0];
  return level ? { deviceType: 'pixel_7', runtime: level } : undefined;
}

async function iosDevices(ctx: DeviceContext): Promise<{ list: ListedDevice[]; problem?: string; tool: boolean }> {
  const r = await runTool(ctx, 'xcrun', [word('simctl'), word('list'), word('devices'), word('--json')], {
    timeoutMs: 15_000,
  });
  if (r.status !== 'ok')
    return {
      list: [],
      problem: r.status === 'missing' ? 'xcrun is not on the policy allowlist' : 'xcrun simctl was refused by policy',
      tool: false,
    };
  if (r.exitCode !== 0) return { list: [], problem: `simctl failed (exit ${r.exitCode})`, tool: true };
  return {
    tool: true,
    list: parseSimctlDevices(r.stdout).map((d) => ({
      deviceId: d.udid,
      platform: 'ios',
      kind: 'simulator',
      name: d.name,
      osVersion: d.osVersion,
      state: d.state,
      usable: d.available,
      deviceType: d.deviceType,
      runtime: d.osVersion,
    })),
  };
}

/** The AVD name of a running emulator serial (`adb emu avd name` prints it, then `OK`). */
async function avdNameOf(ctx: DeviceContext, serial: string): Promise<string | undefined> {
  const r = await runTool(ctx, 'adb', [word('emu'), word('avd'), word('name')], { serial, timeoutMs: 10_000 });
  return r.status === 'ok' && r.exitCode === 0 ? r.stdout.split('\n')[0]?.trim() || undefined : undefined;
}

/** Running emulators by AVD name → serial, and physical devices. */
async function adbState(ctx: DeviceContext) {
  const r = await runTool(ctx, 'adb', [word('devices'), word('-l')], { timeoutMs: 15_000 });
  if (r.status !== 'ok' || r.exitCode !== 0)
    return {
      tool: r.status === 'ok',
      running: new Map<string, string>(),
      physical: [] as ReturnType<typeof parseAdbDevices>,
    };
  const all = parseAdbDevices(r.stdout);
  const running = new Map<string, string>();
  for (const d of all.filter((x) => x.emulator && x.state === 'device')) {
    const name = await avdNameOf(ctx, d.serial);
    if (name) running.set(name, d.serial);
  }
  return { tool: true, running, physical: all.filter((x) => !x.emulator) };
}

async function androidDevices(
  ctx: DeviceContext,
): Promise<{ list: ListedDevice[]; problems: string[]; adb: boolean; emulator: boolean }> {
  const problems: string[] = [];
  const avds = await runTool(ctx, 'emulator', [word('-list-avds')], { timeoutMs: 15_000 });
  const emulatorOk = avds.status === 'ok' && avds.exitCode === 0;
  if (avds.status === 'missing') problems.push('emulator is not on the policy allowlist');
  const state = await adbState(ctx);
  if (!state.tool) problems.push('adb is not on the policy allowlist');
  const list: ListedDevice[] = [];
  for (const name of emulatorOk ? parseAvdList(avds.stdout) : []) {
    const info = avdConfig(ctx, name);
    list.push({
      deviceId: name,
      platform: 'android',
      kind: 'emulator',
      name,
      osVersion: info.runtime,
      state: state.running.has(name) ? 'Booted' : 'Shutdown',
      usable: true,
      deviceType: info.hardware,
      runtime: info.runtime,
    });
  }
  for (const d of state.physical)
    list.push({
      deviceId: d.serial,
      platform: 'android',
      kind: 'physical',
      name: d.model ?? d.serial,
      osVersion: null,
      state: d.state,
      usable: d.state === 'device',
      deviceType: null,
      runtime: null,
    });
  return { list, problems, adb: state.tool, emulator: emulatorOk };
}

export async function listDevices(ctx: DeviceContext, platform: Platform | 'all', hostOs: string): Promise<Listing> {
  const unsupported: { platform: string; reason: string }[] = [];
  const devices: ListedDevice[] = [];
  let simctl = false;
  let adb = false;
  let emulator = false;
  if (platform !== 'android') {
    if (hostOs !== 'macos') unsupported.push({ platform: 'ios', reason: 'iOS simulators need macOS' });
    else {
      const ios = await iosDevices(ctx);
      simctl = ios.tool;
      devices.push(...ios.list);
      if (ios.problem) unsupported.push({ platform: 'ios', reason: ios.problem });
    }
  }
  if (platform !== 'ios') {
    const a = await androidDevices(ctx);
    adb = a.adb;
    emulator = a.emulator;
    devices.push(...a.list);
    for (const p of a.problems) unsupported.push({ platform: 'android', reason: p });
  }
  return { host: { os: hostOs, simctl, adb, emulator }, devices, unsupported };
}

// ------------------------------------------------------------------ iOS lifecycle

async function iosState(ctx: DeviceContext, udid: string): Promise<string | undefined> {
  const ios = await iosDevices(ctx);
  return ios.list.find((d) => d.deviceId === udid)?.state;
}

function pick(list: readonly { identifier: string; name: string }[], q: string) {
  const n = q.trim().toLowerCase();
  return list.find((x) => x.identifier.toLowerCase() === n || x.name.toLowerCase() === n);
}

export async function iosCreate(
  ctx: DeviceContext,
  name: string,
  deviceType: string,
  runtime: string,
): Promise<Outcome> {
  const types = await runTool(ctx, 'xcrun', [word('simctl'), word('list'), word('devicetypes'), word('--json')]);
  const rts = await runTool(ctx, 'xcrun', [word('simctl'), word('list'), word('runtimes'), word('--json')]);
  const p = toolProblem(types, 'xcrun simctl') ?? toolProblem(rts, 'xcrun simctl');
  if (p) return p;
  const t = types.status === 'ok' ? pick(parseSimctlDeviceTypes(types.stdout), deviceType) : undefined;
  const r = rts.status === 'ok' ? pick(parseSimctlRuntimes(rts.stdout), runtime) : undefined;
  if (!t) return fail('not_found', `no simulator device type "${deviceType}" (simctl list devicetypes)`);
  if (!r) return fail('not_found', `no installed runtime "${runtime}" (simctl list runtimes)`);
  const c = await runTool(ctx, 'xcrun', [
    word('simctl'),
    word('create'),
    word(name),
    word(t.identifier),
    word(r.identifier),
  ]);
  const cp = toolProblem(c, 'simctl create');
  if (cp) return cp;
  const udid = c.status === 'ok' ? c.stdout.trim() : '';
  if (c.status !== 'ok' || c.exitCode !== 0 || !UDID.test(udid))
    return fail('failed', `simctl create failed: ${c.status === 'ok' ? c.stderr.slice(0, 300) : ''}`);
  return done(udid, 'Shutdown');
}

async function simctl(
  ctx: DeviceContext,
  action: string,
  udid: string,
  timeoutMs = 60_000,
): Promise<Outcome | undefined> {
  const r = await runTool(ctx, 'xcrun', [word('simctl'), word(action), word(udid)], { timeoutMs });
  const p = toolProblem(r, `simctl ${action}`);
  if (p) return p;
  if (r.status === 'ok' && r.exitCode !== 0)
    return fail('failed', `simctl ${action} failed: ${r.stderr.slice(0, 300)}`);
  return undefined;
}

export async function iosBoot(ctx: DeviceContext, udid: string): Promise<Outcome> {
  const state = await iosState(ctx, udid);
  if (!state) return fail('not_found', `no simulator ${udid}`);
  if (state === 'Booted') return done(udid, state, false);
  const p = await simctl(ctx, 'boot', udid);
  if (p) return p;
  const s = await runTool(ctx, 'xcrun', [word('simctl'), word('bootstatus'), word(udid), flag('-b')], {
    timeoutMs: 180_000,
  });
  const sp = toolProblem(s, 'simctl bootstatus');
  if (sp) return sp;
  return done(udid, (await iosState(ctx, udid)) ?? 'Booted');
}

/**
 * B3: waits until a simulator reported `Booted` has finished booting (`simctl bootstatus -b`). A simulator someone just
 * booted is listed as Booted before it can run apps, and a test runner started too early may never finish.
 */
export async function iosWaitBooted(ctx: DeviceContext, udid: string): Promise<Outcome> {
  const s = await runTool(ctx, 'xcrun', [word('simctl'), word('bootstatus'), word(udid), flag('-b')], {
    timeoutMs: 180_000,
  });
  return toolProblem(s, 'simctl bootstatus') ?? done(udid, 'Booted', false);
}

export async function iosShutdown(ctx: DeviceContext, udid: string): Promise<Outcome> {
  const state = await iosState(ctx, udid);
  if (!state) return fail('not_found', `no simulator ${udid}`);
  if (state === 'Shutdown') return done(udid, state, false);
  return (await simctl(ctx, 'shutdown', udid)) ?? done(udid, 'Shutdown');
}

export async function iosErase(ctx: DeviceContext, udid: string): Promise<Outcome> {
  const down = await iosShutdown(ctx, udid);
  if (!down.ok) return down;
  return (await simctl(ctx, 'erase', udid)) ?? done(udid, 'Shutdown');
}

export async function iosDelete(ctx: DeviceContext, udid: string): Promise<Outcome> {
  const down = await iosShutdown(ctx, udid);
  if (!down.ok) return down;
  return (await simctl(ctx, 'delete', udid)) ?? done(udid, 'Deleted');
}

/** A failure screenshot of a booted simulator into `<runDir>/<rel>` (rel: `attempts/<n>/runner/<name>.png`). */
export async function iosScreenshot(ctx: DeviceContext, udid: string, runDir: string, rel: string): Promise<boolean> {
  const r = await runTool(
    ctx,
    'xcrun',
    [word('simctl'), word('io'), word(udid), word('screenshot'), { kind: 'runPath', rel }],
    { runDir, timeoutMs: 30_000 },
  );
  return r.status === 'ok' && r.exitCode === 0 && fs.existsSync(path.join(runDir, rel));
}

// ------------------------------------------------------------------ Android lifecycle

/** Resolves `android-36` (or a full `system-images;…` id) to an installed system image for this host's ABI. */
export function resolveSystemImage(
  sdkRoot: string | undefined,
  runtime: string,
  arch = process.arch,
): string | undefined {
  if (/^system-images;/.test(runtime)) return runtime;
  const level = /^android-(\d{2,3}(?:\.\d)?)$/.exec(runtime.trim())?.[1];
  if (!level || !sdkRoot) return undefined;
  const abi = arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const base = path.join(sdkRoot, 'system-images', `android-${level}`);
  if (!fs.existsSync(base)) return undefined;
  const tags = fs.readdirSync(base).filter((t) => fs.existsSync(path.join(base, t, abi)));
  const tag = ['google_apis', 'google_apis_playstore', 'default'].find((t) => tags.includes(t)) ?? tags[0];
  return tag ? `system-images;android-${level};${tag};${abi}` : undefined;
}

export async function androidCreate(
  ctx: DeviceContext,
  name: string,
  hardware: string,
  runtime: string,
): Promise<Outcome> {
  const image = resolveSystemImage(ctx.parentEnv['ANDROID_HOME'] ?? ctx.parentEnv['ANDROID_SDK_ROOT'], runtime);
  if (!image) return fail('not_found', `no installed system image for "${runtime}" (install it with sdkmanager)`);
  const r = await runTool(
    ctx,
    'avdmanager',
    [word('create'), word('avd'), flag('-n', name), flag('-k', image), flag('-d', hardware)],
    { timeoutMs: 120_000 },
  );
  const p = toolProblem(r, 'avdmanager');
  if (p) return p;
  if (r.status === 'ok' && r.exitCode !== 0)
    return fail('failed', `avdmanager create failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return done(name, 'Shutdown');
}

async function runningSerial(ctx: DeviceContext, avd: string): Promise<string | undefined> {
  return (await adbState(ctx)).running.get(avd);
}

async function avdExists(ctx: DeviceContext, avd: string): Promise<boolean> {
  const r = await runTool(ctx, 'emulator', [word('-list-avds')], { timeoutMs: 15_000 });
  return r.status === 'ok' && parseAvdList(r.stdout).includes(avd);
}

async function freePort(ctx: DeviceContext): Promise<string | undefined> {
  const r = await runTool(ctx, 'adb', [word('devices'), word('-l')], { timeoutMs: 15_000 });
  const used = new Set(r.status === 'ok' ? parseAdbDevices(r.stdout).map((d) => d.serial) : []);
  for (let p = 5554; p <= 5682; p += 2) if (!used.has(`emulator-${p}`)) return String(p);
  return undefined;
}

export async function androidBoot(
  ctx: DeviceContext,
  avd: string,
  o: { readonly wipe?: boolean } = {},
): Promise<Outcome> {
  if (!(await avdExists(ctx, avd))) return fail('not_found', `no AVD ${avd}`);
  if (!o.wipe && (await runningSerial(ctx, avd))) return done(avd, 'Booted', false);
  const port = await freePort(ctx);
  if (!port) return fail('unavailable', 'no free emulator port (5554–5682)');
  const log = path.join(ctx.workDir, `emulator-${avd}.log`);
  fs.rmSync(log, { force: true });
  const started = startDetached(
    ctx,
    'emulator',
    [
      flag('-avd', avd),
      flag('-port', port),
      flag('-no-window'),
      flag('-no-snapshot'),
      flag('-no-audio'),
      flag('-no-boot-anim'),
      ...(o.wipe ? [flag('-wipe-data')] : []),
    ],
    log,
  );
  if (started.status !== 'ok')
    return started.status === 'missing'
      ? fail('tool_missing', 'emulator is not allowlisted')
      : fail('denied', `emulator refused by policy (${started.codes.join(', ')})`);
  const serial = `emulator-${port}`;
  const end = Date.now() + 180_000;
  while (Date.now() < end) {
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    const fatal = /FATAL\s*\|\s*(.+)/.exec(text);
    if (fatal) return fail('unavailable', `the emulator did not start: ${fatal[1]!.slice(0, 200)}`);
    const r = await runTool(ctx, 'adb', [word('shell'), word('getprop'), word('sys.boot_completed')], {
      serial,
      timeoutMs: 10_000,
    });
    if (r.status === 'ok' && r.stdout.trim() === '1') return done(avd, 'Booted');
    await sleep(2000);
  }
  return fail('timeout', `${avd} did not finish booting within 180 s`);
}

export async function androidShutdown(ctx: DeviceContext, avd: string): Promise<Outcome> {
  const serial = await runningSerial(ctx, avd);
  if (!serial) return (await avdExists(ctx, avd)) ? done(avd, 'Shutdown', false) : fail('not_found', `no AVD ${avd}`);
  const r = await runTool(ctx, 'adb', [word('emu'), word('kill')], { serial, timeoutMs: 30_000 });
  const p = toolProblem(r, 'adb emu kill');
  if (p) return p;
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1000))
    if (!(await runningSerial(ctx, avd))) return done(avd, 'Shutdown');
  return fail('timeout', `${avd} is still running 60 s after adb emu kill`);
}

export async function androidErase(ctx: DeviceContext, avd: string): Promise<Outcome> {
  const down = await androidShutdown(ctx, avd);
  if (!down.ok) return down;
  // Wiping user data needs one boot with -wipe-data; the device is shut down again afterwards.
  const wiped = await androidBoot(ctx, avd, { wipe: true });
  if (!wiped.ok) return wiped;
  const again = await androidShutdown(ctx, avd);
  return again.ok ? done(avd, 'Shutdown') : again;
}

export async function androidDelete(ctx: DeviceContext, avd: string): Promise<Outcome> {
  const down = await androidShutdown(ctx, avd);
  if (!down.ok) return down;
  const r = await runTool(ctx, 'avdmanager', [word('delete'), word('avd'), flag('-n', avd)], { timeoutMs: 60_000 });
  const p = toolProblem(r, 'avdmanager');
  if (p) return p;
  if (r.status === 'ok' && r.exitCode !== 0)
    return fail('failed', `avdmanager delete failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return done(avd, 'Deleted');
}

/**
 * Installs an app built beforehand on a booted device (RN-003): `simctl install <udid> <ws>/….app` or, for an
 * emulator, `adb install -r <ws>/….apk` with ANDROID_SERIAL. `appPath` is workspace-relative; policy resolves it
 * inside `workspaceRoot` and refuses anything else.
 */
export async function installApp(
  ctx: DeviceContext,
  deviceId: string,
  workspaceRoot: string,
  appPath: string,
): Promise<Outcome> {
  const ios = platformOf(deviceId) === 'ios';
  if (ios ? !appPath.endsWith('.app') : !appPath.endsWith('.apk'))
    return fail('failed', ios ? 'a simulator installs a .app bundle' : 'an emulator installs a .apk package');
  const serial = ios ? undefined : await runningSerial(ctx, deviceId);
  if (!ios && !serial) return fail('unavailable', `${deviceId} has no running emulator`);
  const app = { kind: 'workspacePath' as const, rel: appPath };
  const r = ios
    ? await runTool(ctx, 'xcrun', [word('simctl'), word('install'), word(deviceId), app], {
        workspaceRoot,
        timeoutMs: 300_000,
      })
    : await runTool(ctx, 'adb', [word('install'), word('-r'), app], {
        serial: serial!,
        workspaceRoot,
        timeoutMs: 300_000,
      });
  const p = toolProblem(r, ios ? 'simctl install' : 'adb install');
  if (p) return p;
  if (r.status === 'ok' && (r.exitCode !== 0 || /Failure \[/.test(r.stdout)))
    return fail('failed', `install failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return done(deviceId, 'Booted');
}

/** Serial of a booted emulator (runs address it through ANDROID_SERIAL). */
export const androidSerial = runningSerial;

/** `adb logcat -d` of a running emulator into `file`. */
export async function androidLogcat(ctx: DeviceContext, serial: string, file: string): Promise<boolean> {
  const r = await runTool(ctx, 'adb', [word('logcat'), word('-d')], { serial, stdoutFile: file, timeoutMs: 30_000 });
  return r.status === 'ok' && r.exitCode === 0;
}

/** A PNG screenshot of a running emulator into `file`. */
export async function androidScreenshot(ctx: DeviceContext, serial: string, file: string): Promise<boolean> {
  const r = await runTool(ctx, 'adb', [word('exec-out'), word('screencap'), word('-p')], {
    serial,
    stdoutFile: file,
    timeoutMs: 30_000,
  });
  return r.status === 'ok' && r.exitCode === 0;
}
