/**
 * Flutter host test commands (FL-003; platform-adapters §Flutter "Command construction"). Shape:
 * `flutter test --no-pub --file-reporter json:<runDir>/attempts/<n>/runner/flutter.jsonl --reporter expanded
 * [--coverage --coverage-path <lcov>] [--total-shards N --shard-index I] <sorted test paths>`.
 * `--no-pub` is always present so runs never resolve dependencies over the network (SR-014). Targets selected by
 * test name get their own spec with `--plain-name`. Integration targets need a device and are never built here.
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
  return specs;
}
