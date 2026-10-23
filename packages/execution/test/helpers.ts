/** Fixtures: a data root with a user config, a workspace and a fake `flutter` whose behaviour is the --plain-name. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionSpec } from '@autotest/core';
import type { RunHeader } from '@autotest/execution';

const FAKE_FLUTTER = `#!/bin/sh
mode=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--plain-name" ]; then mode="$a"; fi
  prev="$a"
done
case "$mode" in
  ok) echo "all tests passed" ;;
  fail) echo "1 test failed" >&2; exit 1 ;;
  sleep1) /bin/sleep 1; echo done ;;
  sleep) /bin/sleep 60 ;;
  ignore-term) trap '' TERM; echo ready; /bin/sleep 60 ;;
  write-big) /bin/dd if=/dev/zero of="$HOME/big.bin" bs=1024 count=4096 2>/dev/null; /bin/sleep 60 ;;
  *) exit 3 ;;
esac
`;

let counter = 0;
export const runId = () => `run_01JC${String(++counter).padStart(2, '0')}${'A'.repeat(20)}`;

export function env() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-exe-')));
  const dataRoot = path.join(base, 'data');
  fs.mkdirSync(dataRoot, { mode: 0o700 });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flutter'), FAKE_FLUTTER, { mode: 0o755 });
  const ws = path.join(base, 'ws');
  fs.mkdirSync(path.join(ws, 'test'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'test/a_test.dart'), '');
  fs.writeFileSync(
    path.join(dataRoot, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }, { id: ws_ref, path: ${ws}, readOnlyReference: true }]\nexecutables: { flutter: { path: ${path.join(bin, 'flutter')} } }\n`,
  );
  return { base, dataRoot, ws };
}

export function spec(mode: string, extra: ExecutionSpec['args'] = []): ExecutionSpec {
  return {
    executable: 'flutter',
    args: [
      { kind: 'word', value: 'test' },
      { kind: 'flag', name: '--no-pub' },
      { kind: 'flag', name: '--plain-name', value: mode },
      ...extra,
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: 60_000,
    cancellation: 'graceful_then_group',
    requires: { host: 'any', device: 'none' },
  };
}

export function header(id: string, specs: ExecutionSpec[], over: Partial<RunHeader> = {}): RunHeader {
  return {
    runId: id,
    workspaceId: 'ws_app',
    authorizationDigest: `sha256:${'a'.repeat(64)}`,
    specs,
    timeouts: { runMs: 60_000 },
    graceMs: 1000,
    heartbeatMs: 100,
    cancelVerifyWindowMs: 600_000,
    diskQuotaBytes: 512 * 1024 * 1024,
    outputCapBytes: 1024 * 1024,
    ...over,
  };
}

export async function until<T>(f: () => T | undefined, ms = 20_000, step = 50): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, step));
  }
}
