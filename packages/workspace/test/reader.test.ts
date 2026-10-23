import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkspaceReader, readGitInfo, stripUrlCredentials, WorkspaceError } from '@autotest/workspace';
import { workspace } from './helpers.ts';

const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-outside-')));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-content');
fs.writeFileSync(path.join(outside, 'x_test.dart'), '');

describe('WS-001 readText', () => {
  const ws = workspace({
    'lib/a.dart': 'void main() {}\n',
    'big.txt': 'x'.repeat(5000),
    'bin.dat': Buffer.from([1, 0, 2, 3]),
  });
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws.realPath, 'lib/escape.txt'));
  const r = createWorkspaceReader(ws);

  it('reads within limits and reports truncation', () => {
    expect(r.readText('lib/a.dart')).toEqual({
      text: 'void main() {}\n',
      sizeBytes: 15,
      truncated: false,
      binary: false,
    });
    expect(r.readText('big.txt', 100)).toMatchObject({ sizeBytes: 5000, truncated: true });
    expect(r.readText('big.txt', 100).text).toHaveLength(100);
    expect(r.readText('bin.dat')).toMatchObject({ binary: true, text: '' });
  });

  it('refuses escapes, missing files, directories and bad limits', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as WorkspaceError).code;
      }
      return 'ok';
    };
    expect(code(() => r.readText('lib/escape.txt'))).toBe('E_PATH_ESCAPE');
    expect(code(() => r.readText('../etc/passwd'))).toBe('E_PATH_ESCAPE');
    expect(code(() => r.readText('%2e%2e/x'))).toBe('E_PATH_ESCAPE');
    expect(code(() => r.readText('nope.txt'))).toBe('E_NOT_FOUND');
    expect(code(() => r.readText('lib'))).toBe('E_VALIDATION');
    expect(code(() => r.readText('lib/a.dart', 0))).toBe('E_VALIDATION');
    expect(r.exists('lib/a.dart')).toBe(true);
    expect(r.exists('lib/escape.txt')).toBe(false);
    expect(r.exists('../x')).toBe(false);
  });
});

describe('WS-001 list', () => {
  const ws = workspace({
    'test/a_test.dart': '',
    'test/sub/b_test.dart': '',
    'test/helpers.dart': '',
    'lib/c.dart': '',
    'build/generated_test.dart': '',
    '.dart_tool/x_test.dart': '',
    'test/legacy/old_test.dart': '',
  });
  fs.symlinkSync(outside, path.join(ws.realPath, 'test/linked-dir'));
  fs.symlinkSync(path.join(outside, 'x_test.dart'), path.join(ws.realPath, 'test/linked_test.dart'));
  fs.symlinkSync(path.join(ws.realPath, 'test/a_test.dart'), path.join(ws.realPath, 'test/alias_test.dart'));
  const r = createWorkspaceReader(ws);

  it('lists matches, skips excluded dirs and never follows symlinks out of the root', () => {
    const out = r.list(['test/**/*_test.dart', 'build/**', '.dart_tool/**'], { exclude: ['test/legacy/**'] });
    expect(out.files).toEqual(['test/a_test.dart', 'test/alias_test.dart', 'test/sub/b_test.dart']);
    expect(out).toMatchObject({ truncated: false, matched: 3, skippedSymlinks: 2 });
  });

  it('enforces maxFiles and maxScanned and reports both', () => {
    expect(r.list(['**/*.dart'], { maxFiles: 2 })).toMatchObject({
      truncated: true,
      truncatedBy: ['maxFiles'],
      matched: 6,
    });
    expect(r.list(['**/*.dart'], { maxFiles: 2 }).files).toHaveLength(2);
    expect(r.list(['**'], { maxScanned: 3 })).toMatchObject({
      truncated: true,
      truncatedBy: expect.arrayContaining(['maxScanned']),
    });
  });

  it('rejects bad globs', () => {
    expect(() => r.list(['../**'])).toThrow(WorkspaceError);
    expect(() => r.list([])).toThrow(WorkspaceError);
  });

  it('stress: 200,000 files are listed within limits and reported as truncated', () => {
    const big = workspace();
    for (let d = 0; d < 200; d++) {
      const dir = path.join(big.realPath, `test/d${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 1000; f++) fs.writeFileSync(path.join(dir, `f${f}_test.dart`), '');
    }
    const reader = createWorkspaceReader(big);
    const t0 = performance.now();
    const res = reader.list(['test/**/*_test.dart'], { maxFiles: 5000 });
    const ms = performance.now() - t0;
    expect(res).toMatchObject({ matched: 200_000, truncated: true, truncatedBy: ['maxFiles'] });
    expect(res.files).toHaveLength(5000);
    expect(ms).toBeLessThan(30_000);
    const capped = reader.list(['test/**/*_test.dart'], { maxScanned: 50_000 });
    expect(capped.truncatedBy).toContain('maxScanned');
    expect(capped.scanned).toBe(50_000);
  }, 300_000);
});

describe('WS-001 git metadata', () => {
  it('reads HEAD, loose and packed refs and remotes without credentials', () => {
    const sha = 'a'.repeat(40);
    const ws = workspace({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs\n${sha} refs/heads/main\n`,
      '.git/config':
        '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://user:tok3n@github.com/example/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "fork"]\n\turl = git@github.com:me/app.git\n',
    });
    const info = readGitInfo(createWorkspaceReader(ws));
    expect(info).toEqual({
      headSha: sha,
      branch: 'main',
      detached: false,
      remotes: [
        { name: 'origin', url: 'https://github.com/example/app.git' },
        { name: 'fork', url: 'git@github.com:me/app.git' },
      ],
      limitations: [],
    });
    fs.mkdirSync(path.join(ws.realPath, '.git/refs/heads'), { recursive: true });
    fs.writeFileSync(path.join(ws.realPath, '.git/refs/heads/main'), `${'b'.repeat(40)}\n`);
    expect(readGitInfo(createWorkspaceReader(ws))?.headSha).toBe('b'.repeat(40));
  });

  it('handles detached heads, unresolved refs, non-repos and gitdir files pointing outside', () => {
    expect(readGitInfo(createWorkspaceReader(workspace({ '.git/HEAD': `${'c'.repeat(40)}\n` })))).toMatchObject({
      headSha: 'c'.repeat(40),
      detached: true,
    });
    expect(readGitInfo(createWorkspaceReader(workspace({ '.git/HEAD': 'ref: refs/heads/gone\n' })))).toMatchObject({
      headSha: null,
      limitations: ['ref_unresolved'],
    });
    expect(readGitInfo(createWorkspaceReader(workspace({ 'a.txt': '' })))).toBeNull();
    expect(readGitInfo(createWorkspaceReader(workspace({ '.git': `gitdir: ${outside}\n` })))).toMatchObject({
      limitations: ['gitdir_outside_root'],
    });
    const inner = workspace({ '.gitdirs/wt/HEAD': `${'d'.repeat(40)}\n` });
    fs.writeFileSync(path.join(inner.realPath, '.git'), 'gitdir: .gitdirs/wt\n');
    expect(readGitInfo(createWorkspaceReader(inner))?.headSha).toBe('d'.repeat(40));
    expect(stripUrlCredentials('ssh://u@h/x')).toBe('ssh://h/x');
  });
});
