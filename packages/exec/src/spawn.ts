/**
 * Shell-free spawner (EXE-001; SR-002, SR-013; ADR-0014; T-03).
 *
 * `spawnSpec` is the only way to start a test process. It never trusts an earlier decision: it re-validates the
 * spec against the executable/argument policy, builds the child environment from the allowlist (plus the run
 * marker `AUTOTEST_RUN_ID`), then spawns with `shell: false` in a new process group with stdin closed. Arguments are
 * passed as a literal argv, so shell metacharacters have no meaning. stdout/stderr go to capped files.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ExecutionSpec, ProcessIdentity } from '@autotest/contracts';
import {
  buildChildEnv,
  validateSpec,
  type Denial,
  type EnvDenialCode,
  type PolicyConfig,
  type SecretResolver,
  type ValidationContext,
} from '@autotest/policy';
import { identify } from './identity.ts';
import { captureCapped, DEFAULT_OUTPUT_CAP } from './limits.ts';
import { nodeExecPort, type ExecPort } from './port.ts';

export const RUN_MARKER_ENV = 'AUTOTEST_RUN_ID';

export interface SpawnContext extends ValidationContext {
  readonly runId: string;
  readonly workspaceId: string;
  readonly envPolicy: PolicyConfig['env'];
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly resolver: SecretResolver;
  /** Run-scoped HOME and TMPDIR (created here if missing). */
  readonly home: string;
  readonly tmpDir: string;
  /** Files for raw output (must not exist yet). */
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly outputCapBytes?: number;
  readonly port?: ExecPort;
  /**
   * The run's leased Android emulator (AND-004): set as `ANDROID_SERIAL`, which adb and the Android Gradle plugin use
   * to pick the device, so argv never carries a serial and a run cannot reach another device.
   */
  readonly androidSerial?: string;
}

export interface ExitInfo {
  readonly exitCode?: number;
  readonly signal?: string;
  readonly stdout: { bytesWritten: number; bytesSeen: number; truncated: boolean };
  readonly stderr: { bytesWritten: number; bytesSeen: number; truncated: boolean };
}

export interface ManagedProcess {
  readonly identity: ProcessIdentity & { readonly executable: string };
  readonly argv: readonly string[];
  readonly cwd: string;
  /** Secret values delivered to the child; the caller registers them with the run's redactor. */
  readonly secretValues: readonly string[];
  readonly exited: Promise<ExitInfo>;
}

export type SpawnOutcome =
  | { readonly ok: true; readonly process: ManagedProcess }
  | {
      readonly ok: false;
      readonly denials: readonly (Denial | { readonly code: EnvDenialCode; readonly detail: string })[];
    };

export async function spawnSpec(spec: ExecutionSpec, ctx: SpawnContext): Promise<SpawnOutcome> {
  const port = ctx.port ?? nodeExecPort();
  const v = validateSpec(spec, ctx);
  if (!v.ok) return { ok: false, denials: v.denials };

  const env = await buildChildEnv({
    env: ctx.envPolicy,
    workspaceId: ctx.workspaceId,
    needs: spec.envNeeds,
    home: ctx.home,
    tmpDir: ctx.tmpDir,
    executableDir: path.dirname(v.executablePath),
    parentEnv: ctx.parentEnv,
    resolver: ctx.resolver,
  });
  if (!env.ok) return { ok: false, denials: env.denials.map((d) => ({ code: d.code, detail: d.name })) };

  for (const d of [ctx.home, ctx.tmpDir, path.dirname(ctx.stdoutPath), path.dirname(ctx.stderrPath)])
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const child = port.spawn({
    file: v.executablePath,
    argv: v.argv,
    cwd: v.cwd,
    env: {
      ...env.env,
      ...(ctx.androidSerial ? { ANDROID_SERIAL: ctx.androidSerial } : {}),
      [RUN_MARKER_ENV]: ctx.runId,
    },
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  if (child.pid === undefined) {
    const e = await exitPromise.then(
      () => undefined,
      (err: unknown) => err,
    );
    throw new Error(`spawn failed: ${(e as Error | undefined)?.message ?? 'unknown'}`);
  }
  const cap = ctx.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  const out = captureCapped(child.stdout!, ctx.stdoutPath, cap);
  const err = captureCapped(child.stderr!, ctx.stderrPath, cap);
  // The child leads its own group (detached), so pgid = pid; the start time is read from the OS.
  const live = identify(port, child.pid, v.executablePath);
  const identity = {
    pid: child.pid,
    pgid: live?.pgid ?? child.pid,
    startTime: live?.startTime ?? 'unknown',
    executable: v.executablePath,
  };

  const exited = Promise.all([exitPromise, out.done, err.done]).then(([x, o, e]) => ({
    ...(x.code === null ? {} : { exitCode: x.code }),
    ...(x.signal === null ? {} : { signal: x.signal }),
    stdout: o,
    stderr: e,
  }));
  return { ok: true, process: { identity, argv: v.argv, cwd: v.cwd, secretValues: env.secretValues, exited } };
}
