/** Test helpers: a private temp directory tree and an injectable FsPort. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeFsPort, type FsPort } from '@autotest/policy';

export function tree(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-pol-')));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** Node FsPort with case sensitivity forced (to exercise both comparison modes on any host). */
export function fsWithCase(caseInsensitive: boolean): FsPort {
  return { ...nodeFsPort(), isCaseInsensitive: () => caseInsensitive };
}
