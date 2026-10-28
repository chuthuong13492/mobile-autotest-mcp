/**
 * React Native adapter (RN-001 – RN-003; platform-adapters §React Native).
 *
 * - Detection: a root `package.json` that depends on `react-native` (Expo is flagged).
 * - Inventory: Jest test files (`unit`, or `component` when they render components) on the host; Maestro flows under
 *   `.maestro/` and Detox test files under `e2e/` (per Detox configuration) as `e2e` targets on a device. The
 *   selector value says which runner: `jest`, `maestro|<platform>` or `detox|<configuration>|<config file>`.
 * - Execution: one Jest spec for the host targets, then (with the run's device) one Maestro spec and the Detox specs
 *   (see `e2e.ts`). Spec order is derived from the targets alone, so the parser can find each runner's output.
 */
import {
  targetId,
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
  type RunnerOutputs,
  type TestTarget,
} from '@autotest/adapter-sdk';
import { detoxReport, detoxSpecs, maestroReport, maestroSpec, parseMaestroReport } from './e2e.ts';
import { jestReport, jestSpec, parseJestReport } from './jest.ts';
import {
  detoxConfigFile,
  detoxConfigurations,
  detoxTestFiles,
  jestLevel,
  jestTestFiles,
  maestroFlows,
  readPackage,
} from './project.ts';

export const ADAPTER_ID = 'react-native';
export const RN_ADAPTER_VERSION = '1.2.0';

export const RN_CAPABILITIES: CapabilitySet = {
  levels: ['unit', 'component', 'e2e'],
  host: { requires: 'any', available: true },
  devices: { needs: 'simulator', available: true },
  selection: ['file'],
  resultFormats: ['jest-json', 'junit-xml'],
  resultGranularity: 'test',
  cancellation: 'graceful_then_group',
  coverage: false,
  limitations: [
    'node_modules must already be installed; AutoTest never installs packages',
    'Maestro and Detox need the app built beforehand; Maestro also needs it installed (manage_simulator install)',
    'Maestro and Detox run on an AutoTest-owned, booted simulator or emulator (one per run)',
  ],
};

type Kind = 'jest' | 'maestro' | 'detox';
const kindOf = (t: TestTarget): Kind => (t.selector?.value.split('|')[0] ?? 'jest') as Kind;

async function detectReactNative(ctx: DetectContext): Promise<DetectionResult> {
  const pkg = readPackage(ctx.workspace);
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
  if (!pkg?.deps.has('react-native')) return none;
  const ws = ctx.workspace;
  const limitations: Limitation[] = [];
  if (pkg.deps.has('expo'))
    limitations.push({
      code: 'rn:expo',
      message: 'Expo project: Jest runs; Detox and Maestro need a development build',
    });
  if (!ws.exists('node_modules'))
    limitations.push({
      code: 'rn:node_modules_missing',
      message: 'node_modules is missing; install dependencies first',
    });
  const detox = detoxConfigFile(ws);
  if (pkg.deps.has('detox') && !detox)
    limitations.push({
      code: 'rn:detox_config_in_package_json',
      message: 'a Detox config in package.json is not supported; use .detoxrc.js or .detoxrc.json',
    });
  const evidence = ['package.json', ...['app.json', 'metro.config.js'].filter((f) => ws.exists(f))];
  return {
    adapterId: ADAPTER_ID,
    detected: true,
    confidence: 0.9,
    evidence,
    platforms: (['ios', 'android'] as const)
      .filter((p) => ws.exists(p))
      .map((p) => ({ platform: p, status: 'present' as const, evidence: [p] })),
    toolchains: [],
    runners: [
      ...(pkg.deps.has('jest') || pkg.hasJestConfig
        ? [{ kind: 'jest', configured: true, evidence: ['package.json'] }]
        : []),
      ...(detox ? [{ kind: 'detox', configured: true, evidence: [detox] }] : []),
      ...(ws.exists('.maestro') ? [{ kind: 'maestro', configured: true, evidence: ['.maestro'] }] : []),
    ],
    limitations,
  };
}

const deviceReq = (platform: 'ios' | 'android') =>
  platform === 'ios'
    ? ({ host: 'macos', device: 'simulator' } as const)
    : ({ host: 'any', device: 'emulator' } as const);

async function inventoryReactNative(ctx: InventoryContext): Promise<InventoryFragment> {
  const ws = ctx.workspace;
  const targets: TestTarget[] = [];
  const reasons = new Set<string>();
  if (!readPackage(ws)?.deps.has('react-native'))
    return {
      adapterId: ADAPTER_ID,
      targets,
      helpers: [],
      automationConfigs: [],
      complete: true,
      truncatedAt: null,
      reasons: [],
    };
  const jest = jestTestFiles(ws, ctx.limits.maxFiles);
  if (jest.truncated) reasons.add('max_files');
  for (const file of jest.files)
    targets.push({
      id: targetId(ADAPTER_ID, file, 'jest'),
      adapterId: ADAPTER_ID,
      level: jestLevel(ws.readText(file, 512 * 1024).text),
      path: file,
      selector: { kind: 'file', value: 'jest' },
      platforms: ['host'],
      requires: { host: 'any', device: 'none' },
      tags: [],
    });
  const automationConfigs: { path: string; kind: string }[] = [];
  const platforms = (['ios', 'android'] as const).filter((p) => ws.exists(p));
  for (const flow of maestroFlows(ws, ctx.limits.maxFiles))
    for (const platform of platforms)
      targets.push({
        id: targetId(ADAPTER_ID, flow, `maestro/${platform}`),
        adapterId: ADAPTER_ID,
        level: 'e2e',
        path: flow,
        selector: { kind: 'file', value: `maestro|${platform}` },
        platforms: [platform],
        requires: deviceReq(platform),
        tags: [],
      });
  const config = detoxConfigFile(ws);
  if (config) {
    automationConfigs.push({ path: config, kind: 'detox' });
    const files = detoxTestFiles(ws, ctx.limits.maxFiles);
    for (const c of detoxConfigurations(ws.readText(config, 256 * 1024).text))
      for (const file of files)
        targets.push({
          id: targetId(ADAPTER_ID, file, `detox/${c.name}`),
          adapterId: ADAPTER_ID,
          level: 'e2e',
          path: file,
          selector: { kind: 'file', value: `detox|${c.name}|${config}` },
          platforms: [c.platform],
          requires: deviceReq(c.platform),
          tags: [],
        });
  }
  if (ws.exists('.maestro')) automationConfigs.push({ path: '.maestro', kind: 'maestro' });
  return {
    adapterId: ADAPTER_ID,
    targets,
    helpers: [],
    automationConfigs,
    complete: reasons.size === 0,
    truncatedAt: reasons.size ? targets.length : null,
    reasons: [...reasons],
  };
}

interface Plan {
  readonly kind: Kind;
  readonly targets: TestTarget[];
  /** Index of the spec whose output this runner writes. */
  readonly spec: number;
}

/**
 * The specs of a request, in order, with which spec reports for which targets. Detox targets of several
 * configurations are not supported in one run (one device): only the first configuration runs.
 */
function planOf(targets: readonly TestTarget[]): Plan[] {
  const mine = targets.filter((t) => t.adapterId === ADAPTER_ID);
  const jest = mine.filter((t) => kindOf(t) === 'jest');
  const maestro = mine.filter((t) => kindOf(t) === 'maestro');
  const detox = mine.filter((t) => kindOf(t) === 'detox');
  const detoxKey = [...new Set(detox.map((t) => t.selector!.value))].sort()[0];
  const detoxRun = detox.filter((t) => t.selector!.value === detoxKey);
  const plans: Plan[] = [];
  let k = 0;
  if (jest.length) plans.push({ kind: 'jest', targets: jest, spec: k++ });
  if (maestro.length) plans.push({ kind: 'maestro', targets: maestro, spec: k++ });
  if (detoxRun.length) {
    if (detoxRun[0]!.platforms[0] === 'ios') k++; // the framework-cache build comes first
    plans.push({ kind: 'detox', targets: detoxRun, spec: k });
  }
  return plans;
}

export function buildReactNativeExecution(req: ExecutionRequest): ExecutionSpec[] {
  const plans = planOf(req.targets);
  const device = req.device;
  // Device runners need the run's device (the workflow refuses such runs without one).
  if (plans.some((p) => p.kind !== 'jest') && !device) return [];
  const specs: ExecutionSpec[] = [];
  for (const p of plans) {
    if (p.kind === 'jest') specs.push(jestSpec(req.attemptNo, p.targets, req.options.timeoutMs));
    if (p.kind === 'maestro')
      specs.push(
        maestroSpec(
          req.attemptNo,
          p.targets.map((t) => t.path),
          device!,
          req.options.timeoutMs,
        ),
      );
    if (p.kind === 'detox') {
      const [, configuration, projectConfig] = p.targets[0]!.selector!.value.split('|') as [string, string, string];
      specs.push(
        ...detoxSpecs(req.attemptNo, {
          projectConfig,
          configuration,
          files: p.targets.map((t) => t.path),
          device: device!,
          timeoutMs: req.options.timeoutMs,
        }),
      );
    }
  }
  return specs;
}

export function parseReactNativeResults(outputs: RunnerOutputs): ParseResult {
  const results: NormalizedResult[] = [];
  const diagnostics: { code: string; message: string }[] = [];
  for (const p of planOf(outputs.targets)) {
    const file =
      p.kind === 'jest'
        ? jestReport(outputs.attemptNo)
        : p.kind === 'maestro'
          ? maestroReport(outputs.attemptNo)
          : detoxReport(outputs.attemptNo);
    const text = outputs.files[file];
    const got =
      p.kind === 'maestro'
        ? { results: parseMaestroReport(text, p.targets), ok: text !== undefined }
        : parseJestReport(text, p.targets);
    results.push(...got.results);
    if (!got.ok || got.results.length === 0) {
      const proc = outputs.processes[p.spec];
      diagnostics.push({
        code: 'runner_incomplete',
        message: `no ${p.kind} report${proc?.exitCode !== undefined ? ` (exit ${proc.exitCode})` : ''}`,
      });
    }
  }
  return { results, diagnostics, protocol: 'react-native' };
}

function evidenceHints(outputs: RunnerOutputs): EvidenceHint[] {
  return planOf(outputs.targets).map((p) =>
    p.kind === 'maestro'
      ? { kind: 'junit' as const, rel: maestroReport(outputs.attemptNo), mimeType: 'application/xml', required: false }
      : {
          kind: 'runner_json' as const,
          rel: p.kind === 'jest' ? jestReport(outputs.attemptNo) : detoxReport(outputs.attemptNo),
          mimeType: 'application/json',
          required: false,
        },
  );
}

function failureSignals(results: readonly NormalizedResult[], outputs: RunnerOutputs): FailureSignal[] {
  const log = Object.entries(outputs.files)
    .filter(([k]) => /\/stdout-\d+\.log$/.test(k))
    .map(([, v]) => v ?? '')
    .join('\n');
  const first = results.find((r) => r.outcome !== 'passed');
  const base = first ? { targetId: first.targetId, resultName: first.name } : {};
  const signals: FailureSignal[] = [];
  if (/Cannot find module|Cannot find package/.test(log))
    signals.push({
      ...base,
      signal: 'rn.node_modules',
      indicates: { class: 'environment_failure', subtype: 'dependency' },
      evidence: 'a module is missing from node_modules',
    });
  if (
    /is not installed on|App is not installed|binaryPath .{0,200}(does not exist|not found)|Failed to find the app binary/i.test(
      log,
    )
  )
    signals.push({
      ...base,
      signal: 'rn.app_not_built',
      indicates: { class: 'environment_failure', subtype: 'setup' },
      evidence: 'the app under test is not built or not installed',
    });
  return signals;
}

export function createReactNativeAdapter(): PlatformAdapter {
  return {
    id: ADAPTER_ID,
    version: RN_ADAPTER_VERSION,
    detect: detectReactNative,
    async capabilities() {
      return RN_CAPABILITIES;
    },
    inventory: inventoryReactNative,
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
    buildExecution: buildReactNativeExecution,
    parseResults: parseReactNativeResults,
    evidenceHints,
    failureSignals,
    cleanupSpecs: () => [],
  };
}
