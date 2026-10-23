import { describe, expect, it } from 'vitest';
import { GlobError, compileGlob } from '@autotest/workspace';

const m = (g: string, p: string) => compileGlob(g).test(p);

describe('WS-001 glob', () => {
  it('matches segments, globstars, classes and braces', () => {
    expect(m('test/**/*_test.dart', 'test/a_test.dart')).toBe(true);
    expect(m('test/**/*_test.dart', 'test/x/y/a_test.dart')).toBe(true);
    expect(m('test/**/*_test.dart', 'lib/a_test.dart')).toBe(false);
    expect(m('*.dart', 'a/b.dart')).toBe(false);
    expect(m('**', 'a/b/c')).toBe(true);
    expect(m('lib/**', 'lib/a/b.dart')).toBe(true);
    expect(m('{lib,test}/*.dart', 'test/a.dart')).toBe(true);
    expect(m('file?.txt', 'file1.txt')).toBe(true);
    expect(m('file[!0-9].txt', 'file1.txt')).toBe(false);
    expect(m('a.b', 'aXb')).toBe(false);
    expect(m('.github/**', '.github/workflows/ci.yml')).toBe(true);
  });

  it('rejects absolute, traversing, malformed and oversized patterns', () => {
    for (const g of ['/etc/*', '../*', 'a/../b', 'a\\b', '{a,b', '[abc', '', 'x'.repeat(600)])
      expect(() => compileGlob(g)).toThrow(GlobError);
  });
});
