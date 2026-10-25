import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { directoryUsage, launchDetachedNode, LaunchError, nodeExecPort, watchQuota } from '@autotest/exec';
import { tmp } from './helpers.ts';

describe('EXE-004 disk quota', () => {
  it('measures usage without following symlinks and stops early above a bound', () => {
    const d = tmp('autotest-q-');
    fs.mkdirSync(path.join(d, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a/one'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(d, 'a/b/two'), Buffer.alloc(3000));
    const outside = tmp('autotest-q-out-');
    fs.writeFileSync(path.join(outside, 'huge'), Buffer.alloc(100_000));
    fs.symlinkSync(outside, path.join(d, 'link'));
    expect(directoryUsage(d)).toEqual({ bytes: 4000, files: 2, partial: false });
    expect(directoryUsage(d, 500).partial).toBe(true);
  });

  it('counts the space a sparse file occupies, not its apparent size (Xcode compilation caches)', () => {
    const d = tmp('autotest-q-sparse-');
    fs.writeFileSync(path.join(d, 'cache.data'), '');
    fs.truncateSync(path.join(d, 'cache.data'), 16 * 1024 ** 3);
    fs.writeFileSync(path.join(d, 'real'), Buffer.alloc(3000, 1));
    const u = directoryUsage(d);
    expect(u.files).toBe(2);
    expect(u.bytes).toBeLessThan(1024 * 1024);
    expect(u.bytes).toBeGreaterThanOrEqual(3000);
  });

  it('fires once on breach', () => {
    const d = tmp('autotest-q2-');
    const hits: number[] = [];
    const w = watchQuota([d], 2000, 60_000, (u) => hits.push(u));
    expect(w.check()).toBe(false);
    fs.writeFileSync(path.join(d, 'f'), Buffer.alloc(5000));
    expect(w.check()).toBe(true);
    expect(w.check()).toBe(true);
    w.stop();
    expect(hits).toEqual([5000]);
  });

  it('reports that rlimits are not available rather than claiming them', () => {
    expect(nodeExecPort().capabilities.rlimits).toBe(false);
  });
});

describe('EXE-003 support: launchDetachedNode validation', () => {
  it('accepts only absolute script entries and plain-token arguments', () => {
    const base = { cwd: '/', logFile: '/dev/null' };
    expect(() => launchDetachedNode({ ...base, entry: 'relative.ts', args: [] })).toThrow(LaunchError);
    expect(() => launchDetachedNode({ ...base, entry: '/x/y.sh', args: [] })).toThrow(LaunchError);
    expect(() => launchDetachedNode({ ...base, entry: '/x/y.ts', args: ['a;b'] })).toThrow(LaunchError);
    expect(() => launchDetachedNode({ ...base, entry: '/x/y.ts', args: ['--inspect'] })).toThrow(LaunchError);
    expect(() => launchDetachedNode({ ...base, entry: '/x/y.ts', args: [], env: { NODE_OPTIONS: 'a b' } })).toThrow(
      LaunchError,
    );
  });
});
