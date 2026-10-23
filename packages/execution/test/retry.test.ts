import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedResult } from '@autotest/adapter-sdk';
import type { TestTarget } from '@autotest/core';
import { readRunnerOutputs, retryClassOf, selectRetryTargets } from '@autotest/execution';

const target = (id: string): TestTarget => ({
  id,
  adapterId: 'flutter',
  level: 'unit',
  path: `test/${id}_test.dart`,
  platforms: ['host'],
  requires: { host: 'any', device: 'none' },
  tags: [],
});
const r = (targetId: string, outcome: NormalizedResult['outcome'], failureKind?: NormalizedResult['failureKind']) =>
  ({ targetId, name: 't', outcome, rawStatus: outcome, ...(failureKind ? { failureKind } : {}) }) as NormalizedResult;

describe('RUN-005 retry selection', () => {
  it('retries failures (flaky-eligible) and infra errors only, in target order', () => {
    const targets = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(target);
    const results = [
      r('g', 'failed', 'assertion'),
      r('a', 'failed', 'exception'),
      r('b', 'failed', 'load_error'),
      r('c', 'infra_error'),
      r('d', 'blocked'),
      r('e', 'cancelled'),
      r('f', 'passed'),
      r('f', 'skipped'),
    ];
    expect(selectRetryTargets(results, targets, ['flaky', 'infrastructure']).map((t) => t.id)).toEqual(['a', 'c', 'g']);
    expect(selectRetryTargets(results, targets, ['infrastructure']).map((t) => t.id)).toEqual(['c']);
    expect(selectRetryTargets(results, targets, []).map((t) => t.id)).toEqual([]);
    expect(retryClassOf(r('x', 'timed_out'))).toBeUndefined();
  });

  it('reads regular runner files with a cap and skips symlinks', () => {
    const run = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ro-')));
    const dir = path.join(run, 'attempts/2/runner');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'flutter.jsonl'), 'x'.repeat(100));
    fs.writeFileSync(path.join(run, 'secret'), 'nope');
    fs.symlinkSync(path.join(run, 'secret'), path.join(dir, 'link.jsonl'));
    const files = readRunnerOutputs(run, 2, 10);
    expect(files).toEqual({ 'attempts/2/runner/flutter.jsonl': 'x'.repeat(10) });
    expect(readRunnerOutputs(run, 3)).toEqual({});
  });
});
