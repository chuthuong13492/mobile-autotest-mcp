/** Test helper: a fresh, migrated data root in a private temp directory. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDataRoot } from '@autotest/storage';

export function freshRoot(): { root: string; open: () => ReturnType<typeof openDataRoot> } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-sto-'));
  const root = path.join(base, 'data');
  return { root, open: () => openDataRoot(root) };
}
