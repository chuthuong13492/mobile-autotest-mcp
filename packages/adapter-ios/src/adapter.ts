/**
 * Native iOS adapter (IOS-002, IOS-003; platform-adapters §Native iOS). Verified on Xcode 26.4.1 (RL-017).
 *
 * - Detection: an `.xcodeproj` at the workspace root or one level down (not in a Flutter project, whose `ios/`
 *   folder belongs to the Flutter adapter).
 * - Inventory: one target per XCTestCase class of each test target that a shared scheme tests; the selector value is
 *   `<project>|<scheme>|<TestTarget>/<Class>`. Unit-test bundles are `unit`, UI-testing bundles `e2e`; all need a
 *   simulator on macOS.
 * - Execution (needs the run's simulator): per project and scheme, `xcodebuild test -project … -scheme …
 *   -destination id=<UDID> -resultBundlePath <runDir>/…/Test-<g>.xcresult -derivedDataPath <runDir>/…/dd
 *   -only-testing <Target>/<Class>…`, then `xcrun xcresulttool get test-results tests` and `get build-results` on the
 *   bundle; their standard output is what the parser reads (`attempts/<n>/stdout-<k>.log`).
 */
import {
  buildSpec,
  flag,
  flagRunPath,
  runnerOutput,
  targetId,
  word,
  type CapabilitySet,
  type DetectContext,
  type DetectionResult,
  type EvidenceHint,
  type ExecutionRequest,
  type ExecutionSpec,
  type FailureSignal,
  type InventoryContext,
  type InventoryFragment,
  type NormalizedResult,
  type ParseResult,
  type PlatformAdapter,
  type RunnerOutputs,
  type TestTarget,
} from '@autotest/adapter-sdk';
import { findProjects, levelOf, schemeTestables, targetProductTypes, xctestClasses } from './project.ts';

export const ADAPTER_ID = 'ios';
export const IOS_ADAPTER_VERSION = '1.1.0';
const SPECS_PER_GROUP = 3;

export const IOS_CAPABILITIES: CapabilitySet = {
  levels: ['unit', 'e2e'],
  host: { requires: 'macos', available: true },
  devices: { needs: 'simulator', available: true },
  selection: ['name'],
  resultFormats: ['xcresult-test-results'],
  resultGranularity: 'test',
  cancellation: 'graceful_then_group',
  coverage: false,
  limitations: [
    'runs on an AutoTest-owned, booted simulator (one per run); physical devices are not supported',
    'selection is per XCTestCase class; Swift Testing (@Test) functions are run but not inventoried',
  ],
};

const sel = (t: TestTarget) => {
  const [project, scheme, id] = (t.selector?.value ?? '').split('|');
  return { project: project!, scheme: scheme!, id: id! };
};

async function detectIos(ctx: DetectContext): Promise<DetectionResult> {
  const flutter = ctx.workspace.exists('pubspec.yaml');
  const projects = findProjects(ctx.workspace).filter((p) => !(flutter && p.dir === 'ios'));
  const detected = projects.length > 0;
  return {
    adapterId: ADAPTER_ID,
    detected,
    confidence: detected ? 0.9 : 0,
    evidence: projects.map((p) => `${p.path}/project.pbxproj`),
    platforms: detected ? [{ platform: 'ios', status: 'present', evidence: projects.map((p) => p.path) }] : [],
    toolchains: [],
    runners: detected ? [{ kind: 'xcodebuild', configured: true, evidence: projects.map((p) => p.path) }] : [],
    limitations:
      detected && ctx.host.os !== 'macos'
        ? [{ code: 'ios_needs_macos', message: 'iOS tests run on macOS hosts only' }]
        : [],
  };
}

async function inventoryIos(ctx: InventoryContext): Promise<InventoryFragment> {
  const ws = ctx.workspace;
  const flutter = ws.exists('pubspec.yaml');
  const targets: TestTarget[] = [];
  const reasons = new Set<string>();
  for (const project of findProjects(ws).filter((p) => !(flutter && p.dir === 'ios'))) {
    const types = targetProductTypes(ws.readText(`${project.path}/project.pbxproj`, 4 * 1024 * 1024).text);
    const seen = new Set<string>();
    for (const { scheme, target } of schemeTestables(ws, project)) {
      const level = levelOf(types.get(target));
      if (!level || seen.has(target)) continue;
      seen.add(target);
      const root = project.dir ? `${project.dir}/${target}` : target;
      const files = ws.list([`${root}/**/*.swift`], { maxFiles: ctx.limits.maxFiles });
      if (files.truncated) reasons.add('max_files');
      for (const file of [...files.files].sort())
        for (const cls of xctestClasses(ws.readText(file, 512 * 1024).text)) {
          const value = `${project.path}|${scheme}|${target}/${cls.name}`;
          targets.push({
            id: targetId(ADAPTER_ID, file, `${target}/${cls.name}`),
            adapterId: ADAPTER_ID,
            level,
            path: file,
            selector: { kind: 'name', value },
            platforms: ['ios'],
            requires: { host: 'macos', device: 'simulator' },
            tags: [],
          });
        }
    }
  }
  return {
    adapterId: ADAPTER_ID,
    targets,
    helpers: [],
    automationConfigs: [],
    complete: reasons.size === 0,
    truncatedAt: reasons.size ? targets.length : null,
    reasons: [...reasons],
  };
}

/** Groups of targets by project and scheme, in a stable order (the parser derives stdout indexes from it). */
function groups(targets: readonly TestTarget[]): [string, TestTarget[]][] {
  const by = new Map<string, TestTarget[]>();
  for (const t of targets.filter((x) => x.adapterId === ADAPTER_ID)) {
    const s = sel(t);
    const key = `${s.project}|${s.scheme}`;
    by.set(key, [...(by.get(key) ?? []), t]);
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

const bundleOf = (attemptNo: number, g: number) => runnerOutput(attemptNo, `Test-${g + 1}.xcresult`);

export function buildIosExecution(req: ExecutionRequest): ExecutionSpec[] {
  const device = req.device;
  if (!device || device.platform !== 'ios') return [];
  return groups(req.targets).flatMap(([key, targets], g) => {
    const [project, scheme] = key.split('|') as [string, string];
    const bundle = bundleOf(req.attemptNo, g);
    const ids = [...new Set(targets.map((t) => sel(t).id))].sort();
    const common = {
      cwd: '.',
      envNeeds: [],
      cancellation: 'graceful_then_group' as const,
      requires: { host: 'macos' as const, device: 'simulator' as const },
    };
    return [
      buildSpec({
        ...common,
        executable: 'xcodebuild',
        args: [
          word('test'),
          flag('-project', project),
          flag('-scheme', scheme),
          flag('-destination', `id=${device.id}`),
          flagRunPath('-resultBundlePath', bundle),
          flagRunPath('-derivedDataPath', `attempts/${req.attemptNo}/dd`),
          ...ids.flatMap((id) => [flag('-only-testing', id)]),
        ],
        expectedOutputs: [],
        timeoutMs: req.options.timeoutMs,
      }),
      ...(['tests', 'build'] as const).map((what) =>
        buildSpec({
          ...common,
          executable: 'xcrun',
          args: [
            word('xcresulttool'),
            word('get'),
            ...(what === 'tests' ? [word('test-results'), word('tests')] : [word('build-results')]),
            flagRunPath('--path', bundle),
            flag('--compact'),
          ],
          expectedOutputs: [],
          timeoutMs: 120_000,
        }),
      ),
    ];
  });
}

interface Node {
  readonly name?: string;
  readonly nodeType?: string;
  readonly result?: string;
  readonly nodeIdentifier?: string;
  readonly durationInSeconds?: number;
  readonly children?: readonly Node[];
}

const OUTCOME: Readonly<Record<string, NormalizedResult['outcome']>> = {
  Passed: 'passed',
  Failed: 'failed',
  Skipped: 'skipped',
  'Expected Failure': 'passed',
};

function json<T>(text: string | undefined): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

function casesOf(
  nodes: readonly Node[],
  bundle?: string,
  suite?: string,
): { bundle: string; suite: string; node: Node }[] {
  const out: { bundle: string; suite: string; node: Node }[] = [];
  for (const n of nodes) {
    if (n.nodeType === 'Test Case' && bundle && suite) out.push({ bundle, suite, node: n });
    else
      out.push(
        ...casesOf(
          n.children ?? [],
          /test bundle$/i.test(n.nodeType ?? '') ? n.name : bundle,
          n.nodeType === 'Test Suite' ? n.name : suite,
        ),
      );
  }
  return out;
}

export function parseIosResults(outputs: RunnerOutputs): ParseResult {
  const results: NormalizedResult[] = [];
  const diagnostics: { code: string; message: string }[] = [];
  groups(outputs.targets).forEach(([, targets], g) => {
    const byId = new Map(targets.map((t) => [sel(t).id, t]));
    const stdout = (k: number) => outputs.files[`attempts/${outputs.attemptNo}/stdout-${g * SPECS_PER_GROUP + k}.log`];
    const tests = json<{ testNodes?: Node[] }>(stdout(1));
    const build = json<{ status?: string; errors?: { issueType?: string; message?: string }[] }>(stdout(2));
    const compileErrors = (build?.errors ?? []).filter(
      (e) => /Compiler Error|Error$/.test(e.issueType ?? '') && e.issueType !== 'Uncategorized',
    );
    if (!tests) {
      diagnostics.push({ code: 'runner_incomplete', message: `no xcresult test report for group ${g + 1}` });
      return;
    }
    const cases = casesOf(tests.testNodes ?? []);
    if (cases.length === 0 && compileErrors.length > 0) {
      for (const t of targets)
        results.push({
          targetId: t.id,
          name: `build ${sel(t).id}`,
          outcome: 'failed',
          failureKind: 'load_error',
          messageExcerpt: compileErrors
            .map((e) => e.message ?? '')
            .join('\n')
            .slice(0, 2000),
          rawStatus: 'build_failed',
        });
      return;
    }
    for (const c of cases) {
      const t = byId.get(`${c.bundle}/${c.suite}`);
      if (!t) continue;
      const messages = (c.node.children ?? []).filter((x) => x.nodeType === 'Failure Message').map((x) => x.name ?? '');
      const outcome = OUTCOME[c.node.result ?? ''] ?? 'infra_error';
      results.push({
        targetId: t.id,
        name: `${c.suite}/${c.node.name ?? c.node.nodeIdentifier ?? 'test'}`,
        suitePath: t.path,
        outcome,
        ...(outcome === 'failed'
          ? { failureKind: /crash|signal/i.test(messages.join(' ')) ? 'crash' : 'assertion' }
          : {}),
        ...(typeof c.node.durationInSeconds === 'number'
          ? { durationMs: Math.round(c.node.durationInSeconds * 1000) }
          : {}),
        ...(messages.length ? { messageExcerpt: messages.join('\n').slice(0, 2000) } : {}),
        rawStatus: c.node.result ?? 'unknown',
      });
    }
  });
  return { results, diagnostics, protocol: 'xcresult-test-results' };
}

function evidenceHints(outputs: RunnerOutputs): EvidenceHint[] {
  return groups(outputs.targets).flatMap((_, g) =>
    [1, 2].map((k) => ({
      kind: 'runner_json' as const,
      rel: `attempts/${outputs.attemptNo}/stdout-${g * SPECS_PER_GROUP + k}.log`,
      mimeType: 'application/json',
      required: k === 1,
    })),
  );
}

/** Environment signals from the xcodebuild output (simulator boot, code signing) for the analysis rules. */
function failureSignals(results: readonly NormalizedResult[], outputs: RunnerOutputs): FailureSignal[] {
  const log = Object.entries(outputs.files)
    .filter(([k]) => /\/stdout-\d+\.log$/.test(k))
    .map(([, v]) => v ?? '')
    .join('\n');
  const signals: FailureSignal[] = [];
  const first = results.find((r) => r.outcome !== 'passed');
  const base = first ? { targetId: first.targetId, resultName: first.name } : {};
  if (/Unable to boot|device is not booted|Failed to boot|Unable to find a destination/i.test(log))
    signals.push({
      ...base,
      signal: 'ios.simulator_unavailable',
      indicates: { class: 'environment_failure', subtype: 'device' },
      evidence: 'simulator unavailable',
    });
  if (/requires a development team|Code ?Sign(ing)? error|No signing certificate/i.test(log))
    signals.push({
      ...base,
      signal: 'ios.code_signing',
      indicates: { class: 'environment_failure', subtype: 'toolchain' },
      evidence: 'code signing failed',
    });
  return signals;
}

export function createIosAdapter(): PlatformAdapter {
  return {
    id: ADAPTER_ID,
    version: IOS_ADAPTER_VERSION,
    detect: detectIos,
    async capabilities(ctx) {
      return ctx.host.os === 'macos'
        ? IOS_CAPABILITIES
        : { ...IOS_CAPABILITIES, host: { requires: 'macos', available: false, reason: 'iOS tests need macOS' } };
    },
    inventory: inventoryIos,
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
    buildExecution: buildIosExecution,
    parseResults: parseIosResults,
    evidenceHints,
    failureSignals,
    cleanupSpecs: () => [],
  };
}
