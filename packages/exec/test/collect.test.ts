import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectOutputs, flatName } from '@autotest/exec';
import { nodeFsPort } from '@autotest/policy';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

describe('AND-003 collecting runner outputs from the workspace', () => {
  it('copies fresh regular files with the suffix, flattened, and skips stale files and links', () => {
    const ws = tmp('autotest-col-ws-');
    const dest = tmp('autotest-col-dest-');
    const outside = tmp('autotest-col-out-');
    fs.writeFileSync(path.join(outside, 'secret.xml'), '<secret/>');
    const res = path.join(ws, 'app/build/test-results/testDebugUnitTest');
    fs.mkdirSync(path.join(res, 'binary'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'app/build/outputs/connected/dev ice (AVD) - 16'), { recursive: true });
    fs.writeFileSync(path.join(res, 'TEST-a.B.xml'), '<testsuite/>');
    fs.writeFileSync(path.join(res, 'binary/results.bin'), 'bin');
    fs.writeFileSync(path.join(res, 'TEST-stale.xml'), '<old/>');
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(res, 'TEST-stale.xml'), old, old);
    fs.symlinkSync(path.join(outside, 'secret.xml'), path.join(res, 'TEST-link.xml'));
    fs.symlinkSync(outside, path.join(res, 'linkdir'));
    fs.writeFileSync(path.join(ws, 'app/build/outputs/connected/dev ice (AVD) - 16/logcat-a.B-m.txt'), 'log');

    const got = collectOutputs({
      fs: nodeFsPort(),
      workspaceRoot: ws,
      entries: [
        { dir: 'app/build/test-results/testDebugUnitTest', suffix: '.xml', prefix: 'g1' },
        { dir: 'app/build/outputs/connected', suffix: '.txt', prefix: 'l2' },
        { dir: 'missing/dir', suffix: '.xml', prefix: 'g3' },
      ],
      destDir: dest,
      sinceMs: Date.now() - 60_000,
    });
    expect(got).toEqual({ files: ['g1-TEST-a.B.xml', 'l2-dev_ice_AVD_-_16_logcat-a.B-m.txt'], truncated: false });
    expect(fs.readdirSync(dest).sort()).toEqual(['g1-TEST-a.B.xml', 'l2-dev_ice_AVD_-_16_logcat-a.B-m.txt']);
    expect(fs.readFileSync(path.join(dest, 'g1-TEST-a.B.xml'), 'utf8')).toBe('<testsuite/>');
  });

  it('refuses a directory outside the workspace and keeps long names within 100 characters', () => {
    const ws = tmp('autotest-col-ws-');
    const dest = tmp('autotest-col-dest-');
    const outside = tmp('autotest-col-out-');
    fs.writeFileSync(path.join(outside, 'a.xml'), '<x/>');
    fs.symlinkSync(outside, path.join(ws, 'escape'));
    expect(
      collectOutputs({
        fs: nodeFsPort(),
        workspaceRoot: ws,
        entries: [{ dir: 'escape', suffix: '.xml', prefix: 'g1' }],
        destDir: dest,
        sinceMs: 0,
      }).files,
    ).toEqual([]);
    const long = flatName('g1', `${'d'.repeat(120)}/TEST-x.xml`);
    expect(long.length).toBe(100);
    expect(long.endsWith('_TEST-x.xml')).toBe(true);
  });
});
