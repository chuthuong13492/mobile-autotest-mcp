/**
 * Flutter host test commands (FL-003; platform-adapters §Flutter "Command construction"). Shape:
 * `flutter test --no-pub --file-reporter json:<runDir>/attempts/<n>/runner/flutter.jsonl --reporter expanded
 * [--coverage --coverage-path <lcov>] [--total-shards N --shard-index I] <sorted test paths>`.
 * `--no-pub` is always present so runs never resolve dependencies over the network (SR-014). Targets selected by
 * test name get their own spec with `--plain-name`. Integration targets run on the run's device (`deviceSpecs`).
 * The workspace's run options (1.3.0) add `--flavor <f>` and one `--dart-define=K=V` per define, sorted by key.
 */
import {
  buildSpec,
  flag,
  flagRunPath,
  runnerOutput,
  sortedPaths,
  word,
  workspacePath,
  type ExecutionRequest,
  type ExecutionSpec,
  type TestTarget,
} from '@autotest/adapter-sdk';

export const RESULTS_FILE = 'flutter.jsonl';
export const LCOV_FILE = 'lcov.info';

const hostTarget = (t: TestTarget) => t.requires.device === 'none' && t.level !== 'integration';

/** `--flavor` and `--dart-define` from the workspace run options (inline, so a value may start with `-`). */
function runFlags(req: ExecutionRequest) {
  const f = req.options.run?.flutter;
  if (!f) return [];
  return [
    ...(f.flavor ? [flag('--flavor', f.flavor)] : []),
    ...Object.keys(f.dartDefines ?? {})
      .sort()
      .map((k) => flag('--dart-define', `${k}=${f.dartDefines![k]}`, true)),
  ];
}

function spec(req: ExecutionRequest, paths: readonly string[], results: string, plainName?: string): ExecutionSpec {
  const out = runnerOutput(req.attemptNo, results);
  const lcov = runnerOutput(req.attemptNo, LCOV_FILE);
  const coverage = req.options.coverage && plainName === undefined;
  return buildSpec({
    executable: 'flutter',
    args: [
      word('test'),
      flag('--no-pub'),
      flagRunPath('--file-reporter', out, 'json:'),
      flag('--reporter', 'expanded'),
      ...runFlags(req),
      ...(plainName === undefined ? [] : [flag('--plain-name', plainName)]),
      ...(coverage ? [flag('--coverage'), flagRunPath('--coverage-path', lcov)] : []),
      ...(req.options.shard
        ? [
            flag('--total-shards', String(req.options.shard.total)),
            flag('--shard-index', String(req.options.shard.index)),
          ]
        : []),
      ...paths.map(workspacePath),
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [
      { kind: 'runner_json', rel: out },
      ...(coverage ? [{ kind: 'coverage' as const, rel: lcov }] : []),
    ],
    timeoutMs: req.options.timeoutMs,
    cancellation: 'graceful_then_group',
    requires: { host: 'any', device: 'none' },
  });
}

export function buildFlutterExecution(req: ExecutionRequest): ExecutionSpec[] {
  const host = req.targets.filter(hostTarget);
  const byName = host
    .filter((t) => t.selector?.kind === 'name')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byFile = host.filter((t) => t.selector?.kind !== 'name');
  const specs: ExecutionSpec[] = [];
  if (byFile.length > 0) specs.push(spec(req, sortedPaths(byFile.map((t) => t.path)), RESULTS_FILE));
  byName.forEach((t, i) => specs.push(spec(req, [t.path], `flutter-name-${i + 1}.jsonl`, t.selector!.value)));
  specs.push(...deviceSpecs(req));
  return specs;
}

export const DEVICE_RESULTS_FILE = 'flutter-device.jsonl';

/**
 * FL-006: `flutter test --no-pub -d <device> --file-reporter json:<…> <integration_test files>` for the targets of
 * the run's device platform (verified with Flutter 3.47 on an iOS 26.4 simulator and an API 36 emulator). Device
 * targets are built only when the run has a device; coverage is not collected on devices.
 */
function deviceSpecs(req: ExecutionRequest): ExecutionSpec[] {
  const device = req.device;
  if (!device) return [];
  const targets = req.targets.filter((t) => t.requires.device !== 'none' && t.platforms.includes(device.platform));
  if (targets.length === 0) return [];
  const out = runnerOutput(req.attemptNo, DEVICE_RESULTS_FILE);
  return [
    buildSpec({
      executable: 'flutter',
      args: [
        word('test'),
        flag('--no-pub'),
        flag('-d', device.id),
        flagRunPath('--file-reporter', out, 'json:'),
        flag('--reporter', 'expanded'),
        ...runFlags(req),
        ...sortedPaths(targets.map((t) => t.path)).map(workspacePath),
      ],
      cwd: '.',
      envNeeds: [],
      expectedOutputs: [{ kind: 'runner_json', rel: out }],
      timeoutMs: req.options.timeoutMs,
      cancellation: 'graceful_then_group',
      requires:
        device.platform === 'ios' ? { host: 'macos', device: 'simulator' } : { host: 'any', device: 'emulator' },
    }),
  ];
}
