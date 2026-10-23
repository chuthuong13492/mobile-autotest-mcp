import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedWorkspace } from '@autotest/policy';

/** A temp workspace with the given files; returns it as a resolved workspace. */
export function workspace(files: Record<string, string | Buffer> = {}): ResolvedWorkspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ws-')));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { id: 'ws_test', configuredPath: root, realPath: root, readOnlyReference: false };
}
