/**
 * Parsers for device listings (DEV-001), checked against `fixtures/devices-corpus/` (Xcode 26.4.1, platform-tools 36).
 * Untrusted text: unknown fields are ignored and malformed input yields no devices, never an exception.
 */

export interface SimDevice {
  readonly udid: string;
  readonly name: string;
  /** `Booted`, `Shutdown`, `Booting`, `Shutting Down`, … */
  readonly state: string;
  /** e.g. `iOS 26.4`, from the runtime key. */
  readonly osVersion: string | null;
  readonly runtime: string;
  readonly available: boolean;
  /** B3: `com.apple.CoreSimulator.SimDeviceType.iPhone-17e`, when simctl reports it. */
  readonly deviceType: string | null;
}

/** `xcrun simctl list devices --json`: `{ devices: { <runtime id>: [ { udid, name, state, isAvailable } ] } }`. */
export function parseSimctlDevices(text: string): SimDevice[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const groups = (doc as { devices?: Record<string, unknown> })?.devices;
  if (!groups || typeof groups !== 'object') return [];
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue;
    const m = /SimRuntime\.([A-Za-z]+)-(\d+)(?:-(\d+))?/.exec(runtime);
    const osVersion = m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : null;
    for (const d of list as Record<string, unknown>[]) {
      if (typeof d?.['udid'] !== 'string' || typeof d['name'] !== 'string') continue;
      out.push({
        udid: d['udid'],
        name: d['name'].slice(0, 200),
        state: typeof d['state'] === 'string' ? d['state'] : 'unknown',
        osVersion,
        runtime,
        available: d['isAvailable'] === true,
        deviceType: typeof d['deviceTypeIdentifier'] === 'string' ? d['deviceTypeIdentifier'].slice(0, 200) : null,
      });
    }
  }
  return out;
}

export interface Named {
  readonly identifier: string;
  readonly name: string;
  /** Runtimes only (B3): the device type names the runtime supports, newest first as simctl lists them. */
  readonly supported?: readonly string[];
}

/** `simctl list runtimes --json` → available runtimes; `simctl list devicetypes --json` → device types. */
export function parseSimctlRuntimes(text: string): Named[] {
  try {
    const d = JSON.parse(text) as {
      runtimes?: { identifier?: unknown; name?: unknown; isAvailable?: unknown; supportedDeviceTypes?: unknown }[];
    };
    return (d.runtimes ?? [])
      .filter((r) => typeof r.identifier === 'string' && typeof r.name === 'string' && r.isAvailable !== false)
      .map((r) => {
        const supported = Array.isArray(r.supportedDeviceTypes)
          ? (r.supportedDeviceTypes as { name?: unknown }[])
              .map((t) => t?.name)
              .filter((n): n is string => typeof n === 'string')
              .slice(0, 200)
          : undefined;
        return { identifier: r.identifier as string, name: r.name as string, ...(supported ? { supported } : {}) };
      });
  } catch {
    return [];
  }
}

export function parseSimctlDeviceTypes(text: string): Named[] {
  try {
    const d = JSON.parse(text) as { devicetypes?: { identifier?: unknown; name?: unknown }[] };
    return (d.devicetypes ?? [])
      .filter((t) => typeof t.identifier === 'string' && typeof t.name === 'string')
      .map((t) => ({ identifier: t.identifier as string, name: t.name as string }));
  } catch {
    return [];
  }
}

export interface AdbDevice {
  readonly serial: string;
  /** `device`, `offline`, `unauthorized`, … */
  readonly state: string;
  readonly model: string | null;
  readonly emulator: boolean;
}

/** `adb devices -l`. */
export function parseAdbDevices(text: string): AdbDevice[] {
  return text
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      const m = /^(\S+)\s+(\S+)(.*)$/.exec(l);
      if (!m) return [];
      const model = /\bmodel:(\S+)/.exec(m[3] ?? '')?.[1] ?? null;
      return [{ serial: m[1]!, state: m[2]!, model, emulator: /^emulator-\d+$/.test(m[1]!) }];
    });
}

/**
 * B3: an AVD's hardware profile and API level from its `config.ini` (`hw.device.name`, `image.sysdir.1` such as
 * `system-images/android-36/google_apis/arm64-v8a/`).
 */
export function parseAvdConfig(text: string): { hardware: string | null; runtime: string | null } {
  const hardware = /^hw\.device\.name\s*=\s*([A-Za-z0-9_.-]{1,60})\s*$/m.exec(text)?.[1] ?? null;
  const api = /^image\.sysdir\.1\s*=\s*system-images[/\\]android-(\d{2,3}(?:\.\d)?)[/\\]/m.exec(text)?.[1];
  return { hardware, runtime: api ? `android-${api}` : null };
}

/** `emulator -list-avds`: one AVD name per line (log lines from the emulator start with a level tag). */
export function parseAvdList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9._-]{1,100}$/.test(l));
}
