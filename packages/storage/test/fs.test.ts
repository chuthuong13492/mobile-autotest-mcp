import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DATA_ROOT_DIRS,
  InsecureDataRootError,
  TMP_SUFFIX,
  appendLineSync,
  atomicWriteSync,
  ensureDataRoot,
} from '@autotest/storage';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-fs-'));

describe('STO-001 data root', () => {
  it('creates the root and subdirectories with mode 0700', () => {
    const root = path.join(tmp(), 'data');
    ensureDataRoot(root);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    for (const d of DATA_ROOT_DIRS) expect(fs.statSync(path.join(root, d)).isDirectory()).toBe(true);
  });

  it('refuses a group/world-accessible root', () => {
    const root = tmp();
    fs.chmodSync(root, 0o755);
    expect(() => ensureDataRoot(root)).toThrow(InsecureDataRootError);
  });

  it('refuses a symlinked root', () => {
    const real = tmp();
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(real, link);
    expect(() => ensureDataRoot(link)).toThrow(InsecureDataRootError);
  });
});

describe('STO-001 atomic writes', () => {
  it('writes with mode 0600 and replaces atomically', () => {
    const f = path.join(tmp(), 'a.json');
    atomicWriteSync(f, 'one');
    atomicWriteSync(f, 'two');
    expect(fs.readFileSync(f, 'utf8')).toBe('two');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['a.json']);
  });

  it('a crash before rename leaves the old content intact and only a temp leftover', () => {
    const dir = tmp();
    const f = path.join(dir, 'a.json');
    atomicWriteSync(f, 'old');
    expect(() =>
      atomicWriteSync(f, 'new', {
        beforeRename: () => {
          throw new Error('crash');
        },
      }),
    ).toThrow('crash');
    expect(fs.readFileSync(f, 'utf8')).toBe('old');
    const leftovers = fs.readdirSync(dir).filter((n) => TMP_SUFFIX.test(n));
    expect(leftovers).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, leftovers[0]!), 'utf8')).toBe('new');
  });

  it('refuses to write or append through a symlink', () => {
    const dir = tmp();
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'keep');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(victim, link);
    expect(() => atomicWriteSync(link, 'x')).toThrow(/symlink/);
    expect(() => appendLineSync(link, 'x')).toThrow(/symlink/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep');
  });

  it('appendLineSync returns the starting offset of each line', () => {
    const f = path.join(tmp(), 'log.ndjson');
    expect(appendLineSync(f, 'ab')).toBe(0);
    expect(appendLineSync(f, 'cde')).toBe(3);
    expect(fs.readFileSync(f, 'utf8')).toBe('ab\ncde\n');
  });
});

describe('MCP-002 per-install keys', () => {
  it('creates a private 32-byte key once and refuses unsafe key files', async () => {
    const { loadOrCreateKey, dataRootPaths: paths, ensureDataRoot: ensure } = await import('@autotest/storage');
    const root = path.join(tmp(), 'data');
    ensure(root);
    const k1 = loadOrCreateKey(root, 'cursor');
    expect(k1).toHaveLength(32);
    expect(loadOrCreateKey(root, 'cursor').equals(k1)).toBe(true);
    const file = paths(root).key('cursor');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.chmodSync(file, 0o644);
    expect(() => loadOrCreateKey(root, 'cursor')).toThrow(InsecureDataRootError);
    fs.rmSync(file);
    fs.symlinkSync(path.join(tmp(), 'elsewhere.key'), file);
    expect(() => loadOrCreateKey(root, 'cursor')).toThrow();
  });
});
