/**
 * Every test run gets its own temporary directory (TMPDIR for the test workers and the processes they start), and
 * it is removed when the run ends. Suites create fixtures with `fs.mkdtempSync(os.tmpdir())`; without this, each run
 * left them behind (28 GB had accumulated on the development Mac by 2026-10-25).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default function setup(): () => void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-vitest-')));
  const previous = process.env['TMPDIR'];
  process.env['TMPDIR'] = dir;
  return () => {
    if (previous === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previous;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
}
