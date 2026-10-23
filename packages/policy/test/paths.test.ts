import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPath, findWorkspace, nodeFsPort, resolveWorkspaces } from '@autotest/policy';
import { fsWithCase, tree } from './helpers.ts';

const nfs = nodeFsPort();

describe('POL-002 checkPath', () => {
  const root = tree({ 'lib/a.dart': '', 'test/a_test.dart': '' });
  const outside = tree({ 'secret.txt': 'x' });
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'lib'), path.join(root, 'inside-link'));

  it('allows contained paths, existing or not', () => {
    expect(checkPath(nfs, root, 'test/a_test.dart')).toMatchObject({
      ok: true,
      exists: true,
      path: path.join(root, 'test/a_test.dart'),
    });
    expect(checkPath(nfs, root, 'build/out/new.json')).toMatchObject({ ok: true, exists: false });
    expect(checkPath(nfs, root, path.join(root, 'lib'))).toMatchObject({ ok: true });
    expect(checkPath(nfs, root, '.')).toMatchObject({ ok: true, path: root });
    expect(checkPath(nfs, root, 'inside-link/a.dart')).toMatchObject({ ok: true, path: path.join(root, 'lib/a.dart') });
  });

  const traversal: [string, string][] = [
    ['../x', 'outside_root'],
    ['lib/../../x', 'outside_root'],
    ['/etc/passwd', 'outside_root'],
    [`${root}-sibling/x`, 'outside_root'],
    ['escape/secret.txt', 'symlink_escape'],
    ['escape/not-yet', 'symlink_escape'],
    ['%2e%2e/x', 'invalid'],
    ['lib%2Fa.dart', 'invalid'],
    ['..\\x', 'invalid'],
    ['a\0b', 'invalid'],
    ['a\nb', 'invalid'],
    ['', 'invalid'],
  ];
  for (const [candidate, reason] of traversal) {
    it(`denies ${JSON.stringify(candidate)} as ${reason}`, () => {
      expect(checkPath(nfs, root, candidate)).toEqual({ ok: false, reason });
    });
  }

  it('mustExist, unavailable root', () => {
    expect(checkPath(nfs, root, 'nope.dart', { mustExist: true })).toEqual({ ok: false, reason: 'not_found' });
    expect(checkPath(nfs, path.join(root, 'missing-root'), 'x')).toEqual({ ok: false, reason: 'root_unavailable' });
    expect(checkPath(nfs, 'relative/root', 'x')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('compares case-insensitively only on case-insensitive filesystems', () => {
    const upper = root.toUpperCase();
    // A candidate spelled in a different case than the canonical root.
    expect(checkPath(fsWithCase(true), root, `${upper}/lib/a.dart`).ok).toBe(true);
    expect(checkPath(fsWithCase(false), root, `${upper}/lib/a.dart`)).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('normalizes Unicode to NFC before comparing', () => {
    const r = tree({ 'café/x_test.dart': '' });
    const decomposed = 'café/x_test.dart';
    const res = checkPath(nfs, r, decomposed);
    expect(res.ok).toBe(true);
  });
});

describe('POL-002 workspaces', () => {
  const a = tree();
  const link = path.join(tree(), 'link-to-a');
  fs.symlinkSync(a, link);
  const resolution = resolveWorkspaces(nfs, [
    { id: 'ws_a', path: link, readOnlyReference: false },
    { id: 'ws_ref', path: tree(), readOnlyReference: true },
    { id: 'ws_gone', path: '/definitely/not/here', readOnlyReference: false },
  ]);

  it('canonicalizes roots at load time and reports unavailable ones', () => {
    expect(resolution.workspaces.map((w) => [w.id, w.realPath === a || w.readOnlyReference])).toEqual([
      ['ws_a', true],
      ['ws_ref', true],
    ]);
    expect(resolution.unavailable).toEqual(['ws_gone']);
  });

  it('finds a workspace by id or by a path that canonicalizes to its root', () => {
    expect(findWorkspace(nfs, resolution, 'ws_a')?.id).toBe('ws_a');
    expect(findWorkspace(nfs, resolution, a)?.id).toBe('ws_a');
    expect(findWorkspace(nfs, resolution, link)?.id).toBe('ws_a');
    expect(findWorkspace(nfs, resolution, path.join(a, 'sub'))).toBeUndefined();
    expect(findWorkspace(nfs, resolution, 'ws_gone')).toBeUndefined();
    expect(findWorkspace(nfs, resolution, 'relative')).toBeUndefined();
  });
});
