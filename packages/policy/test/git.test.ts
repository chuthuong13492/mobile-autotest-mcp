import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, nodeFsPort, validateSpec, type ValidationContext } from '@autotest/policy';
import { tree } from './helpers.ts';

const nfs = nodeFsPort();
const bin = tree({ 'git/bin/git': '#!/bin/sh\n' });
const ws = tree({ 'lib/a.dart': '' });
const runDir = tree();
const ctx: ValidationContext = {
  fs: nfs,
  registry: buildRegistry(nfs, { git: { path: path.join(bin, 'git/bin/git') } }),
  workspaceRoot: ws,
  runDir,
  allowDependencyResolution: false,
};
const SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.process=',
  '-c',
  'filter.lfs.required=false',
];
const w = (value: string): ArgToken => ({ kind: 'word', value });
const spec = (...args: ArgToken[]): ExecutionSpec => ({
  executable: 'git',
  args: [...SAFE.map(w), ...args],
  cwd: '.',
  envNeeds: [],
  expectedOutputs: [],
  timeoutMs: 30_000,
  cancellation: 'process_group',
  requires: { host: 'any', device: 'none' },
});
const run = (s: ExecutionSpec) => {
  const r = validateSpec(s, ctx);
  return r.ok ? { argv: r.argv.slice(SAFE.length), form: r.formId } : r.denials.map((d) => `${d.code}:${d.detail}`);
};
const SHA = 'a'.repeat(40);

describe('ANL-002 git argument schema', () => {
  it('renders the four forms with their fixed safety options', () => {
    expect(run(spec(w('rev-parse'), w('--verify'), w('--quiet'), w('origin/main^{commit}')))).toEqual({
      argv: ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'],
      form: 'git.rev_parse_commit',
    });
    expect(run(spec(w('worktree'), w('add'), w('--detach'), { kind: 'runPath', rel: 'baseline' }, w(SHA)))).toEqual({
      argv: ['worktree', 'add', '--detach', path.join(runDir, 'baseline'), SHA],
      form: 'git.worktree_add',
    });
    expect(run(spec(w('worktree'), w('remove'), w('--force'), { kind: 'runPath', rel: 'baseline' }))).toEqual({
      argv: ['worktree', 'remove', '--force', path.join(runDir, 'baseline')],
      form: 'git.worktree_remove',
    });
    expect(run(spec(w('worktree'), w('prune')))).toEqual({ argv: ['worktree', 'prune'], form: 'git.worktree_prune' });
  });

  it.each([
    ['an option-like ref', [w('rev-parse'), w('--verify'), w('--quiet'), w('--output=x^{commit}')], 'unexpected_token'],
    ['a revision range', [w('rev-parse'), w('--verify'), w('--quiet'), w('a..b^{commit}')], 'unexpected_token'],
    ['a reflog ref', [w('rev-parse'), w('--verify'), w('--quiet'), w('main@{1}^{commit}')], 'unexpected_token'],
    [
      'a short sha',
      [w('worktree'), w('add'), w('--detach'), { kind: 'runPath', rel: 'baseline' }, w('abc')],
      'unexpected_token',
    ],
    [
      'another worktree path',
      [w('worktree'), w('add'), w('--detach'), { kind: 'runPath', rel: 'x' }, w(SHA)],
      'unexpected_token',
    ],
    [
      'a missing commit',
      [w('worktree'), w('add'), w('--detach'), { kind: 'runPath', rel: 'baseline' }],
      'missing_positional',
    ],
    ['an extra positional', [w('worktree'), w('prune'), w('now')], 'unknown_form'],
    ['fetch', [w('fetch'), w('origin')], 'unknown_form'],
    [
      'an upload-pack override',
      [w('worktree'), w('prune'), { kind: 'flag', name: '--upload-pack', value: 'x' }],
      'forbidden_flag',
    ],
  ] as const)('denies %s', (_name, args, code) => {
    const r = run(spec(...(args as unknown as ArgToken[])));
    expect(Array.isArray(r) && r.some((d) => d.startsWith(code)), JSON.stringify(r)).toBe(true);
  });

  it('denies forms without the safety options (hooks would run)', () => {
    const r = validateSpec({ ...spec(), args: [w('worktree'), w('prune')] }, ctx);
    expect(r.ok).toBe(false);
  });
});
