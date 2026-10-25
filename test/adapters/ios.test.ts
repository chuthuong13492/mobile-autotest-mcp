import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionSpec, TestTarget } from '@autotest/adapter-sdk';
import { fixture } from './fixtureWorkspace.ts';

type ArgToken = ExecutionSpec['args'][number];
import { buildIosExecution, createIosAdapter, parseIosResults, xctestClasses } from '@autotest/adapter-ios';

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
const CORPUS = path.join(ROOT, 'ios-corpus/xcode-26.4.1');

const adapter = createIosAdapter();
const ctx = { workspace: fixture(path.join(ROOT, 'fixture-ios')), host: { os: 'macos' as const } };
const UDID = 'A59793A1-207D-4223-9A07-7A25E3124218';

async function inventory(): Promise<readonly TestTarget[]> {
  return (await adapter.inventory({ ...ctx, limits: { maxFiles: 1000, maxReadBytes: 1 << 24 } })).targets;
}

describe('IOS-002 detection and inventory (fixture-ios, static)', () => {
  it('detects the project and lists one target per XCTestCase class of the scheme test targets', async () => {
    expect(await adapter.detect(ctx)).toMatchObject({
      detected: true,
      evidence: ['FixtureApp.xcodeproj/project.pbxproj'],
    });
    const targets = await inventory();
    expect(targets.map((t) => [t.path, t.level, t.selector?.value])).toEqual([
      [
        'FixtureAppTests/CalculatorTests.swift',
        'unit',
        'FixtureApp.xcodeproj|FixtureApp|FixtureAppTests/CalculatorTests',
      ],
      ['FixtureAppTests/ScenarioTests.swift', 'unit', 'FixtureApp.xcodeproj|FixtureApp|FixtureAppTests/ScenarioTests'],
      [
        'FixtureAppUITests/CounterUITests.swift',
        'e2e',
        'FixtureApp.xcodeproj|FixtureApp|FixtureAppUITests/CounterUITests',
      ],
    ]);
    expect(targets.every((t) => t.requires.host === 'macos' && t.requires.device === 'simulator')).toBe(true);
    expect(
      xctestClasses('final class A: XCTestCase { func testX() {} func helper() {} }\nclass B: NSObject {}'),
    ).toEqual([{ name: 'A', methods: ['testX'] }]);
  });

  it('ignores a Flutter project ios/ folder (the Flutter adapter owns it)', async () => {
    const flutter = { workspace: fixture(path.join(ROOT, 'fixture-flutter')), host: { os: 'macos' as const } };
    expect((await adapter.detect(flutter)).detected).toBe(false);
  });
});

describe('IOS-003 execution and xcresult parsing (Xcode 26.4.1 corpus)', () => {
  it('builds xcodebuild test with -only-testing, then the two xcresulttool reads; nothing without a simulator', async () => {
    const targets = await inventory();
    const req = { attemptNo: 2, targets, options: { coverage: false, timeoutMs: 900_000 } };
    expect(buildIosExecution(req)).toEqual([]);
    const specs = buildIosExecution({ ...req, device: { platform: 'ios', id: UDID } });
    expect(specs.map((s) => s.executable)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
    const show = (a: ArgToken) =>
      a.kind === 'word'
        ? a.value
        : a.kind === 'flag'
          ? `${a.name} ${a.value ?? ''}`.trim()
          : a.kind === 'flagRunPath'
            ? `${a.name} ${a.rel}`
            : a.rel;
    const argv = specs[0]!.args.map(show);
    expect(argv).toEqual([
      'test',
      '-project FixtureApp.xcodeproj',
      '-scheme FixtureApp',
      `-destination id=${UDID}`,
      '-resultBundlePath attempts/2/runner/Test-1.xcresult',
      '-derivedDataPath attempts/2/dd',
      '-only-testing FixtureAppTests/CalculatorTests',
      '-only-testing FixtureAppTests/ScenarioTests',
      '-only-testing FixtureAppUITests/CounterUITests',
    ]);
  });

  it('maps passed, failed (with the assertion message) and skipped cases to their class targets', async () => {
    const targets = await inventory();
    const r = parseIosResults({
      attemptNo: 1,
      targets,
      files: {
        'attempts/1/stdout-1.log': fs.readFileSync(path.join(CORPUS, 'full.tests.json'), 'utf8'),
        'attempts/1/stdout-2.log': '{"status":"succeeded","errors":[]}',
      },
      processes: [],
      interrupted: false,
    });
    const by = Object.fromEntries(r.results.map((x) => [x.name, [x.outcome, x.failureKind ?? null]]));
    expect(by).toEqual({
      'CalculatorTests/testAddReturnsTheSum()': ['passed', null],
      'CalculatorTests/testDivideByZeroReturnsNil()': ['passed', null],
      'ScenarioTests/testAddIsWrongOnPurpose()': ['failed', 'assertion'],
      'ScenarioTests/testSkippedOnPurpose()': ['skipped', null],
      'CounterUITests/testTapIncrementShowsOne()': ['passed', null],
    });
    expect(r.results.find((x) => x.outcome === 'failed')?.messageExcerpt).toMatch(/fails on purpose/);
    const ui = targets.find((t) => t.selector?.value.endsWith('CounterUITests'))!;
    expect(r.results.find((x) => x.name.startsWith('CounterUITests'))?.targetId).toBe(ui.id);
  });

  it('a build failure becomes a load_error for every selected target, with the compiler message', async () => {
    const targets = await inventory();
    const r = parseIosResults({
      attemptNo: 1,
      targets,
      files: {
        'attempts/1/stdout-1.log': fs.readFileSync(path.join(CORPUS, 'build-failure.tests.json'), 'utf8'),
        'attempts/1/stdout-2.log': fs.readFileSync(path.join(CORPUS, 'build-failure.build-results.json'), 'utf8'),
      },
      processes: [],
      interrupted: false,
    });
    expect(r.results.map((x) => [x.outcome, x.failureKind])).toEqual(targets.map(() => ['failed', 'load_error']));
    expect(r.results[0]!.messageExcerpt).toMatch(/Cannot convert return expression/);
    expect(
      parseIosResults({ attemptNo: 1, targets, files: {}, processes: [], interrupted: true }).diagnostics[0]!.code,
    ).toBe('runner_incomplete');
  });
});
