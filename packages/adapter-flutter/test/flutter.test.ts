import { describe, expect, it } from 'vitest';
import { changedFileCoverage, parseLcov, type TestTarget } from '@autotest/adapter-sdk';
import { adapterContractCases, type KitFixtures } from '@autotest/adapter-sdk/testing';
import {
  buildFlutterExecution,
  classifyLevel,
  createFlutterAdapter,
  dependsOnFlutterSdk,
  detectFlutter,
  fileTags,
  flutterEvidenceHints,
  flutterFailureSignals,
  inventoryFlutter,
  parseFlutterMachineVersion,
  parseFlutterResults,
  pubspecEnvironment,
} from '@autotest/adapter-flutter';
import { memoryWorkspace, outputs, probeReturning, PUBSPEC, reporter } from './helpers.ts';

const FILES = {
  'pubspec.yaml': PUBSPEC,
  'lib/main.dart': 'void main() {}',
  'ios/Runner/Info.plist': '',
  'android/app/build.gradle': '',
  'test/calc_test.dart': "@Tags(['math', 'fast'])\nlibrary;\nvoid main() { test('a', () {}); }",
  'test/ui/counter_test.dart': "void main() { testWidgets('b', (t) async {}); }",
  'test/helpers/values.dart': 'const x = 1;',
  'test/flutter_test_config.dart': '',
  'integration_test/app_test.dart': "void main() { testWidgets('c', (t) async {}); }",
  'dart_test.yaml': 'tags: {}',
  'build/generated/x_test.dart': '',
};
const ctx = { workspace: memoryWorkspace(FILES), host: { os: 'macos' as const } };
const limits = { maxFiles: 1000, maxReadBytes: 4 << 20 };

async function hostTargets(): Promise<TestTarget[]> {
  return (await inventoryFlutter({ ...ctx, limits })).targets.filter((t) => t.requires.device === 'none');
}

describe('FL-001 detection and SDK resolution', () => {
  it('detects a Flutter app with evidence, platforms and the flutter_test runner', async () => {
    const d = await detectFlutter(ctx);
    expect(d).toMatchObject({ adapterId: 'flutter', detected: true, confidence: 1 });
    expect(d.evidence).toEqual(['pubspec.yaml', 'lib/main.dart', 'test']);
    expect(d.platforms.filter((p) => p.status === 'present').map((p) => p.platform)).toEqual([
      'host',
      'android',
      'ios',
    ]);
    expect(d.runners).toEqual([{ kind: 'flutter_test', configured: true, evidence: ['pubspec.yaml'] }]);
    expect(d.limitations.map((l) => l.code)).toEqual(['flutter:integration_test_needs_device']);
  });

  it('does not detect plain Dart packages or a missing pubspec', async () => {
    expect(dependsOnFlutterSdk('name: x\ndependencies:\n  http: ^1.0.0\n')).toBe(false);
    expect((await detectFlutter({ ...ctx, workspace: memoryWorkspace({ 'lib/a.dart': '' }) })).detected).toBe(false);
    expect(
      (await detectFlutter({ ...ctx, workspace: memoryWorkspace({ 'pubspec.yaml': 'name: x\n' }) })).detected,
    ).toBe(false);
  });

  it('reports an Autotrader-like SDK conflict between sources and does not pick one', async () => {
    const ws = memoryWorkspace({
      ...FILES,
      '.fvmrc': '{"flutter": "3.38.10"}',
      '.github/workflows/ci.yml': 'env:\n  flutter-version: 3.38.4\n',
    });
    const probe = probeReturning(
      JSON.stringify({ frameworkVersion: '3.38.10', dartSdkVersion: '3.10.4 (build 3.10.4)', flutterRoot: '/sdk' }),
    );
    const d = await detectFlutter({ ...ctx, workspace: ws, probes: probe });
    const flutter = d.toolchains.find((t) => t.tool === 'flutter')!;
    expect(flutter.versionsBySource).toEqual([
      { source: 'pubspec.yaml', value: '3.38.4' },
      { source: '.fvmrc', value: '3.38.10' },
      { source: '.github/workflows/ci.yml', value: '3.38.4' },
      { source: 'probe:flutter --version --machine', value: '3.38.10' },
    ]);
    expect(flutter.resolved).toBeNull();
    expect(flutter.conflicts[0]).toMatch(/pubspec.yaml=3.38.4.*\.fvmrc=3.38.10/);
    expect(d.toolchains.find((t) => t.tool === 'dart')).toMatchObject({ resolved: '3.10.4', conflicts: [] });
  });

  it('agreeing sources resolve; ranges are recorded but not compared', async () => {
    const ws = memoryWorkspace({ ...FILES, '.tool-versions': 'flutter 3.38.4-stable\nnodejs 24.0.0\n' });
    const d = await detectFlutter({ ...ctx, workspace: ws });
    expect(d.toolchains.find((t) => t.tool === 'flutter')).toMatchObject({ resolved: '3.38.4', conflicts: [] });
    expect(pubspecEnvironment(PUBSPEC)).toEqual({ sdk: '>=3.5.0 <4.0.0', flutter: '3.38.4' });
    expect(parseFlutterMachineVersion('Waiting for lock...\n{"frameworkVersion":"3.47.1"}')).toEqual({
      flutter: '3.47.1',
    });
    expect(parseFlutterMachineVersion('not json')).toEqual({});
    const banner =
      '{\n  "frameworkVersion": "3.47.1",\n  "note": "a } brace \\" in a string"\n}\n\n  Welcome to Flutter! {telemetry}\n';
    expect(parseFlutterMachineVersion(banner)).toEqual({ flutter: '3.47.1' });
  });

  it('lists monorepo packages and Melos as limitations', async () => {
    const ws = memoryWorkspace({ ...FILES, 'packages/core/pubspec.yaml': 'name: core', 'melos.yaml': '' });
    const codes = (await detectFlutter({ ...ctx, workspace: ws })).limitations.map((l) => l.code);
    expect(codes).toEqual([
      'flutter:monorepo_packages',
      'flutter:melos_not_orchestrated',
      'flutter:integration_test_needs_device',
    ]);
  });
});

describe('FL-002 inventory', () => {
  it('classifies unit, widget and integration files; build output is excluded', async () => {
    const inv = await inventoryFlutter({ ...ctx, limits });
    expect(inv.targets.map((t) => [t.path, t.level, t.platforms.join(), t.requires.host, t.requires.device])).toEqual([
      ['integration_test/app_test.dart', 'integration', 'android', 'any', 'emulator'],
      ['integration_test/app_test.dart', 'integration', 'ios', 'macos', 'simulator'],
      ['test/calc_test.dart', 'unit', 'host', 'any', 'none'],
      ['test/ui/counter_test.dart', 'widget', 'host', 'any', 'none'],
    ]);
    // One target per platform: distinct, stable ids for the same file.
    expect(new Set(inv.targets.map((t) => t.id)).size).toBe(4);
    expect(inv.targets[2]!.tags).toEqual(['fast', 'math']);
    expect(inv.helpers).toEqual([
      { path: 'test/flutter_test_config.dart', kind: 'config' },
      { path: 'test/helpers/values.dart', kind: 'helper' },
    ]);
    expect(inv.automationConfigs.map((c) => c.kind)).toEqual(['dart_test', 'flutter_test_config']);
    expect(inv).toMatchObject({ complete: true, truncatedAt: null, reasons: [] });
    expect(classifyLevel('testWidgets (')).toBe('widget');
    expect(fileTags('@Tags(["a b", "ok"])')).toEqual(['ok']);
  });

  it('reports truncation honestly', async () => {
    const inv = await inventoryFlutter({ ...ctx, limits: { maxFiles: 1, maxReadBytes: 1 << 20 } });
    expect(inv).toMatchObject({ complete: false, reasons: ['max_files'] });
  });
});

describe('FL-006 integration_test on a device', () => {
  it('builds a -d spec only for the run device platform, and nothing without a device', async () => {
    const inv = await inventoryFlutter({ ...ctx, limits });
    const req = (device?: { platform: 'ios' | 'android'; id: string }) => ({
      attemptNo: 1,
      targets: inv.targets,
      options: { coverage: true, timeoutMs: 600_000 },
      ...(device ? { device } : {}),
    });
    const words = (specs: ReturnType<typeof buildFlutterExecution>) =>
      specs.map((s) =>
        s.args.map((a) =>
          'value' in a ? `${'name' in a ? a.name + '=' : ''}${a.value}` : 'rel' in a ? a.rel : a.name,
        ),
      );
    expect(buildFlutterExecution(req()).every((s) => s.requires.device === 'none')).toBe(true);
    const ios = buildFlutterExecution(req({ platform: 'ios', id: 'A59793A1-207D-4223-9A07-7A25E3124218' }));
    expect(ios.at(-1)!.requires).toEqual({ host: 'macos', device: 'simulator' });
    expect(words(ios).at(-1)).toEqual([
      'test',
      '--no-pub',
      '-d=A59793A1-207D-4223-9A07-7A25E3124218',
      'attempts/1/runner/flutter-device.jsonl',
      '--reporter=expanded',
      'integration_test/app_test.dart',
    ]);
    const android = buildFlutterExecution(req({ platform: 'android', id: 'emulator-5554' }));
    expect(android.at(-1)!.requires).toEqual({ host: 'any', device: 'emulator' });
    // A device run of host targets only adds no device spec.
    const hostOnly = buildFlutterExecution({
      ...req({ platform: 'ios', id: 'A59793A1-207D-4223-9A07-7A25E3124218' }),
      targets: inv.targets.filter((t) => t.requires.device === 'none'),
    });
    expect(hostOnly.some((s) => s.requires.device !== 'none')).toBe(false);
  });
});

describe('FL-003 execution specs', () => {
  it('builds one deterministic file-selected spec with --no-pub, the JSON reporter and sorted paths', async () => {
    const targets = await hostTargets();
    const [spec, ...rest] = buildFlutterExecution({
      attemptNo: 2,
      targets: [...targets].reverse(),
      options: { coverage: true, timeoutMs: 600_000, shard: { total: 2, index: 0 } },
    });
    expect(rest).toEqual([]);
    expect(spec!.args).toEqual([
      { kind: 'word', value: 'test' },
      { kind: 'flag', name: '--no-pub' },
      { kind: 'flagRunPath', name: '--file-reporter', rel: 'attempts/2/runner/flutter.jsonl', prefix: 'json:' },
      { kind: 'flag', name: '--reporter', value: 'expanded' },
      { kind: 'flag', name: '--coverage' },
      { kind: 'flagRunPath', name: '--coverage-path', rel: 'attempts/2/runner/lcov.info' },
      { kind: 'flag', name: '--total-shards', value: '2' },
      { kind: 'flag', name: '--shard-index', value: '0' },
      { kind: 'workspacePath', rel: 'test/calc_test.dart' },
      { kind: 'workspacePath', rel: 'test/ui/counter_test.dart' },
    ]);
    expect(spec!.expectedOutputs.map((o) => o.kind)).toEqual(['runner_json', 'coverage']);
    expect(
      spec!.args.some(
        (a) => (a.kind === 'flag' && a.name === '--update-goldens') || (a.kind === 'word' && a.value === 'pub'),
      ),
    ).toBe(false);
  });

  it('name-selected targets get their own spec; integration targets are never built', async () => {
    const [unit] = await hostTargets();
    const named = { ...unit!, id: 'TT-flutter-aaaaaaaaaaaa', selector: { kind: 'name' as const, value: 'adds' } };
    const integration = (await inventoryFlutter({ ...ctx, limits })).targets.find((t) => t.level === 'integration')!;
    const specs = buildFlutterExecution({
      attemptNo: 1,
      targets: [named, integration],
      options: { coverage: true, timeoutMs: 60_000 },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.args).toContainEqual({ kind: 'flag', name: '--plain-name', value: 'adds' });
    expect(specs[0]!.args.some((a) => a.kind === 'flag' && a.name === '--coverage')).toBe(false);
    expect(
      buildFlutterExecution({ attemptNo: 1, targets: [integration], options: { coverage: false, timeoutMs: 60_000 } }),
    ).toEqual([]);
  });
});

describe('1.3.0 workspace run options', () => {
  it('adds --flavor and sorted --dart-define flags to host and device specs', async () => {
    const all = (await inventoryFlutter({ ...ctx, limits })).targets;
    const run = { flutter: { flavor: 'staging', dartDefines: { ENV: 'staging', API_BASE: '-x' } } };
    const specs = buildFlutterExecution({
      attemptNo: 1,
      targets: all,
      options: { coverage: false, timeoutMs: 60_000, run },
      device: { platform: 'android', id: 'emulator-5554' },
    });
    for (const spec of specs)
      expect(spec.args.filter((a) => a.kind === 'flag' && /flavor|dart-define/.test(a.name))).toEqual([
        { kind: 'flag', name: '--flavor', value: 'staging' },
        { kind: 'flag', name: '--dart-define', value: 'API_BASE=-x', inline: true },
        { kind: 'flag', name: '--dart-define', value: 'ENV=staging', inline: true },
      ]);
  });

  it('leaves an Appium entry point in integration_test/ to the Appium adapter', async () => {
    const ws = memoryWorkspace({
      ...FILES,
      'integration_test/appium_test.dart': "import 'package:appium_flutter_server/appium_flutter_server.dart';",
    });
    const targets = (await inventoryFlutter({ ...ctx, workspace: ws, limits })).targets;
    expect(targets.some((t) => t.path.endsWith('appium_test.dart'))).toBe(false);
    expect((await detectFlutter({ ...ctx, workspace: ws })).limitations.map((l) => l.code)).toContain(
      'flutter:appium_entry_point',
    );
  });
});

describe('FL-004 reporter parsing', () => {
  const F = 'attempts/1/runner/flutter.jsonl';
  it('maps pass, fail, error, skip and hidden tests; an error after testDone upgrades to failed', async () => {
    const [calc] = await hostTargets();
    const text = reporter(calc!.path, [
      { name: 'loading /abs/app/test/calc_test.dart', result: 'success', hidden: true },
      { name: 'passes', result: 'success' },
      { name: 'fails', result: 'failure', error: 'Expected: <3>\n  Actual: <2>', isFailure: true },
      { name: 'throws', result: 'error', error: 'ArgumentError' },
      { name: 'skips', result: 'success', skipped: true },
      { name: 'late', result: 'success', errorAfterDone: 'late async error' },
      { name: '(tearDownAll)', result: 'error', hidden: true, error: 'cleanup failed' },
    ]);
    const res = parseFlutterResults(outputs([calc!], { [F]: text }));
    expect(res.results.map((r) => [r.name, r.outcome, r.failureKind ?? null])).toEqual([
      ['passes', 'passed', null],
      ['fails', 'failed', 'assertion'],
      ['throws', 'failed', 'exception'],
      ['skips', 'skipped', null],
      ['late', 'failed', 'exception'],
      ['(tearDownAll)', 'failed', 'exception'],
    ]);
    expect(res.results[1]!.messageExcerpt).toContain('Actual: <2>');
    expect(res.results[0]!.durationMs).toBe(25);
    expect(res.protocol).toBe('dart-json-reporter@0.1.1');
    expect(res.diagnostics).toEqual([]);
  });

  it('a load error fails the file; unresolved dependencies block it instead', async () => {
    const [calc] = await hostTargets();
    const load = reporter(
      calc!.path,
      [
        {
          name: `loading /abs/app/${calc!.path}`,
          result: 'error',
          error: 'Failed to load: Compilation failed ... Error:',
        },
      ],
      false,
    );
    expect(parseFlutterResults(outputs([calc!], { [F]: load })).results).toMatchObject([
      { name: `loading ${calc!.path}`, outcome: 'failed', failureKind: 'load_error' },
    ]);
    const pub = reporter(
      calc!.path,
      [
        {
          name: `loading /abs/app/${calc!.path}`,
          result: 'error',
          error: "Error: Couldn't resolve the package 'flutter_test'",
        },
      ],
      false,
    );
    const blocked = parseFlutterResults(outputs([calc!], { [F]: pub })).results[0]!;
    expect(blocked).toMatchObject({ outcome: 'blocked', blockedReason: 'prerequisite_missing:pub_get' });
    expect(flutterFailureSignals([blocked])[0]).toMatchObject({
      signal: 'flutter.pub_get_required',
      indicates: { class: 'environment_failure', subtype: 'dependency' },
    });
  });

  it('interrupted runs end running tests cancelled; incomplete runs end them infra_error, never passed', async () => {
    const [calc, ui] = await hostTargets();
    const running = reporter(calc!.path, [{ name: 'done one', result: 'success' }, { name: 'slow' }], 'missing');
    const cancelled = parseFlutterResults(outputs([calc!, ui!], { [F]: running }, true));
    expect(cancelled.results.map((r) => [r.name, r.outcome])).toEqual([
      ['done one', 'passed'],
      ['slow', 'cancelled'],
      ['(target)', 'cancelled'],
    ]);
    const sigterm = reporter(calc!.path, [{ name: 'slow', result: 'error' }], false);
    expect(parseFlutterResults(outputs([calc!], { [F]: sigterm }, true)).results[0]!.outcome).toBe('cancelled');
    const crashed = parseFlutterResults(outputs([calc!, ui!], { [F]: running }));
    expect(crashed.results.map((r) => r.outcome)).toEqual(['passed', 'infra_error', 'infra_error']);
    expect(crashed.diagnostics.map((d) => d.code)).toEqual(['runner_incomplete']);
    const nullDone = parseFlutterResults(outputs([calc!], { [F]: reporter(calc!.path, [], null) }));
    expect(nullDone.results.map((r) => r.outcome)).toEqual(['infra_error']);
  });

  it('missing output, unknown states and suites outside the request never yield a pass', async () => {
    const [calc] = await hostTargets();
    expect(parseFlutterResults(outputs([calc!], {})).results.map((r) => r.outcome)).toEqual(['infra_error']);
    const odd = parseFlutterResults(outputs([calc!], { [F]: reporter(calc!.path, [{ name: 'x', result: 'weird' }]) }));
    expect(odd.results[0]!.outcome).toBe('infra_error');
    expect(odd.diagnostics.map((d) => d.code)).toEqual(['unknown_runner_state']);
    const other = parseFlutterResults(
      outputs([calc!], { [F]: reporter('test/other_test.dart', [{ name: 'y', result: 'success' }]) }),
    );
    expect(other.results).toEqual([]);
    expect(other.diagnostics.map((d) => d.code)).toEqual(['unmapped_suite']);
  });
});

describe('FL-005 evidence and coverage', () => {
  it('hints the reporter output (required) and lcov when present', async () => {
    const [calc] = await hostTargets();
    expect(
      flutterEvidenceHints(
        outputs([calc!], { 'attempts/1/runner/flutter.jsonl': '', 'attempts/1/runner/lcov.info': '' }),
      ),
    ).toEqual([
      { kind: 'runner_json', rel: 'attempts/1/runner/flutter.jsonl', mimeType: 'application/x-ndjson', required: true },
      { kind: 'coverage', rel: 'attempts/1/runner/lcov.info', mimeType: 'text/plain', required: false },
    ]);
  });

  it('computes changed-file line coverage, null without a denominator', () => {
    const lcov =
      'SF:/abs/app/lib/calc.dart\nDA:1,1\nDA:2,0\nDA:3,4\nLF:3\nLH:2\nend_of_record\nSF:lib/other.dart\nLF:5\nLH:5\nend_of_record\n';
    const report = parseLcov(lcov);
    expect(report).toEqual([
      { path: '/abs/app/lib/calc.dart', linesFound: 3, linesHit: 2 },
      { path: 'lib/other.dart', linesFound: 5, linesHit: 5 },
    ]);
    expect(changedFileCoverage(report, ['lib/calc.dart', 'lib/new.dart'])).toMatchObject({
      linesHit: 2,
      linesFound: 3,
      missing: ['lib/new.dart'],
    });
    expect(changedFileCoverage(report, ['README.md']).ratio).toBeNull();
    expect(parseLcov('garbage\nDA:x\n')).toEqual([]);
  });

  it('signals classify candidates without deciding the class', () => {
    const base = { targetId: 'TT-flutter-000000000000', name: 't', rawStatus: 'error' };
    const signals = flutterFailureSignals([
      {
        ...base,
        outcome: 'failed',
        failureKind: 'exception',
        messageExcerpt: 'MissingPluginException(No implementation)',
      },
      { ...base, outcome: 'failed', failureKind: 'assertion', messageExcerpt: 'Expected: <1>' },
      { ...base, outcome: 'failed', failureKind: 'exception', messageExcerpt: 'TimeoutException after 0:00:30' },
      { ...base, outcome: 'passed' },
    ]);
    expect(signals.map((s) => s.signal)).toEqual(['flutter.missing_plugin', 'flutter.assertion', 'flutter.timeout']);
  });
});

describe('adapter contract kit', async () => {
  const targets = await hostTargets();
  const F = 'attempts/1/runner/flutter.jsonl';
  const fx: KitFixtures = {
    detect: ctx,
    inventory: { ...ctx, limits },
    requests: [
      { attemptNo: 1, targets, options: { coverage: false, timeoutMs: 60_000 } },
      { attemptNo: 2, targets: [...targets].reverse(), options: { coverage: true, timeoutMs: 60_000 } },
    ],
    outputs: outputs(targets, {
      [F]: reporter(targets[0]!.path, [
        { name: 'ok', result: 'success' },
        { name: 'bad', result: 'failure', error: 'Expected', isFailure: true },
      ]),
    }),
    unknownStateOutputs: outputs(targets, { [F]: reporter(targets[0]!.path, [{ name: 'x', result: 'weird' }]) }),
  };
  for (const c of adapterContractCases(createFlutterAdapter, fx)) it(c.name, c.run);
});
