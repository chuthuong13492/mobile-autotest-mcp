import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, nodeFsPort, validateSpec, type ValidationContext } from '@autotest/policy';
import { tree } from './helpers.ts';

const nfs = nodeFsPort();
const bin = tree({ 'jdk/bin/java': '#!/bin/sh\n' });
const ws = tree({
  'gradle/wrapper/gradle-wrapper.jar': 'jar',
  'android/gradle/wrapper/gradle-wrapper.jar': 'jar',
  'libs/evil.jar': 'jar',
  'app/build.gradle.kts': '',
});
const runDir = tree({ 'attempts/1/runner/.keep': '' });
const ctx: ValidationContext = {
  fs: nfs,
  registry: buildRegistry(nfs, { java: { path: path.join(bin, 'jdk/bin/java') } }),
  workspaceRoot: ws,
  runDir,
  allowDependencyResolution: false,
};
const w = (value: string): ArgToken => ({ kind: 'word', value });
const f = (name: string, value?: string, inline?: boolean): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
  ...(inline ? { inline } : {}),
});
const spec = (args: ArgToken[], extra: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  executable: 'java',
  args,
  cwd: '.',
  envNeeds: [],
  expectedOutputs: [],
  timeoutMs: 60_000,
  cancellation: 'graceful_then_group',
  requires: { host: 'any', device: 'none' },
  ...extra,
});
const JAR = f('-classpath', 'gradle/wrapper/gradle-wrapper.jar');
const MAIN = w('org.gradle.wrapper.GradleWrapperMain');
const TAIL = [f('--offline'), f('--no-daemon'), f('--console', 'plain', true)];
const codes = (s: ExecutionSpec) => {
  const v = validateSpec(s, ctx);
  return v.ok ? [] : v.denials.map((d) => `${d.code}:${d.detail}`);
};

describe('AND-003/004 java argument schema (the Gradle wrapper jar, never gradlew)', () => {
  it('renders the unit and instrumented forms with the jar resolved inside the workspace', () => {
    const unit = validateSpec(
      spec([JAR, MAIN, w(':app:testDebugUnitTest'), f('--rerun'), f('--tests', 'dev.x.CalculatorTest'), ...TAIL]),
      ctx,
    );
    expect(unit).toMatchObject({
      ok: true,
      class: 'test_runner',
      argv: [
        '-classpath',
        path.join(ws, 'gradle/wrapper/gradle-wrapper.jar'),
        'org.gradle.wrapper.GradleWrapperMain',
        ':app:testDebugUnitTest',
        '--rerun',
        '--tests',
        'dev.x.CalculatorTest',
        '--offline',
        '--no-daemon',
        '--console=plain',
      ],
    });
    expect(
      codes(
        spec([
          f('-classpath', 'android/gradle/wrapper/gradle-wrapper.jar'),
          MAIN,
          w(':app:connectedDebugAndroidTest'),
          f('--project-prop', 'android.testInstrumentationRunnerArguments.class=dev.x.A,dev.x.B#m'),
          ...TAIL,
        ]),
      ),
    ).toEqual([]);
  });

  it('accepts only the wrapper jar as the classpath, and only as the first token', () => {
    expect(codes(spec([f('-classpath', 'libs/evil.jar'), MAIN, w('testDebugUnitTest'), ...TAIL]))).toEqual([
      'bad_value:-classpath',
    ]);
    expect(
      codes(spec([f('-classpath', 'x/gradle/wrapper/gradle-wrapper.jar'), MAIN, w('testDebugUnitTest'), ...TAIL])),
    ).toEqual(['path_denied:-classpath']);
    // A JVM option or runner flag before the jar, or anything between the jar and the main class: no form matches.
    expect(codes(spec([f('--offline'), JAR, MAIN, w('testDebugUnitTest'), ...TAIL]))).toEqual(['unknown_form:java']);
    expect(codes(spec([JAR, f('--offline'), MAIN, w('testDebugUnitTest'), ...TAIL]))).toEqual(['unknown_form:java']);
    expect(codes(spec([JAR, w('com.evil.Main'), w('testDebugUnitTest'), ...TAIL]))).toEqual(['unknown_form:java']);
  });

  it('refuses other tasks, init scripts, properties and online or daemon builds', () => {
    expect(codes(spec([JAR, MAIN, w('assembleRelease'), ...TAIL]))).toEqual([
      'unexpected_token:#2',
      'missing_positional:#0',
    ]);
    expect(codes(spec([JAR, MAIN, w('testDebugUnitTest'), w('publish'), ...TAIL]))).toEqual(['unexpected_token:#3']);
    expect(codes(spec([JAR, MAIN, w('testDebugUnitTest'), f('--init-script', 'x.gradle'), ...TAIL]))).toEqual([
      'forbidden_flag:--init-script',
    ]);
    expect(
      codes(spec([JAR, MAIN, w('testDebugUnitTest'), f('--project-prop', 'org.gradle.jvmargs=-Xmx9g'), ...TAIL])),
    ).toEqual(['bad_value:--project-prop']);
    expect(codes(spec([JAR, MAIN, w('testDebugUnitTest'), f('--no-daemon'), f('--console', 'plain', true)]))).toEqual([
      'missing_flag:--offline',
    ]);
    expect(codes(spec([JAR, MAIN, w('testDebugUnitTest'), f('--daemon'), ...TAIL]))).toEqual([
      'forbidden_flag:--daemon',
    ]);
  });

  it('checks collect directories inside the workspace', () => {
    const args = [JAR, MAIN, w('testDebugUnitTest'), ...TAIL];
    expect(codes(spec(args, { collect: [{ dir: 'app/build/test-results', suffix: '.xml', prefix: 'g1' }] }))).toEqual(
      [],
    );
    expect(
      codes(spec(args, { collect: [{ dir: 'app/../../etc', suffix: '.xml', prefix: 'g1' }] })).length,
    ).toBeGreaterThan(0);
  });
});
