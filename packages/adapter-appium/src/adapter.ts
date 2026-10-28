/**
 * Optional Appium adapter (APM-001, APM-002; platform-adapters §Appium; ADR-0011). Verified with Appium 3.4.2 and
 * the UiAutomator2 driver 8.7.0.
 *
 * - Detection: `.autotest/appium.json`, or the signals of an existing suite (`integration_test/appium_test.dart`, an
 *   `appium`/`webdriverio` dependency, a scenario registry). Without the pin file the suite is inventoried but cannot
 *   run: version pinning is mandatory.
 * - Inventory: one `e2e` target per scenario and platform; the path is `<scenario source>#<name>`, and a spec
 *   document that maps to the scenario (APM-002) is linked as a `spec:<name>` tag. The selector value carries what
 *   execution needs from the pin file (`<platform>|<name>|<port>|<flags>|<cwd>|<runner>`), so building specs needs
 *   no workspace access and no state.
 * - Prerequisites: the pin file, the runner script, and the probed Appium and driver versions equal to the pin
 *   (any difference: `prerequisite_mismatch`).
 * - Execution (on the run's device): the Appium server as a background service on 127.0.0.1:<port>, then one
 *   `node <runner> --scenario <name> [--udid <device>] [--port <port>] --platform <p>` per scenario.
 * - Results: per scenario, from the exit code (0 passed, otherwise failed); `assertion` when the output names one,
 *   otherwise `crash`. The granularity is the scenario, which is a recorded limitation.
 */
import {
  buildSpec,
  flag,
  flagRunPath,
  targetId,
  workspacePath,
  type CapabilitySet,
  type DetectContext,
  type DetectionResult,
  type EvidenceHint,
  type ExecutionRequest,
  type ExecutionSpec,
  type FailureSignal,
  type InventoryContext,
  type InventoryFragment,
  type Limitation,
  type NormalizedResult,
  type ParseResult,
  type PlatformAdapter,
  type PrerequisiteReport,
  type RunnerOutputs,
  type TestTarget,
} from '@autotest/adapter-sdk';
import { CONFIG_FILE, pinMismatches, readAppiumConfig, type AppiumConfig } from './config.ts';
import { mapScenariosToSpecs, scenariosFromList, scenariosFromRegistry } from './mapping.ts';

export const ADAPTER_ID = 'appium';
export const APPIUM_ADAPTER_VERSION = '1.2.0';
/** Appium 3 prints this line when it accepts sessions. */
export const READY_TEXT = 'Appium REST http interface listener started';

export const APPIUM_CAPABILITIES: CapabilitySet = {
  levels: ['e2e'],
  host: { requires: 'any', available: true },
  devices: { needs: 'emulator', available: true },
  selection: ['name'],
  resultFormats: ['exit-code'],
  resultGranularity: 'scenario',
  cancellation: 'graceful_then_group',
  coverage: false,
  limitations: [
    'results are per scenario, from the exit code',
    `the Appium server and driver versions must be pinned in ${CONFIG_FILE} and installed`,
    'scenarios run on an AutoTest-owned, booted simulator or emulator (one per run); device farms are not supported',
  ],
};

const MAX_TEXT = 1024 * 1024;
const EXCLUDE = ['node_modules/**', '**/node_modules/**', 'build/**', '**/build/**', 'ios/**', 'android/**'];

interface Discovered {
  readonly source: string;
  readonly scenarios: readonly string[];
}

/** Scenarios of the pinned config, or (without one) of registries found by their `case "…":` labels. */
function discover(ws: DetectContext['workspace'], config: AppiumConfig | undefined): Discovered | undefined {
  if (config?.scenarios.list && ws.exists(config.scenarios.list))
    return {
      source: config.scenarios.list,
      scenarios: scenariosFromList(ws.readText(config.scenarios.list, MAX_TEXT).text),
    };
  if (config?.scenarios.registry && ws.exists(config.scenarios.registry))
    return {
      source: config.scenarios.registry,
      scenarios: scenariosFromRegistry(ws.readText(config.scenarios.registry, MAX_TEXT).text),
    };
  if (config) return undefined;
  for (const f of [...ws.list(['**/scenario-list.json'], { maxFiles: 5, exclude: EXCLUDE }).files].sort()) {
    const s = scenariosFromList(ws.readText(f, MAX_TEXT).text);
    if (s.length) return { source: f, scenarios: s };
  }
  for (const f of [
    ...ws.list(['**/scenario.ts', '**/scenario.js', '**/scenario.mjs'], { maxFiles: 5, exclude: EXCLUDE }).files,
  ].sort()) {
    const s = scenariosFromRegistry(ws.readText(f, MAX_TEXT).text);
    if (s.length) return { source: f, scenarios: s };
  }
  return undefined;
}

function signals(ws: DetectContext['workspace']): string[] {
  const out: string[] = [];
  if (ws.exists(CONFIG_FILE)) out.push(CONFIG_FILE);
  if (ws.exists('integration_test/appium_test.dart')) out.push('integration_test/appium_test.dart');
  for (const f of ['package.json', 'integration_test/package.json'])
    if (ws.exists(f) && /"(?:appium|webdriverio)"\s*:/.test(ws.readText(f, MAX_TEXT).text)) out.push(f);
  return out;
}

async function detectAppium(ctx: DetectContext): Promise<DetectionResult> {
  const ws = ctx.workspace;
  const config = readAppiumConfig(ws);
  const found = discover(ws, config?.ok ? config.config : undefined);
  const evidence = [...signals(ws), ...(found ? [found.source] : [])];
  const none: DetectionResult = {
    adapterId: ADAPTER_ID,
    detected: false,
    confidence: 0,
    evidence: [],
    platforms: [],
    toolchains: [],
    runners: [],
    limitations: [],
  };
  // A scenario registry alone is not an Appium signal.
  if (evidence.length === 0 || (signals(ws).length === 0 && !config)) return none;
  const limitations: Limitation[] = [];
  if (!config)
    limitations.push({
      code: 'appium:not_pinned',
      message: `no ${CONFIG_FILE}: the suite is listed but cannot run until Appium and driver versions are pinned`,
    });
  else if (!config.ok) limitations.push({ code: 'appium:config_invalid', message: config.problem.slice(0, 500) });
  return {
    adapterId: ADAPTER_ID,
    detected: true,
    confidence: config?.ok ? 0.9 : 0.6,
    evidence: [...new Set(evidence)],
    platforms: (config?.ok ? config.config.platforms : (['android', 'ios'] as const)).map((p) => ({
      platform: p,
      status: 'present' as const,
      evidence: [config?.ok ? CONFIG_FILE : evidence[0]!],
    })),
    toolchains: [],
    runners: [{ kind: 'appium', configured: config?.ok === true, evidence: config ? [CONFIG_FILE] : evidence }],
    limitations,
  };
}

/** Spec documents under the configured folder, or `integration_test/spec` and `spec` by default (APM-002). */
function specFiles(ws: DetectContext['workspace'], config: AppiumConfig | undefined, maxFiles: number): string[] {
  const dirs = config?.specs ? [config.specs] : ['integration_test/spec', 'spec'];
  return dirs.flatMap((d) => [...ws.list([`${d}/**/*.md`], { maxFiles }).files]);
}

async function inventoryAppium(ctx: InventoryContext): Promise<InventoryFragment> {
  const ws = ctx.workspace;
  const config = readAppiumConfig(ws);
  const pinned = config?.ok ? config.config : undefined;
  const empty = {
    adapterId: ADAPTER_ID,
    targets: [],
    helpers: [],
    automationConfigs: [],
    complete: true,
    truncatedAt: null,
    reasons: [],
  };
  if ((await detectAppium(ctx)).detected === false) return empty;
  const found = discover(ws, pinned);
  if (!found) return empty;
  const mapping = mapScenariosToSpecs(found.scenarios, specFiles(ws, pinned, ctx.limits.maxFiles));
  const platforms = pinned?.platforms ?? (['android', 'ios'] as const);
  const targets: TestTarget[] = [];
  for (const name of found.scenarios)
    for (const platform of platforms) {
      const spec = mapping.mapped.get(name);
      const specName = spec?.slice(spec.lastIndexOf('/') + 1).replace(/\.md$/i, '');
      targets.push({
        id: targetId(ADAPTER_ID, `${found.source}#${name}`, platform),
        adapterId: ADAPTER_ID,
        level: 'e2e',
        path: `${found.source}#${name}`,
        selector: {
          kind: 'scenario',
          value: pinned
            ? [
                platform,
                name,
                pinned.port,
                `${pinned.runner.passDevice ? 'd' : ''}${pinned.runner.passPort ? 'p' : ''}`,
                pinned.runner.cwd,
                pinned.runner.script,
              ].join('|')
            : `${platform}|${name}`,
        },
        platforms: [platform],
        requires: platform === 'ios' ? { host: 'macos', device: 'simulator' } : { host: 'any', device: 'emulator' },
        tags: specName ? [`spec:${specName}`.slice(0, 64)] : [],
      });
    }
  return {
    ...empty,
    targets,
    automationConfigs: config ? [{ path: CONFIG_FILE, kind: 'appium' }] : [],
  };
}

async function prerequisitesAppium(ctx: DetectContext): Promise<PrerequisiteReport> {
  const config = readAppiumConfig(ctx.workspace);
  if (!config)
    return {
      satisfied: false,
      missing: [
        { code: 'appium_not_pinned', message: `add ${CONFIG_FILE} with the Appium and driver versions to use` },
      ],
    };
  if (!config.ok) return { satisfied: false, missing: [{ code: 'appium_config_invalid', message: config.problem }] };
  const c = config.config;
  const missing: { code: string; message: string }[] = [];
  if (!ctx.workspace.exists(c.runner.script))
    missing.push({
      code: 'appium_runner_missing',
      message: `${c.runner.script} does not exist (build the suite first)`,
    });
  if (!ctx.probes) {
    missing.push({ code: 'prerequisite_mismatch', message: 'the Appium versions could not be checked' });
    return { satisfied: false, missing };
  }
  const v = await ctx.probes.probe('appium_version');
  const d = await ctx.probes.probe('appium_drivers');
  let installed: unknown;
  try {
    installed = d.available && d.exitCode === 0 ? JSON.parse(d.stdout) : undefined;
  } catch {
    installed = undefined;
  }
  const server =
    v.available && v.exitCode === 0 ? /(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\s*$/.exec(v.stdout.trim())?.[1] : undefined;
  for (const m of pinMismatches(c, server, installed)) missing.push({ code: 'prerequisite_mismatch', message: m });
  return { satisfied: missing.length === 0, missing };
}

const sel = (t: TestTarget) => {
  const [platform, name, port, flags, cwd, script] = (t.selector?.value ?? '').split('|');
  return {
    platform: platform as 'ios' | 'android',
    name: name!,
    // Absent for suites without a pin file, which never reach execution (prerequisites refuse them).
    run: script
      ? { port: Number(port), passDevice: flags!.includes('d'), passPort: flags!.includes('p'), cwd: cwd!, script }
      : undefined,
  };
};

/** Targets of this adapter that the request can run, in spec order (spec 0 is the server). */
function scenarioTargets(targets: readonly TestTarget[]): TestTarget[] {
  return targets
    .filter((t) => t.adapterId === ADAPTER_ID)
    .sort((a, b) => (sel(a).name < sel(b).name ? -1 : sel(a).name > sel(b).name ? 1 : 0));
}

export function buildAppiumExecution(req: ExecutionRequest): ExecutionSpec[] {
  const device = req.device;
  const targets = scenarioTargets(req.targets);
  const config = targets[0] ? sel(targets[0]).run : undefined;
  if (!device || !config || targets.some((t) => sel(t).platform !== device.platform || !sel(t).run)) return [];
  const requires =
    device.platform === 'ios'
      ? ({ host: 'macos', device: 'simulator' } as const)
      : ({ host: 'any', device: 'emulator' } as const);
  const server = buildSpec({
    executable: 'appium',
    args: [
      { kind: 'word', value: 'server' },
      flag('--address', '127.0.0.1'),
      flag('--port', String(config.port)),
      flagRunPath('--log', `attempts/${req.attemptNo}/appium.log`),
      flag('--log-no-colors'),
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    background: { readyText: READY_TEXT, readyTimeoutMs: 120_000 },
    timeoutMs: req.options.timeoutMs,
    cancellation: 'graceful_then_group',
    requires,
  });
  return [
    server,
    ...targets.map((t) =>
      buildSpec({
        executable: 'node',
        args: [
          workspacePath(config.script),
          flag('--scenario', sel(t).name),
          ...(config.passDevice ? [flag('--udid', device.id)] : []),
          ...(config.passPort ? [flag('--port', String(config.port))] : []),
          flag('--platform', device.platform),
        ],
        cwd: config.cwd,
        envNeeds: [],
        expectedOutputs: [],
        timeoutMs: req.options.timeoutMs,
        cancellation: 'graceful_then_group',
        requires,
      }),
    ),
  ];
}

export function parseAppiumResults(outputs: RunnerOutputs): ParseResult {
  const results: NormalizedResult[] = [];
  const diagnostics: { code: string; message: string }[] = [];
  if (outputs.interrupted)
    return {
      results,
      diagnostics: [{ code: 'interrupted', message: 'the run was interrupted' }],
      protocol: 'exit-code',
    };
  scenarioTargets(outputs.targets).forEach((t, i) => {
    const proc = outputs.processes[i + 1];
    if (!proc || proc.exitCode === undefined) {
      diagnostics.push({ code: 'runner_incomplete', message: `scenario ${sel(t).name} did not finish` });
      return;
    }
    const log = (outputs.files[`attempts/${outputs.attemptNo}/stdout-${i + 1}.log`] ?? '').trim();
    const passed = proc.exitCode === 0;
    results.push({
      targetId: t.id,
      name: sel(t).name,
      suitePath: t.path,
      outcome: passed ? 'passed' : 'failed',
      ...(passed ? {} : { failureKind: /assert|expect|AssertionError/i.test(log) ? 'assertion' : 'crash' }),
      ...(passed || !log ? {} : { messageExcerpt: log.slice(-2000) }),
      rawStatus: `exit ${proc.exitCode}`,
    });
  });
  return { results, diagnostics, protocol: 'exit-code' };
}

function evidenceHints(outputs: RunnerOutputs): EvidenceHint[] {
  return [{ kind: 'log', rel: `attempts/${outputs.attemptNo}/appium.log`, mimeType: 'text/plain', required: false }];
}

function failureSignals(results: readonly NormalizedResult[], outputs: RunnerOutputs): FailureSignal[] {
  const log = Object.entries(outputs.files)
    .filter(([k]) => /\/stdout-\d+\.log$/.test(k))
    .map(([, v]) => v ?? '')
    .join('\n');
  const first = results.find((r) => r.outcome !== 'passed');
  const base = first ? { targetId: first.targetId, resultName: first.name } : {};
  return /ECONNREFUSED 127\.0\.0\.1:\d+|Could not start a new session/.test(log)
    ? [
        {
          ...base,
          signal: 'appium.session',
          indicates: { class: 'environment_failure', subtype: 'infrastructure' },
          evidence: 'no Appium session could be started',
        },
      ]
    : [];
}

export function createAppiumAdapter(): PlatformAdapter {
  return {
    id: ADAPTER_ID,
    version: APPIUM_ADAPTER_VERSION,
    detect: detectAppium,
    async capabilities() {
      return APPIUM_CAPABILITIES;
    },
    inventory: inventoryAppium,
    resolveTargets(input) {
      const ids = new Set(input.targets.map((t) => t.id));
      return {
        resolved: input.testCases
          .filter((c) => c.targetRef && ids.has(c.targetRef))
          .map((c) => ({ testCaseId: c.id, targetId: c.targetRef! })),
        unresolved: input.testCases
          .filter((c) => !c.targetRef || !ids.has(c.targetRef))
          .map((c) => ({ testCaseId: c.id, reason: c.targetRef ? 'target_not_in_inventory' : 'no_target' })),
      };
    },
    buildExecution: buildAppiumExecution,
    parseResults: parseAppiumResults,
    evidenceHints,
    failureSignals,
    prerequisites: prerequisitesAppium,
    cleanupSpecs: () => [],
  };
}
