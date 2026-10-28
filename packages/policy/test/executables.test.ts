import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, nodeFsPort, validateSpec, type ValidationContext } from '@autotest/policy';
import { tree } from './helpers.ts';

const nfs = nodeFsPort();
const bin = tree({ 'flutter/bin/flutter': '#!/bin/sh\n' });
const flutterPath = path.join(bin, 'flutter/bin/flutter');
const ws = tree({ 'test/widgets/badge_test.dart': '', 'lib/main.dart': '', 'test/helpers.dart': '' });
const runDir = tree();
const outsideDir = tree({ 'x_test.dart': '' });
fs.symlinkSync(outsideDir, path.join(ws, 'test/linked'));

const registry = buildRegistry(nfs, { flutter: { path: flutterPath } });
const ctx: ValidationContext = { fs: nfs, registry, workspaceRoot: ws, runDir, allowDependencyResolution: false };

const w = (value: string): ArgToken => ({ kind: 'word', value });
const f = (name: string, value?: string, inline?: boolean): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
  ...(inline ? { inline } : {}),
});
const spec = (args: ArgToken[], over: Partial<ExecutionSpec> = {}): ExecutionSpec => ({
  executable: 'flutter',
  args,
  cwd: '.',
  envNeeds: [],
  expectedOutputs: [],
  timeoutMs: 60_000,
  cancellation: 'graceful_then_group',
  requires: { host: 'any', device: 'none' },
  ...over,
});
const testArgs = (...extra: ArgToken[]): ArgToken[] => [w('test'), f('--no-pub'), ...extra];
const codes = (s: ExecutionSpec, c: ValidationContext = ctx) => {
  const r = validateSpec(s, c);
  return r.ok ? [] : r.denials.map((d) => `${d.code}:${d.detail}`);
};

describe('POL-003 executable registry', () => {
  it('pins by realpath and optional sha256', () => {
    expect(registry.executables.get('flutter')?.realPath).toBe(flutterPath);
    const pinned = buildRegistry(nfs, { flutter: { path: flutterPath, sha256: nfs.sha256(flutterPath) } });
    expect(pinned.problems).toEqual([]);
    const wrong = buildRegistry(nfs, { flutter: { path: flutterPath, sha256: `sha256:${'0'.repeat(64)}` } });
    expect(wrong.problems).toEqual([{ logical: 'flutter', reason: 'hash_mismatch' }]);
    expect(wrong.executables.size).toBe(0);
    expect(buildRegistry(nfs, { flutter: { path: '/no/such/flutter' } }).problems[0]?.reason).toBe('missing');
    expect(buildRegistry(nfs, { flutter: { path: bin } }).problems[0]?.reason).toBe('not_a_file');
  });
});

describe('POL-003 validateSpec', () => {
  it('renders a valid adapter spec into argv with resolved paths', () => {
    const r = validateSpec(
      spec(
        testArgs(
          { kind: 'flagRunPath', name: '--file-reporter', rel: 'results/flutter.json', prefix: 'json:' },
          f('--reporter', 'silent'),
          f('--plain-name', 'Badge shows count'),
          f('--timeout', '30s'),
          f('--coverage'),
          { kind: 'flagRunPath', name: '--coverage-path', rel: 'coverage/lcov.info' },
          { kind: 'workspacePath', rel: 'test/widgets/badge_test.dart' },
        ),
      ),
      ctx,
    );
    expect(r).toEqual({
      ok: true,
      executablePath: flutterPath,
      cwd: ws,
      formId: 'flutter.test',
      class: 'test_runner',
      env: {},
      pathAppend: [],
      argv: [
        'test',
        '--no-pub',
        '--file-reporter',
        `json:${path.join(runDir, 'results/flutter.json')}`,
        '--reporter',
        'silent',
        '--plain-name',
        'Badge shows count',
        '--timeout',
        '30s',
        '--coverage',
        '--coverage-path',
        path.join(runDir, 'coverage/lcov.info'),
        path.join(ws, 'test/widgets/badge_test.dart'),
      ],
    });
  });

  it('accepts the version probe and gates pub get behind allowDependencyResolution', () => {
    expect(validateSpec(spec([f('--version'), f('--machine')]), ctx)).toMatchObject({
      ok: true,
      class: 'probe',
      argv: ['--version', '--machine'],
    });
    const pub = spec([w('pub'), w('get'), f('--enforce-lockfile')]);
    expect(codes(pub)).toEqual(['gated:flutter.pub_get']);
    expect(validateSpec(pub, { ...ctx, allowDependencyResolution: true })).toMatchObject({
      ok: true,
      class: 'build_tool',
    });
    expect(codes(spec([w('pub'), w('get')]), { ...ctx, allowDependencyResolution: true })).toEqual([
      'missing_flag:--enforce-lockfile',
    ]);
    expect(codes(spec([f('--version'), f('--machine')]), { ...ctx, allowedClasses: ['test_runner'] })).toEqual([
      'class_not_allowed:flutter.version',
    ]);
  });

  const smuggling: [string, ExecutionSpec, string[]][] = [
    ['unknown executable', spec(testArgs(), { executable: 'bash' }), ['unknown_executable:bash']],
    ['unknown subcommand', spec([w('run'), f('--no-pub')]), ['unknown_form:flutter']],
    ['extra word after form', spec(testArgs(w('; rm -rf /'))), ['unexpected_token:#2']],
    ['forbidden --update-goldens', spec(testArgs(f('--update-goldens'))), ['forbidden_flag:--update-goldens']],
    ['forbidden --start-paused', spec(testArgs(f('--start-paused'))), ['forbidden_flag:--start-paused']],
    ['unknown flag', spec(testArgs(f('--dart-define', 'X=1'))), ['unknown_flag:--dart-define']],
    ['missing --no-pub', spec([w('test')]), ['missing_flag:--no-pub']],
    ['value on a boolean flag', spec(testArgs(f('--coverage', 'yes'))), ['bad_value:--coverage']],
    ['enum violation', spec(testArgs(f('--reporter', 'html'))), ['bad_value:--reporter']],
    ['flag-looking separate value', spec(testArgs(f('--name', '--update-goldens'))), ['bad_value:--name']],
    [
      'duplicate non-repeatable flag',
      spec(testArgs(f('--reporter', 'silent'), f('--reporter', 'json'))),
      ['duplicate_flag:--reporter'],
    ],
    [
      'runPath flag given a literal value',
      spec(testArgs(f('--coverage-path', '/etc/x'))),
      ['bad_value:--coverage-path'],
    ],
    [
      'wrong runPath prefix',
      spec(testArgs({ kind: 'flagRunPath', name: '--file-reporter', rel: 'r.json', prefix: 'junit:' })),
      ['bad_value:--file-reporter'],
    ],
    ['positional runPath', spec(testArgs({ kind: 'runPath', rel: 'x' })), ['unexpected_token:#2']],
    ['non-test positional file', spec(testArgs({ kind: 'workspacePath', rel: 'lib/main.dart' })), ['path_denied:#2']],
    [
      'missing test file',
      spec(testArgs({ kind: 'workspacePath', rel: 'test/missing_test.dart' })),
      ['path_denied:#2:not_found'],
    ],
    [
      'symlink escape via test dir',
      spec(testArgs({ kind: 'workspacePath', rel: 'test/linked/x_test.dart' })),
      ['path_denied:#2:symlink_escape'],
    ],
    ['cwd outside workspace', spec(testArgs(), { cwd: 'test/linked' }), ['cwd_denied:symlink_escape']],
    ['cwd is a file', spec(testArgs(), { cwd: 'lib/main.dart' }), ['cwd_denied:not_a_directory']],
    ['probe with extra flag', spec([f('--version'), f('--machine'), f('--verbose')]), ['unknown_flag:--verbose']],
  ];
  for (const [name, s, expected] of smuggling) {
    it(`denies: ${name}`, () => expect(codes(s)).toEqual(expected));
  }

  it('renders inline values, including ones that start with a dash', () => {
    const r = validateSpec(spec(testArgs(f('--name', '-negative case', true))), ctx);
    expect(r.ok && r.argv).toEqual(['test', '--no-pub', '--name=-negative case']);
  });
});
