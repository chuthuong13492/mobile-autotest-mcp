/** Real-process fixtures: a fake `flutter` script whose behaviour is chosen by the `--plain-name` value. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { buildRegistry, envSecretResolver, loadPolicyConfig, nodeFsPort } from '@autotest/policy';
import type { SpawnContext } from '@autotest/exec';

const FAKE_FLUTTER = `#!/bin/sh
mode=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--plain-name" ]; then mode="$a"; fi
  prev="$a"
done
case "$mode" in
  echo-args) printf '%s\\n' "$@" ;;
  env) /usr/bin/env | /usr/bin/sort ;;
  ignore-term) trap '' TERM; echo ready; /bin/sleep 60 ;;
  sleep) /bin/sleep 60 ;;
  bg-child) /bin/sleep 60 & /bin/sleep 60 ;;
  flood) /usr/bin/yes autotest | /usr/bin/head -c 300000 ;;
  write-big) /bin/dd if=/dev/zero of="$HOME/big.bin" bs=1024 count=4096 2>/dev/null; /bin/sleep 60 ;;
  *) echo "unknown mode" >&2; exit 3 ;;
esac
`;

export function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function fixture() {
  const bin = tmp('autotest-bin-');
  const flutter = path.join(bin, 'flutter');
  fs.writeFileSync(flutter, FAKE_FLUTTER, { mode: 0o755 });
  const ws = tmp('autotest-ws-');
  fs.mkdirSync(path.join(ws, 'test'));
  fs.writeFileSync(path.join(ws, 'test/a_test.dart'), '');
  const runDir = tmp('autotest-run-');
  const policy = loadPolicyConfig(
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nenv: { allow: [JAVA_HOME] }\n`,
  );
  if (!policy.ok) throw new Error('policy');
  const fsp = nodeFsPort();
  let n = 0;
  const ctx = (over: Partial<SpawnContext> = {}): SpawnContext => {
    n++;
    return {
      fs: fsp,
      registry: buildRegistry(fsp, { flutter: { path: flutter } }),
      workspaceRoot: ws,
      runDir,
      allowDependencyResolution: false,
      runId: 'run_01JCAAAAAAAAAAAAAAAAAAAAAA',
      workspaceId: 'ws_app',
      envPolicy: policy.policy.config.env,
      parentEnv: { JAVA_HOME: '/opt/jdk', CANARY_PARENT: 'must-not-leak', PATH: '/evil' },
      resolver: envSecretResolver({}),
      home: path.join(runDir, 'home'),
      tmpDir: path.join(runDir, 'tmp'),
      stdoutPath: path.join(runDir, `attempts/1/stdout-${n}.log`),
      stderrPath: path.join(runDir, `attempts/1/stderr-${n}.log`),
      ...over,
    };
  };
  return { flutter, ws, runDir, ctx };
}

export function spec(mode: string, extra: ArgToken[] = []): ExecutionSpec {
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
