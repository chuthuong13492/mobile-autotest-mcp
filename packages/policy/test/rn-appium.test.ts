import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, nodeFsPort, validateSpec, type ValidationContext } from '@autotest/policy';
import { tree } from './helpers.ts';

const nfs = nodeFsPort();
const bin = tree({
  'b/node': '#!/bin/sh\n',
  'b/maestro': '#!/bin/sh\n',
  'b/appium': '#!/bin/sh\n',
  'b/xcrun': '',
  'b/adb': '',
});
const ws = tree({
  'node_modules/jest/bin/jest.js': '',
  'node_modules/detox/local-cli/cli.js': '',
  'node_modules/.bin/jest': '',
  'node_modules/evil/index.js': '',
  '__tests__/a.test.ts': '',
  'e2e/app.test.js': '',
  '.maestro/flow.yaml': '',
  'appium/run.mjs': '',
  'ios/build/App.app/Info.plist': '',
  'android/app.apk': '',
});
const runDir = tree({ 'attempts/1/runner/.keep': '' });
const ctx: ValidationContext = {
  fs: nfs,
  registry: buildRegistry(
    nfs,
    Object.fromEntries(['node', 'maestro', 'appium', 'xcrun', 'adb'].map((n) => [n, { path: path.join(bin, 'b', n) }])),
  ),
  workspaceRoot: ws,
  runDir,
  allowDependencyResolution: false,
};
const w = (value: string): ArgToken => ({ kind: 'word', value });
const f = (name: string, value?: string): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
});
const p = (rel: string): ArgToken => ({ kind: 'workspacePath', rel });
const r = (name: string, rel: string): ArgToken => ({ kind: 'flagRunPath', name, rel });
const spec = (executable: string, args: ArgToken[], extra: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  executable,
  args,
  cwd: '.',
  envNeeds: [],
  expectedOutputs: [],
  timeoutMs: 60_000,
  cancellation: 'graceful_then_group',
  requires: { host: 'any', device: 'none' },
  ...extra,
});
const codes = (s: ExecutionSpec) => {
  const v = validateSpec(s, ctx);
  return v.ok ? [] : v.denials.map((d) => `${d.code}:${d.detail}`);
};
const UDID = 'A59793A1-207D-4223-9A07-7A25E3124218';

describe('RN-002/003 node schema (the workspace Jest and Detox, never npx)', () => {
  it('runs Jest as the first argument, with JSON into the run directory', () => {
    const jest = [
      p('node_modules/jest/bin/jest.js'),
      f('--ci'),
      f('--json'),
      r('--outputFile', 'attempts/1/runner/jest.json'),
      f('--runTestsByPath'),
      p('__tests__/a.test.ts'),
    ];
    const v = validateSpec(spec('node', jest), ctx);
    expect(v).toMatchObject({ ok: true, formId: 'node.jest' });
    expect(v.ok && v.argv[0]).toBe(path.join(ws, 'node_modules/jest/bin/jest.js'));
    // Nothing may come before the script, and other node_modules scripts are not runners.
    expect(codes(spec('node', [f('--require', 'x'), ...jest]))[0]).toMatch(/unknown_form|path_denied/);
    expect(codes(spec('node', [p('node_modules/evil/index.js'), f('--scenario', 'x')]))).toEqual(['unknown_form:node']);
    expect(codes(spec('node', [...jest, f('--config', 'x.js')]))).toEqual(['forbidden_flag:--config']);
  });

  it('runs Detox test with a run-directory config and puts node_modules/.bin at the end of PATH', () => {
    const v = validateSpec(
      spec('node', [
        p('node_modules/detox/local-cli/cli.js'),
        w('test'),
        r('--config-path', 'attempts/1/runner/detox.config.js'),
        f('--configuration', 'ios.sim.release'),
        p('e2e/app.test.js'),
      ]),
      ctx,
    );
    expect(v).toMatchObject({ ok: true, formId: 'node.detox.test', pathAppend: [path.join(ws, 'node_modules/.bin')] });
    // `detox build` runs a shell command from the project: not allowed.
    expect(
      codes(spec('node', [p('node_modules/detox/local-cli/cli.js'), w('build'), f('--configuration', 'x')])),
    ).toEqual(['unknown_form:node']);
  });

  it('runs a scenario runner script of the workspace with a scenario name only', () => {
    expect(
      codes(spec('node', [p('appium/run.mjs'), f('--scenario', 'counterIncrements'), f('--port', '4725')])),
    ).toEqual([]);
    expect(codes(spec('node', [p('appium/run.mjs'), f('--scenario', '$(id)')]))).toEqual(['bad_value:--scenario']);
  });
});

describe('RN-003 Maestro schema', () => {
  it('runs flows under .maestro on one device, with analytics off', () => {
    const v = validateSpec(
      spec('maestro', [
        w('test'),
        f('--udid', UDID),
        f('--format', 'JUNIT'),
        r('--output', 'attempts/1/runner/m.xml'),
        p('.maestro/flow.yaml'),
      ]),
      ctx,
    );
    expect(v).toMatchObject({ ok: true, env: { MAESTRO_CLI_NO_ANALYTICS: '1' } });
    expect(codes(spec('maestro', [w('cloud'), p('.maestro/flow.yaml')]))).toEqual(['unknown_form:maestro']);
    expect(
      codes(
        spec('maestro', [
          w('test'),
          f('--udid', UDID),
          f('--format', 'JUNIT'),
          r('--output', 'attempts/1/runner/m.xml'),
          f('--api-key', 'k'),
        ]),
      ),
    ).toEqual(['forbidden_flag:--api-key']);
  });
});

describe('APM-001 Appium schema', () => {
  it('serves on 127.0.0.1 in the allowed port range only, without insecure features', () => {
    const server = (address: string, port: string, ...extra: ArgToken[]) =>
      spec('appium', [w('server'), f('--address', address), f('--port', port), ...extra]);
    expect(codes(server('127.0.0.1', '4725'))).toEqual([]);
    expect(codes(server('0.0.0.0', '4725'))).toEqual(['bad_value:--address']);
    expect(codes(server('127.0.0.1', '8080'))).toEqual(['bad_value:--port']);
    expect(codes(server('127.0.0.1', '4725', f('--relaxed-security')))).toEqual(['forbidden_flag:--relaxed-security']);
    expect(codes(spec('appium', [w('driver'), w('install'), w('uiautomator2')]))).toEqual(['unknown_form:appium']);
  });
});

describe('RN-003 app install forms', () => {
  it('installs only .app bundles and .apk packages from the workspace', () => {
    expect(codes(spec('xcrun', [w('simctl'), w('install'), w(UDID), p('ios/build/App.app')]))).toEqual([]);
    expect(codes(spec('adb', [w('install'), w('-r'), p('android/app.apk')]))).toEqual([]);
    expect(codes(spec('adb', [w('install'), w('-r'), p('appium/run.mjs')]))[0]).toMatch(/^path_denied/);
  });
});
