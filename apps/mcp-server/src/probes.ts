/**
 * Toolchain probes (INS-001; TL-02; ADR-0014). Each probe kind maps to one fixed ExecutionSpec that the policy
 * argument schema classifies as `probe`; it runs through `exec` (re-validated, minimal environment, no shell) with a
 * 10 s timeout and a 64 KiB output cap, in a scratch directory under the data root that is removed afterwards.
 * Kinds without a schema report `available: false` rather than running anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProbeKind, ProbePort } from '@autotest/adapter-sdk';
import { createIdGenerator, type ExecutionSpec } from '@autotest/core';
import { spawnSpec, terminateGroup, type ExecPort } from '@autotest/exec';
import { buildRegistry, envSecretResolver, nodeFsPort, type PolicyConfig } from '@autotest/policy';

const PROBES: Partial<Record<ProbeKind, ExecutionSpec>> = {
  flutter_version: {
    executable: 'flutter',
    args: [
      { kind: 'flag', name: '--version' },
      { kind: 'flag', name: '--machine' },
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: 10_000,
    cancellation: 'process_group',
    requires: { host: 'any', device: 'none' },
  },
  appium_version: {
    executable: 'appium',
    args: [{ kind: 'flag', name: '--version' }],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: 30_000,
    cancellation: 'process_group',
    requires: { host: 'any', device: 'none' },
  },
  appium_drivers: {
    executable: 'appium',
    args: [
      { kind: 'word', value: 'driver' },
      { kind: 'word', value: 'list' },
      { kind: 'flag', name: '--installed' },
      { kind: 'flag', name: '--json' },
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: 60_000,
    cancellation: 'process_group',
    requires: { host: 'any', device: 'none' },
  },
};

export interface ProbePortOptions {
  readonly config: PolicyConfig;
  readonly dataRoot: string;
  /** Canonical root of the workspace being inspected (the probe's cwd). */
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly timeoutMs?: number;
  readonly port?: ExecPort;
  /** The server's environment: probes see only its policy `env.allow` variables (APM-001: APPIUM_HOME). */
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
}

export function createProbePort(o: ProbePortOptions): ProbePort {
  const fsp = nodeFsPort();
  const registry = buildRegistry(fsp, o.config.executables);
  const ids = createIdGenerator();
  return {
    async probe(kind, executable) {
      const base = PROBES[kind];
      if (!base) return { available: false, reason: 'no_probe_schema' };
      // An alias of the probe's own executable only (`flutter@<label>` for `flutter`).
      if (executable && executable !== base.executable && !executable.startsWith(`${base.executable}@`))
        return { available: false, reason: 'executable_mismatch' };
      const spec = executable ? { ...base, executable } : base;
      if (!registry.executables.has(spec.executable)) return { available: false, reason: 'executable_not_allowlisted' };
      const dir = path.join(o.dataRoot, 'tmp', 'probes', ids.newId('prb'));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const spawned = await spawnSpec(spec, {
          fs: fsp,
          registry,
          workspaceRoot: o.workspaceRoot,
          runDir: dir,
          allowDependencyResolution: false,
          allowedClasses: ['probe'],
          runId: 'probe',
          workspaceId: o.workspaceId,
          envPolicy: o.config.env,
          parentEnv: o.parentEnv ?? {},
          resolver: envSecretResolver({}),
          home: path.join(dir, 'home'),
          tmpDir: path.join(dir, 'tmp'),
          stdoutPath: path.join(dir, 'stdout.log'),
          stderrPath: path.join(dir, 'stderr.log'),
          outputCapBytes: 64 * 1024,
          ...(o.port ? { port: o.port } : {}),
        });
        if (!spawned.ok) return { available: false, reason: `denied:${spawned.denials.map((d) => d.code).join(',')}` };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<'timeout'>((res) => {
          timer = setTimeout(() => res('timeout'), o.timeoutMs ?? spec.timeoutMs);
        });
        const exit = await Promise.race([spawned.process.exited, timedOut]);
        clearTimeout(timer);
        if (exit === 'timeout') {
          await terminateGroup(spawned.process.identity, { graceMs: 1000, ...(o.port ? { port: o.port } : {}) });
          await spawned.process.exited;
          return { available: false, reason: 'timeout' };
        }
        return {
          available: true,
          stdout: fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8'),
          exitCode: exit.exitCode ?? -1,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
