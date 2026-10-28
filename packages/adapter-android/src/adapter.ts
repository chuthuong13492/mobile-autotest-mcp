/**
 * Native Android adapter (AND-002 – AND-004; platform-adapters §Native Android). Verified with Gradle 9.3.1 and
 * AGP 9.1.0 (RL-018).
 *
 * - Detection: a `settings.gradle(.kts)` at the workspace root or one level down (not a Flutter project's
 *   `android/`, which belongs to the Flutter adapter) that includes a module applying an Android plugin.
 * - Inventory: one target per JUnit class; `src/test` classes are `unit` (host JVM, no device), `src/androidTest`
 *   classes are `integration` (instrumented, on the run's emulator). The selector value is
 *   `<gradle root>|<gradle path>|<unit|instrumented>|<fully qualified class>`. Only the `debug` variant is run;
 *   modules with product flavors are reported and skipped.
 * - Execution: the configured JDK runs the project's Gradle wrapper jar (never the `gradlew` script, see the `java`
 *   argument schema), one spec per module and kind: `:<module>:testDebugUnitTest --rerun --tests <class>…` or
 *   `:<module>:connectedDebugAndroidTest --project-prop android.testInstrumentationRunnerArguments.class=<classes>`,
 *   always `--offline --no-daemon --console=plain`. The emulator comes from `ANDROID_SERIAL` (set by the supervisor
 *   from the run's lease). The JUnit XML (and, for instrumented runs, AGP's per-test logcat) is copied from the
 *   module's `build/` folder into the runner directory after each spec (ExecutionSpec `collect`).
 */
import {
  buildSpec,
  flag,
  parseJUnitXml,
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
import { customProjectDirs, findAndroidModules, findGradleRoots, testClasses } from './project.ts';

export const ADAPTER_ID = 'android';
export const ANDROID_ADAPTER_VERSION = '1.1.0';
const VARIANT = 'Debug';

export const ANDROID_CAPABILITIES: CapabilitySet = {
  levels: ['unit', 'integration'],
  host: { requires: 'any', available: true },
  // Unit tests run on the host JVM; instrumented tests need an emulator (decided per target).
  devices: { needs: 'emulator', available: true },
  selection: ['name'],
  resultFormats: ['junit-xml'],
  resultGranularity: 'test',
  cancellation: 'graceful_then_group',
  coverage: false,
  limitations: [
    'only the debug variant runs; modules with product flavors are not inventoried',
    'instrumented tests run on an AutoTest-owned, booted emulator (one per run); physical devices are not supported',
    'Gradle runs offline: dependencies and the Gradle distribution must already be in GRADLE_USER_HOME',
  ],
};

type Kind = 'unit' | 'instrumented';

const sel = (t: TestTarget) => {
  const [root, module, kind, fqcn] = (t.selector?.value ?? '').split('|');
  return { root: root!, module: module!, kind: kind as Kind, fqcn: fqcn! };
};

const join = (...parts: string[]) => parts.filter(Boolean).join('/');

function modulesOf(ctx: { workspace: DetectContext['workspace'] }) {
  return findGradleRoots(ctx.workspace).flatMap((root) => findAndroidModules(ctx.workspace, root));
}

async function detectAndroid(ctx: DetectContext): Promise<DetectionResult> {
  const roots = findGradleRoots(ctx.workspace);
  const modules = roots.flatMap((root) => findAndroidModules(ctx.workspace, root));
  const detected = modules.length > 0;
  const limitations = [
    ...modules
      .filter((m) => m.flavors)
      .map((m) => ({
        code: 'android_product_flavors',
        message: `${m.gradlePath} declares product flavors; its variants are not known without running Gradle, so it is not inventoried`,
      })),
    ...roots
      .filter((r) => modules.some((m) => m.root === r) && !r.wrapperJar)
      .map((r) => ({ code: 'android_no_gradle_wrapper', message: `${r.dir || '.'} has no Gradle wrapper jar` })),
    ...roots
      .filter((r) => customProjectDirs(ctx.workspace.readText(r.settings, 1024 * 1024).text))
      .map((r) => ({
        code: 'android_custom_project_dir',
        message: `${r.settings} moves project directories; those modules are not followed`,
      })),
  ];
  return {
    adapterId: ADAPTER_ID,
    detected,
    confidence: detected ? 0.9 : 0,
    evidence: modules.map((m) => m.buildFile),
    platforms: detected ? [{ platform: 'android', status: 'present', evidence: modules.map((m) => m.buildFile) }] : [],
    toolchains: [],
    runners: detected
      ? [{ kind: 'gradle', configured: roots.some((r) => r.wrapperJar), evidence: modules.map((m) => m.root.settings) }]
      : [],
    limitations,
  };
}

async function inventoryAndroid(ctx: InventoryContext): Promise<InventoryFragment> {
  const targets: TestTarget[] = [];
  const reasons = new Set<string>();
  const runnable = modulesOf(ctx).filter((m) => !m.flavors && m.root.wrapperJar);
  for (const module of runnable)
    for (const [sourceSet, kind] of [
      ['test', 'unit'],
      ['androidTest', 'instrumented'],
    ] as const) {
      const found = testClasses(ctx.workspace, module, sourceSet, ctx.limits.maxFiles);
      if (found.truncated) reasons.add('max_files');
      for (const c of found.classes)
        targets.push({
          id: targetId(ADAPTER_ID, c.path, `${kind}/${c.fqcn}`),
          adapterId: ADAPTER_ID,
          level: kind === 'unit' ? 'unit' : 'integration',
          path: c.path,
          selector: { kind: 'name', value: `${module.root.dir}|${module.gradlePath}|${kind}|${c.fqcn}` },
          platforms: ['android'],
          requires: kind === 'unit' ? { host: 'any', device: 'none' } : { host: 'any', device: 'emulator' },
          tags: [],
        });
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

/** Targets grouped by Gradle root, module and kind, in a stable order (spec k is group k; collect prefixes follow). */
function groups(targets: readonly TestTarget[]): { root: string; module: string; kind: Kind; targets: TestTarget[] }[] {
  const by = new Map<string, TestTarget[]>();
  for (const t of targets.filter((x) => x.adapterId === ADAPTER_ID)) {
    const s = sel(t);
    const key = `${s.root}|${s.module}|${s.kind}`;
    by.set(key, [...(by.get(key) ?? []), t]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, ts]) => {
      const [root, module, kind] = key.split('|') as [string, string, Kind];
      return { root, module, kind, targets: ts };
    });
}

const moduleDir = (root: string, module: string) => join(root, module.slice(1).replaceAll(':', '/'));
const taskOf = (module: string, kind: Kind) =>
  kind === 'unit' ? `${module}:test${VARIANT}UnitTest` : `${module}:connected${VARIANT}AndroidTest`;
const xmlPrefix = (g: number) => `g${g + 1}`;
const logPrefix = (g: number) => `l${g + 1}`;

export function buildAndroidExecution(req: ExecutionRequest): ExecutionSpec[] {
  const all = groups(req.targets);
  // Instrumented groups need the run's emulator (the workflow refuses such runs without one); spec g is group g.
  if (all.some((x) => x.kind === 'instrumented') && req.device?.platform !== 'android') return [];
  const specs: ExecutionSpec[] = [];
  for (const [g, grp] of all.entries()) {
    const classes = [...new Set(grp.targets.map((t) => sel(t).fqcn))].sort();
    const dir = moduleDir(grp.root, grp.module);
    const results =
      grp.kind === 'unit'
        ? join(dir, `build/test-results/test${VARIANT}UnitTest`)
        : join(dir, 'build/outputs/androidTest-results/connected');
    specs.push(
      buildSpec({
        executable: 'java',
        args: [
          flag('-classpath', join(grp.root, 'gradle/wrapper/gradle-wrapper.jar')),
          word('org.gradle.wrapper.GradleWrapperMain'),
          word(taskOf(grp.module, grp.kind)),
          ...(grp.kind === 'unit'
            ? [flag('--rerun'), ...classes.map((c) => flag('--tests', c))]
            : [flag('--project-prop', `android.testInstrumentationRunnerArguments.class=${classes.join(',')}`)]),
          flag('--offline'),
          flag('--no-daemon'),
          flag('--console', 'plain', true),
        ],
        cwd: grp.root || '.',
        envNeeds: [],
        expectedOutputs: [],
        collect: [
          { dir: results, suffix: '.xml', prefix: xmlPrefix(g) },
          ...(grp.kind === 'instrumented' ? [{ dir: results, suffix: '.txt' as const, prefix: logPrefix(g) }] : []),
        ],
        timeoutMs: req.options.timeoutMs,
        cancellation: 'graceful_then_group',
        requires: { host: 'any', device: grp.kind === 'unit' ? 'none' : 'emulator' },
      }),
    );
  }
  return specs;
}

function filesWith(outputs: RunnerOutputs, prefix: string, suffix: string): [string, string][] {
  const head = `attempts/${outputs.attemptNo}/runner/${prefix}-`;
  return Object.entries(outputs.files)
    .filter((e): e is [string, string] => e[0].startsWith(head) && e[0].endsWith(suffix) && typeof e[1] === 'string')
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

/** The "What went wrong" part of Gradle's output, for build failures without test reports. */
function gradleFailure(log: string | undefined): string {
  if (!log) return 'Gradle produced no test report';
  const at = log.indexOf('What went wrong');
  return (at >= 0 ? log.slice(at) : log.slice(-2000)).slice(0, 2000);
}

export function parseAndroidResults(outputs: RunnerOutputs): ParseResult {
  const results: NormalizedResult[] = [];
  const diagnostics: { code: string; message: string }[] = [];
  for (const [index, grp] of groups(outputs.targets).entries()) {
    const byClass = new Map(grp.targets.map((t) => [sel(t).fqcn, t]));
    const xml = filesWith(outputs, xmlPrefix(index), '.xml');
    const cases = xml.flatMap(([, text]) => parseJUnitXml(text));
    if (cases.length === 0) {
      const proc = outputs.processes[index];
      if (outputs.interrupted || !proc) {
        diagnostics.push({ code: 'runner_incomplete', message: `no JUnit report for ${grp.module} (${grp.kind})` });
        continue;
      }
      if (proc.exitCode === 0) {
        diagnostics.push({ code: 'no_results', message: `Gradle ran no tests for ${grp.module} (${grp.kind})` });
        continue;
      }
      const message = gradleFailure(outputs.files[`attempts/${outputs.attemptNo}/stdout-${index}.log`]);
      for (const t of grp.targets)
        results.push({
          targetId: t.id,
          name: `build ${sel(t).fqcn}`,
          outcome: 'failed',
          failureKind: 'load_error',
          messageExcerpt: message,
          rawStatus: 'build_failed',
        });
      continue;
    }
    for (const c of cases) {
      const t = byClass.get(c.classname);
      if (!t) continue;
      const simple = c.classname.slice(c.classname.lastIndexOf('.') + 1);
      const failed = c.outcome === 'failed' || c.outcome === 'error';
      results.push({
        targetId: t.id,
        name: `${simple}/${c.name}`,
        suitePath: t.path,
        outcome: failed ? 'failed' : c.outcome === 'skipped' ? 'skipped' : 'passed',
        ...(failed
          ? {
              failureKind: /Process crashed|Instrumentation run failed/i.test(c.message ?? '')
                ? 'crash'
                : c.outcome === 'error'
                  ? 'exception'
                  : 'assertion',
            }
          : {}),
        ...(c.timeSeconds !== undefined ? { durationMs: Math.round(c.timeSeconds * 1000) } : {}),
        ...(c.message ? { messageExcerpt: c.message.slice(0, 2000) } : {}),
        rawStatus: c.outcome,
      });
    }
  }
  return { results, diagnostics, protocol: 'junit-xml' };
}

function evidenceHints(outputs: RunnerOutputs): EvidenceHint[] {
  return groups(outputs.targets).flatMap((_, g) => [
    ...filesWith(outputs, xmlPrefix(g), '.xml').map(([rel]) => ({
      kind: 'junit' as const,
      rel,
      mimeType: 'application/xml',
      required: false,
    })),
    ...filesWith(outputs, logPrefix(g), '.txt')
      .filter(([rel]) => /logcat/.test(rel))
      .map(([rel]) => ({ kind: 'log' as const, rel, mimeType: 'text/plain', required: false })),
  ]);
}

/** Environment signals from Gradle's output (SDK, offline cache, device) for the analysis rules. */
function failureSignals(results: readonly NormalizedResult[], outputs: RunnerOutputs): FailureSignal[] {
  const log = Object.entries(outputs.files)
    .filter(([k]) => /\/stdout-\d+\.log$/.test(k))
    .map(([, v]) => v ?? '')
    .join('\n');
  const first = results.find((r) => r.outcome !== 'passed');
  const base = first ? { targetId: first.targetId, resultName: first.name } : {};
  const signals: FailureSignal[] = [];
  const add = (signal: string, subtype: 'toolchain' | 'dependency' | 'device', evidence: string) =>
    signals.push({ ...base, signal, indicates: { class: 'environment_failure', subtype }, evidence });
  if (/SDK location not found|JAVA_HOME is (not set|set to an invalid)/i.test(log))
    add('android.sdk_missing', 'toolchain', 'Android SDK or JDK not found');
  if (
    /No cached version of .{1,200} available for offline mode|No cached version available for offline mode/i.test(log)
  )
    add('android.offline_cache', 'dependency', 'dependency missing from the offline Gradle cache');
  if (/No connected devices!|No online devices found|INSTALL_FAILED_/.test(log))
    add('android.device_unavailable', 'device', 'emulator unavailable or install failed');
  return signals;
}

export function createAndroidAdapter(): PlatformAdapter {
  return {
    id: ADAPTER_ID,
    version: ANDROID_ADAPTER_VERSION,
    detect: detectAndroid,
    async capabilities() {
      return ANDROID_CAPABILITIES;
    },
    inventory: inventoryAndroid,
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
    buildExecution: buildAndroidExecution,
    parseResults: parseAndroidResults,
    evidenceHints,
    failureSignals,
    cleanupSpecs: () => [],
  };
}
