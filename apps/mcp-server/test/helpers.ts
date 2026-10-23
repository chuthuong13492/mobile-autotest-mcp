import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh data root (parent dir private) with an optional config.yaml. */
export function dataRoot(config?: string): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-mcp-')));
  const root = path.join(base, 'data');
  fs.mkdirSync(root, { mode: 0o700 });
  if (config !== undefined) fs.writeFileSync(path.join(root, 'config.yaml'), config);
  return root;
}
