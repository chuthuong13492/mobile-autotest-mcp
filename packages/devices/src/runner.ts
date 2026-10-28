/**
 * Runs device tools (DEV-001, DEV-002): every call is validated against the executable's argument schema and spawned
 * through the exec port, shell-free. The child gets a minimal environment: PATH (the tool's own directory first),
 * the real HOME (simulators live under ~/Library, AVDs under ~/.android), the SDK variables the tools need, and
 * `ANDROID_SERIAL` to address one emulator (argv never carries a serial).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ArgToken, ExecutionSpec } from '@autotest/contracts';
import { nodeExecPort, type ExecPort } from '@autotest/exec';
import { validateSpec, type FsPort, type Registry } from '@autotest/policy';

export interface DeviceContext {
  readonly fs: FsPort;
  readonly registry: Registry;
  /** A private directory: the tools' working directory, emulator logs, and (as run dir) screenshot outputs. */
  readonly workDir: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly port?: ExecPort;
}

export type ToolResult =
  | { readonly status: 'ok'; readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  | { readonly status: 'missing' }
  | { readonly status: 'denied'; readonly codes: readonly string[] };

const PASS_ENV = [
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'ANDROID_AVD_HOME',
  'ANDROID_EMULATOR_HOME',
  'JAVA_HOME',
  'DEVELOPER_DIR',
];

export const word = (value: string): ArgToken => ({ kind: 'word', value });
export const flag = (name: string, value?: string): ArgToken => ({
  kind: 'flag',
  name,
  ...(value === undefined ? {} : { value }),
});

function validated(
  ctx: DeviceContext,
  executable: string,
  args: readonly ArgToken[],
  runDir: string,
  workspaceRoot = ctx.workDir,
) {
  fs.mkdirSync(ctx.workDir, { recursive: true, mode: 0o700 });
  const spec: ExecutionSpec = {
    executable,
    args: [...args],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [],
    timeoutMs: 600_000,
    cancellation: 'process_group',
    requires: { host: 'any', device: 'none' },
  };
  return validateSpec(spec, {
    fs: ctx.fs,
    registry: ctx.registry,
    workspaceRoot,
    runDir,
    allowDependencyResolution: false,
    allowedClasses: ['probe', 'device_tool'],
  });
}

function childEnv(ctx: DeviceContext, exeDir: string, serial?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [
      exeDir,
      ...(ctx.parentEnv['JAVA_HOME'] ? [path.join(ctx.parentEnv['JAVA_HOME'], 'bin')] : []),
      '/usr/bin',
      '/bin',
    ].join(':'),
    HOME: ctx.parentEnv['HOME'] ?? '',
    LANG: 'en_US.UTF-8',
  };
  for (const k of PASS_ENV) if (ctx.parentEnv[k]) env[k] = ctx.parentEnv[k]!;
  if (serial) env['ANDROID_SERIAL'] = serial;
  return env;
}

/** Runs a tool to completion and captures its output (stdout to `stdoutFile` instead, for binary output). */
export async function runTool(
  ctx: DeviceContext,
  executable: string,
  args: readonly ArgToken[],
  o: {
    readonly serial?: string;
    readonly timeoutMs?: number;
    readonly stdoutFile?: string;
    readonly runDir?: string;
    /** Canonical workspace root that `workspacePath` tokens resolve in (RN-003 app installs). */
    readonly workspaceRoot?: string;
  } = {},
): Promise<ToolResult> {
  if (!ctx.registry.executables.has(executable)) return { status: 'missing' };
  const v = validated(ctx, executable, args, o.runDir ?? ctx.workDir, o.workspaceRoot);
  if (!v.ok) return { status: 'denied', codes: v.denials.map((d) => `${d.code}:${d.detail}`) };
  fs.mkdirSync(ctx.workDir, { recursive: true, mode: 0o700 });
  const child = (ctx.port ?? nodeExecPort()).spawn({
    file: v.executablePath,
    argv: v.argv,
    cwd: v.cwd,
    env: childEnv(ctx, path.dirname(v.executablePath), o.serial),
  });
  let stdout = '';
  let stderr = '';
  const sink = o.stdoutFile ? fs.createWriteStream(o.stdoutFile, { mode: 0o600 }) : undefined;
  child.stdout?.on('data', (d: Buffer) => {
    if (sink) sink.write(d);
    else if (stdout.length < 4 * 1024 * 1024) stdout += d.toString('utf8');
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString('utf8');
  });
  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, o.timeoutMs ?? 60_000);
    child.on('error', () => resolve(127));
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? 1);
    });
  });
  if (sink) await new Promise<void>((r) => sink.end(r));
  return { status: 'ok', exitCode, stdout, stderr: stderr.slice(0, 8192) };
}

/** Starts a long-running tool (the Android emulator) detached in its own process group; its output goes to `logFile`. */
export function startDetached(
  ctx: DeviceContext,
  executable: string,
  args: readonly ArgToken[],
  logFile: string,
):
  | { readonly status: 'ok'; readonly pid: number }
  | { readonly status: 'missing' }
  | { readonly status: 'denied'; readonly codes: readonly string[] } {
  if (!ctx.registry.executables.has(executable)) return { status: 'missing' };
  const v = validated(ctx, executable, args, ctx.workDir);
  if (!v.ok) return { status: 'denied', codes: v.denials.map((d) => `${d.code}:${d.detail}`) };
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const { pid } = (ctx.port ?? nodeExecPort()).spawnDetached({
    file: v.executablePath,
    argv: v.argv,
    cwd: v.cwd,
    env: childEnv(ctx, path.dirname(v.executablePath)),
    logFile,
  });
  return { status: 'ok', pid };
}
