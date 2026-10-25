import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExecutionSpec, RunnerOutputs, TestTarget } from '@autotest/adapter-sdk';
import {
  buildAndroidExecution,
  createAndroidAdapter,
  includedProjects,
  parseAndroidResults,
  parseJUnitXml,
  testClassOf,
} from '@autotest/adapter-android';
import { fixture } from './fixtureWorkspace.ts';

type ArgToken = ExecutionSpec['args'][number];

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
const CORPUS = path.join(ROOT, 'android-corpus/agp-9.1.0');
const adapter = createAndroidAdapter();
const ctx = { workspace: fixture(path.join(ROOT, 'fixture-android')), host: { os: 'macos' as const } };

async function inventory(): Promise<readonly TestTarget[]> {
  return (await adapter.inventory({ ...ctx, limits: { maxFiles: 1000, maxReadBytes: 1 << 24 } })).targets;
}

const render = (a: ArgToken) =>
  a.kind === 'word'
    ? a.value
    : a.kind === 'flag'
      ? [a.name, a.value].filter(Boolean).join(a.inline ? '=' : ' ')
      : a.kind;

const request = (targets: readonly TestTarget[], device?: { platform: 'ios' | 'android'; id: string }) => ({
  targets,
  attemptNo: 1,
  options: { timeoutMs: 600_000, coverage: false },
  ...(device ? { device } : {}),
});

describe('AND-002 detection and inventory (fixture-android, static)', () => {
  it('detects the Gradle project and lists one target per JUnit class', async () => {
    expect(await adapter.detect(ctx)).toMatchObject({
      detected: true,
      evidence: ['app/build.gradle.kts'],
      limitations: [],
      runners: [{ kind: 'gradle', configured: true }],
    });
    const targets = await inventory();
    expect(targets.map((t) => [t.path, t.level, t.selector?.value, t.requires.device])).toEqual([
      [
        'app/src/test/java/dev/autotest/fixture/CalculatorTest.java',
        'unit',
        '|:app|unit|dev.autotest.fixture.CalculatorTest',
        'none',
      ],
      [
        'app/src/test/java/dev/autotest/fixture/ScenarioTest.java',
        'unit',
        '|:app|unit|dev.autotest.fixture.ScenarioTest',
        'none',
      ],
      [
        'app/src/androidTest/java/dev/autotest/fixture/CalculatorInstrumentedTest.java',
        'integration',
        '|:app|instrumented|dev.autotest.fixture.CalculatorInstrumentedTest',
        'emulator',
      ],
    ]);
  });

  it('reads include statements and test classes without running Gradle', () => {
    expect(includedProjects(`// include(":old")\ninclude(":app", ":core:data")\ninclude ':lib'\n`)).toEqual([
      ':app',
      ':core:data',
      ':lib',
    ]);
    expect(testClassOf('src/test/kotlin/a/FooTest.kt', 'package a.b\nclass FooTest {\n  @Test fun x() {}\n}')).toBe(
      'a.b.FooTest',
    );
    expect(
      testClassOf('src/test/java/a/Base.java', 'package a;\npublic abstract class Base { @Test public void x(){} }'),
    ).toBeUndefined();
    expect(testClassOf('src/test/java/a/Util.java', 'package a;\npublic class Util {}')).toBeUndefined();
  });

  it('leaves a Flutter project android/ folder to the Flutter adapter', async () => {
    const flutter = { workspace: fixture(path.join(ROOT, 'fixture-flutter')), host: { os: 'macos' as const } };
    expect((await adapter.detect(flutter)).detected).toBe(false);
  });
});

describe('AND-003/004 execution specs', () => {
  it('runs unit classes with the wrapper jar, offline, and collects the JUnit XML', async () => {
    const targets = (await inventory()).filter((t) => t.level === 'unit');
    const specs = buildAndroidExecution(request(targets));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.executable).toBe('java');
    expect(specs[0]!.args.map(render)).toEqual([
      '-classpath gradle/wrapper/gradle-wrapper.jar',
      'org.gradle.wrapper.GradleWrapperMain',
      ':app:testDebugUnitTest',
      '--rerun',
      '--tests dev.autotest.fixture.CalculatorTest',
      '--tests dev.autotest.fixture.ScenarioTest',
      '--offline',
      '--no-daemon',
      '--console=plain',
    ]);
    expect(specs[0]!.collect).toEqual([
      { dir: 'app/build/test-results/testDebugUnitTest', suffix: '.xml', prefix: 'g1' },
    ]);
    expect(specs[0]!.requires).toEqual({ host: 'any', device: 'none' });
  });

  it('runs instrumented classes only with the run emulator, selecting classes and collecting logcat', async () => {
    const targets = await inventory();
    expect(buildAndroidExecution(request(targets))).toEqual([]);
    expect(buildAndroidExecution(request(targets, { platform: 'ios', id: 'X' }))).toEqual([]);
    const specs = buildAndroidExecution(request(targets, { platform: 'android', id: 'emulator-5584' }));
    expect(specs.map((s) => s.args.map(render)[2])).toEqual([
      ':app:connectedDebugAndroidTest',
      ':app:testDebugUnitTest',
    ]);
    expect(specs[0]!.args.map(render)).toContain(
      '--project-prop android.testInstrumentationRunnerArguments.class=dev.autotest.fixture.CalculatorInstrumentedTest',
    );
    expect(specs[0]!.collect).toEqual([
      { dir: 'app/build/outputs/androidTest-results/connected', suffix: '.xml', prefix: 'g1' },
      { dir: 'app/build/outputs/androidTest-results/connected', suffix: '.txt', prefix: 'l1' },
    ]);
    // The serial reaches Gradle only through ANDROID_SERIAL (set by the supervisor), never argv.
    expect(JSON.stringify(specs)).not.toContain('emulator-5584');
  });
});

describe('AND-003/004 JUnit XML parsing (AGP 9.1.0 corpus)', () => {
  const corpus = (f: string) => fs.readFileSync(path.join(CORPUS, f), 'utf8');

  it('maps passed, failed and skipped unit and instrumented tests to their targets', async () => {
    const targets = await inventory();
    const outputs: RunnerOutputs = {
      attemptNo: 1,
      targets,
      files: {
        'attempts/1/runner/g1-debug_TEST-autotest-spike-android_AVD_-_16-_app-.xml': corpus('connected-full.xml'),
        'attempts/1/runner/l1-debug_autotest_logcat-x.txt': 'logcat',
        'attempts/1/runner/g2-TEST-dev.autotest.fixture.CalculatorTest.xml': corpus(
          'TEST-dev.autotest.fixture.CalculatorTest.xml',
        ),
        'attempts/1/runner/g2-TEST-dev.autotest.fixture.ScenarioTest.xml': corpus(
          'TEST-dev.autotest.fixture.ScenarioTest.xml',
        ),
      },
      processes: [{ exitCode: 1 }, { exitCode: 1 }],
      interrupted: false,
    };
    const parsed = parseAndroidResults(outputs);
    expect(Object.fromEntries(parsed.results.map((r) => [r.name, [r.outcome, r.failureKind ?? null]]))).toEqual({
      'CalculatorInstrumentedTest/addIsWrongOnTheDevice': ['failed', 'assertion'],
      'CalculatorInstrumentedTest/runsOnTheDevice': ['passed', null],
      'CalculatorTest/addReturnsTheSum': ['passed', null],
      'CalculatorTest/divideByZeroThrows': ['passed', null],
      'ScenarioTest/addIsWrongOnPurpose': ['failed', 'assertion'],
      'ScenarioTest/skippedOnPurpose': ['skipped', null],
    });
    expect(parsed.results.find((r) => r.name === 'ScenarioTest/addIsWrongOnPurpose')?.messageExcerpt).toMatch(
      /^java\.lang\.AssertionError: fails on purpose expected:<5> but was:<4>/,
    );
    expect(adapter.evidenceHints(outputs).map((h) => [h.kind, h.rel.split('/').pop()])).toEqual([
      ['junit', 'g1-debug_TEST-autotest-spike-android_AVD_-_16-_app-.xml'],
      ['log', 'l1-debug_autotest_logcat-x.txt'],
      ['junit', 'g2-TEST-dev.autotest.fixture.CalculatorTest.xml'],
      ['junit', 'g2-TEST-dev.autotest.fixture.ScenarioTest.xml'],
    ]);
  });

  it('reports a build failure without a report as load_error with Gradle’s explanation', async () => {
    const targets = (await inventory()).filter((t) => t.level === 'unit');
    const parsed = parseAndroidResults({
      attemptNo: 1,
      targets,
      files: {
        'attempts/1/stdout-0.log':
          "> Task :app:compileDebugUnitTestJavaWithJavac FAILED\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':app:compileDebugUnitTestJavaWithJavac'.\n",
      },
      processes: [{ exitCode: 1 }],
      interrupted: false,
    });
    expect(parsed.results.map((r) => [r.outcome, r.failureKind])).toEqual([
      ['failed', 'load_error'],
      ['failed', 'load_error'],
    ]);
    expect(parsed.results[0]!.messageExcerpt).toMatch(/^What went wrong:\nExecution failed for task/);
    const signals = adapter.failureSignals(parsed.results, {
      attemptNo: 1,
      targets,
      files: { 'attempts/1/stdout-0.log': 'SDK location not found. Define a valid SDK location' },
      processes: [{ exitCode: 1 }],
      interrupted: false,
    });
    expect(signals.map((s) => s.signal)).toEqual(['android.sdk_missing']);
  });

  it('decodes only predefined and numeric entities and reads CDATA', () => {
    const xml = `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>
<testsuite><testcase name="a&amp;b" classname="p.C" time="0.5"><error message="m"><![CDATA[boom <here> &e;]]></error></testcase>
<testcase name="&e;" classname="p.C"/></testsuite>`;
    expect(parseJUnitXml(xml)).toEqual([
      { classname: 'p.C', name: 'a&b', timeSeconds: 0.5, outcome: 'error', message: 'boom <here> &e;' },
      { classname: 'p.C', name: '&e;', outcome: 'passed' },
    ]);
  });
});
