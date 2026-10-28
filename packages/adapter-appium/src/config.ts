/**
 * The project's Appium pin file, `.autotest/appium.json` (APM-001; ADR-0011 §3: version pinning is mandatory).
 * It is data, parsed and checked here; nothing in it is executed:
 *
 * ```json
 * {
 *   "serverVersion": "3.4.2",
 *   "drivers": [{ "name": "uiautomator2", "version": "8.7.0" }],
 *   "port": 4725,
 *   "platforms": ["android"],
 *   "runner": { "script": "appium/run-scenario.mjs", "cwd": ".", "passDevice": true, "passPort": true },
 *   "scenarios": { "list": "appium/scenario-list.json" },
 *   "specs": "appium/spec"
 * }
 * ```
 *
 * `scenarios` is `{ "list": <JSON file> }` or `{ "registry": <source file with case labels> }`.
 */
import type { AdapterWorkspace } from '@autotest/adapter-sdk';

export const CONFIG_FILE = '.autotest/appium.json';

export interface AppiumConfig {
  readonly serverVersion: string;
  readonly drivers: readonly { readonly name: string; readonly version: string }[];
  readonly port: number;
  readonly platforms: readonly ('ios' | 'android')[];
  readonly runner: {
    readonly script: string;
    readonly cwd: string;
    readonly passDevice: boolean;
    readonly passPort: boolean;
  };
  readonly scenarios: { readonly list?: string; readonly registry?: string };
  readonly specs?: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;
const REL = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9 ._@-]{1,100}(?:\/[A-Za-z0-9 ._@-]{1,100}){0,15}$/;

export type ConfigResult =
  { readonly ok: true; readonly config: AppiumConfig } | { readonly ok: false; readonly problem: string };

export function readAppiumConfig(ws: AdapterWorkspace): ConfigResult | undefined {
  if (!ws.exists(CONFIG_FILE)) return undefined;
  const r = ws.readText(CONFIG_FILE, 64 * 1024);
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    return { ok: false, problem: `${CONFIG_FILE} is not valid JSON` };
  }
  const bad = (what: string): ConfigResult => ({ ok: false, problem: `${CONFIG_FILE}: ${what}` });
  if (typeof v['serverVersion'] !== 'string' || !VERSION.test(v['serverVersion']))
    return bad('serverVersion must be an exact version');
  const drivers = v['drivers'];
  if (
    !Array.isArray(drivers) ||
    drivers.length === 0 ||
    !drivers.every(
      (d) =>
        typeof (d as { name?: unknown }).name === 'string' &&
        /^[a-z0-9-]{1,64}$/.test((d as { name: string }).name) &&
        typeof (d as { version?: unknown }).version === 'string' &&
        VERSION.test((d as { version: string }).version),
    )
  )
    return bad('drivers must list each driver with an exact version');
  const port = v['port'] ?? 4723;
  if (typeof port !== 'number' || port < 4723 || port > 4799) return bad('port must be 4723 – 4799');
  const platforms = (v['platforms'] ?? ['android', 'ios']) as unknown[];
  if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every((p) => p === 'ios' || p === 'android'))
    return bad('platforms must be "ios" and/or "android"');
  const runner = v['runner'] as Record<string, unknown> | undefined;
  if (
    !runner ||
    typeof runner['script'] !== 'string' ||
    !REL.test(runner['script']) ||
    !/\.(?:js|mjs|cjs)$/.test(runner['script'])
  )
    return bad('runner.script must be a workspace-relative .js/.mjs/.cjs file');
  const cwd = runner['cwd'] ?? '.';
  if (typeof cwd !== 'string' || (cwd !== '.' && !REL.test(cwd))) return bad('runner.cwd must be workspace-relative');
  const scen = v['scenarios'] as Record<string, unknown> | undefined;
  const list = scen?.['list'];
  const registry = scen?.['registry'];
  if ((typeof list !== 'string' || !REL.test(list)) && (typeof registry !== 'string' || !REL.test(registry)))
    return bad('scenarios needs a "list" or a "registry" file');
  const specs = v['specs'];
  if (specs !== undefined && (typeof specs !== 'string' || !REL.test(specs))) return bad('specs must be a folder');
  return {
    ok: true,
    config: {
      serverVersion: v['serverVersion'],
      drivers: (drivers as { name: string; version: string }[]).map((d) => ({ name: d.name, version: d.version })),
      port,
      platforms: [...new Set(platforms as ('ios' | 'android')[])],
      runner: {
        script: runner['script'],
        cwd,
        passDevice: runner['passDevice'] === true,
        passPort: runner['passPort'] === true,
      },
      scenarios: {
        ...(typeof list === 'string' ? { list } : {}),
        ...(typeof registry === 'string' ? { registry } : {}),
      },
      ...(typeof specs === 'string' ? { specs } : {}),
    },
  };
}

/** Compares the pin with what `appium --version` and `appium driver list --installed --json` reported. */
export function pinMismatches(config: AppiumConfig, serverVersion: string | undefined, installed: unknown): string[] {
  const out: string[] = [];
  if (serverVersion !== config.serverVersion)
    out.push(`Appium ${serverVersion ?? 'not found'} is installed, ${config.serverVersion} is pinned`);
  const drivers = (installed && typeof installed === 'object' ? installed : {}) as Record<
    string,
    { version?: unknown }
  >;
  for (const d of config.drivers) {
    const got = drivers[d.name]?.version;
    if (got !== d.version)
      out.push(`driver ${d.name} ${typeof got === 'string' ? got : 'not installed'}, ${d.version} is pinned`);
  }
  return out;
}
