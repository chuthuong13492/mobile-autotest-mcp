/**
 * Composition root (MCP-001). Opens the data root (0700) and its SQLite index, loads the user policy (absence is
 * recorded, not fatal: tools that need policy fail with `E_POLICY_UNAVAILABLE`), builds the logger, wires ports
 * into the workflow and constructs the server. `close()` releases only this process's resources: run supervisors
 * are detached processes and keep running (ADR-0007 §6).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCursorCodec,
  createIdGenerator,
  createMetricsRegistry,
  type Logger,
  type MetricsRegistry,
} from '@autotest/core';
import { createAdapterRegistry, type PlatformAdapter } from '@autotest/adapter-sdk';
import { launchSupervisor } from '@autotest/execution';
import { builtInAdapters } from './adapters.ts';
import { supervisorEntryPath } from './supervisorPath.ts';
import { runUseCases } from './tools/runs.ts';
import { evidenceUseCases } from './tools/evidence.ts';
import { publishUseCases } from './tools/publish.ts';
import { deviceUseCases } from './tools/devices.ts';
import { createGitHubAccess } from './github.ts';
import { loadPolicyConfig, type PolicyLoadResult } from '@autotest/policy';
import { loadOrCreateKey, openDataRoot } from '@autotest/storage';
import {
  bindUseCases,
  pumpQueue,
  reconcileRuns,
  serverEnvironmentOf,
  type RunDeps,
  type UseCases,
  type WorkflowPorts,
} from '@autotest/workflow';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServerLogger, type ServerLoggerOptions } from './log.ts';
import { createToolPipeline, type ToolPipeline } from './middleware/pipeline.ts';
import { createAutotestServer } from './server.ts';
import { createProbePort } from './probes.ts';
import { notImplementedUseCases, withUseCases } from './stubs.ts';
import { inspectUseCases } from './tools/inspect.ts';
import { planningUseCases } from './tools/planning.ts';
import { coverageUseCases } from './tools/coverage.ts';
import { approvalUseCases } from './tools/approvals.ts';
import { elicitApproval } from './elicitation.ts';

export const SERVER_VERSION = '1.1.0';

export interface ComposeOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly dataRoot?: string;
  readonly stderr?: ServerLoggerOptions['stderr'];
  /** Replace the use cases entirely (tests). */
  readonly useCases?: (ports: WorkflowPorts, policy: PolicyLoadResult) => UseCases;
  /** Platform adapters to register (default: the built-in adapters, currently Flutter). */
  readonly adapters?: readonly PlatformAdapter[];
  /** GitHub API override for tests (a local mock server); production uses https://api.github.com. */
  readonly github?: { readonly baseUrl?: string; readonly fetch?: typeof fetch };
  /** Absolute path of the supervisor entrypoint (tests; default: the app's own). */
  readonly supervisorEntry?: string;
  /** Skip startup reconciliation and the queue timer (tests that drive them explicitly). */
  readonly background?: boolean;
  /** This server's environment for approval bindings (default `local:<hostname>`). */
  readonly serverEnvironment?: { readonly id: string; readonly kind: 'local' | 'ci' };
  /** Clock override (OPS-006 clock-skew tests); default: the system clock. */
  readonly clock?: { readonly now: () => Date };
}

export interface Composed {
  readonly server: McpServer;
  readonly logger: Logger;
  readonly dataRoot: string;
  readonly policy: PolicyLoadResult;
  readonly ports: WorkflowPorts;
  readonly metrics: MetricsRegistry;
  /** The middleware-wrapped tool surface (what the MCP server calls). */
  readonly call: ToolPipeline;
  close(): Promise<void>;
}

export function resolveDataRoot(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['AUTOTEST_HOME'];
  return configured && path.isAbsolute(configured) ? configured : path.join(env['HOME'] ?? os.homedir(), '.autotest');
}

export async function composeServer(opts: ComposeOptions = {}): Promise<Composed> {
  const env = opts.env ?? process.env;
  const dataRoot = opts.dataRoot ?? resolveDataRoot(env);
  const { sql, stores } = openDataRoot(dataRoot);
  const logger = createServerLogger({
    env,
    piiSalt: dataRoot,
    logDir: path.join(dataRoot, 'logs'),
    ...(opts.stderr ? { stderr: opts.stderr } : {}),
  });

  let configText: string | undefined;
  try {
    configText = fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8');
  } catch {
    configText = undefined;
  }
  const policy = loadPolicyConfig(configText);
  const ids = createIdGenerator();
  const clock = opts.clock ?? { now: () => new Date() };
  if (policy.ok) {
    const { policyVersion, gatePolicyVersion, riskPolicyVersion } = policy.policy;
    await stores.audit.append({
      ts: clock
        .now()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
      actor: 'server',
      kind: 'config.loaded',
      subjectRefs: [],
      data: { policyVersion, gatePolicyVersion, riskPolicyVersion },
    });
    logger.info('config.loaded', { data: { policyVersion } });
  } else logger.warn('config.unavailable', { code: policy.error.error.code });

  const { idempotency, ...domainStores } = stores;
  const ports: WorkflowPorts = {
    clock,
    ids,
    ...domainStores,
    execution: {
      startSupervisor: async (runId) =>
        launchSupervisor(
          dataRoot,
          runId,
          supervisorEnv(env, policy.ok ? policy.policy.config.env.allow : []),
          undefined,
          opts.supervisorEntry ?? supervisorEntryPath(),
        ),
    },
    cursors: createCursorCodec(loadOrCreateKey(dataRoot, 'cursor'), clock),
  };
  const registry = createAdapterRegistry(opts.adapters ?? builtInAdapters());
  const host = {
    os:
      process.platform === 'darwin'
        ? ('macos' as const)
        : process.platform === 'win32'
          ? ('windows' as const)
          : ('linux' as const),
  };
  const implemented = inspectUseCases({
    ports,
    policy,
    registry,
    host,
    ...(policy.ok
      ? {
          probes: (ws) =>
            createProbePort({ config: policy.policy.config, dataRoot, workspaceRoot: ws.realPath, workspaceId: ws.id }),
        }
      : {}),
  });
  const github = policy.ok
    ? createGitHubAccess({
        policy: policy.policy,
        dataRoot,
        env,
        ...(opts.github?.baseUrl ? { baseUrl: opts.github.baseUrl } : {}),
        ...(opts.github?.fetch ? { fetch: opts.github.fetch } : {}),
      })
    : undefined;
  const planning = planningUseCases({ ports, policy, registry, host, ...(github ? { github } : {}) });
  const serverEnvironment = opts.serverEnvironment ?? serverEnvironmentOf(env);
  const coverage = coverageUseCases({ ports, policy, serverEnvironment });
  const approvals = approvalUseCases({ ports, policy, serverEnvironment });
  const runDeps: RunDeps = { ports, policy, registry, serverEnvironment, dataRoot, host };
  const runs = runUseCases(runDeps);
  const evidence = evidenceUseCases(runDeps);
  const publish = publishUseCases({
    ports,
    policy,
    serverEnvironment,
    ...(github ? { github: (h: string) => github.client(h) } : {}),
  });
  const devices = deviceUseCases({
    ports,
    policy,
    dataRoot,
    hostOs: host.os,
    serverEnvironment,
    parentEnv: env,
  });
  const workflow = bindUseCases(
    opts.useCases
      ? opts.useCases(ports, policy)
      : withUseCases(notImplementedUseCases(), {
          ...implemented,
          ...planning,
          ...coverage,
          ...approvals,
          ...runs,
          ...evidence,
          ...publish,
          ...devices,
        }),
  );
  const sessionId = ids.newId('ses');
  const metrics = createMetricsRegistry();
  const call = createToolPipeline({
    workflow,
    audit: stores.audit,
    idempotency,
    logger: logger.child({ sessionId }),
    metrics,
    now: () => clock.now(),
    sessionId,
    newToolCallId: () => ids.newId('call'),
    policyAvailable: policy.ok,
  });
  const server = createAutotestServer({
    call,
    version: SERVER_VERSION,
    postProcess: (name, args, result, ctx, mcp) =>
      name === 'request_approval'
        ? elicitApproval(
            { ports, policy, serverEnvironment, clientCapabilities: () => mcp.server.getClientCapabilities() },
            args,
            result,
            ctx,
          )
        : Promise.resolve(result),
  });

  // RUN-006: reconcile runs left by an earlier server, then keep the queue moving while this server lives.
  let pumpTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.background !== false && policy.ok) {
    try {
      await reconcileRuns(runDeps);
    } catch (e) {
      logger.warn('reconcile.failed', { data: { error: (e as Error).name } });
    }
    pumpTimer = setInterval(() => void pumpQueue(runDeps).catch(() => undefined), 2000);
    pumpTimer.unref();
  }

  let closed = false;
  return {
    server,
    logger,
    dataRoot,
    policy,
    ports,
    metrics,
    call,
    async close() {
      if (closed) return;
      closed = true;
      if (pumpTimer) clearInterval(pumpTimer);
      await server.close();
      sql.close();
      logger.info('server.stopped');
    },
  };
}

/** The variables a supervisor needs from the server: the host id (shared environment binding) and nothing else. */
/**
 * The supervisor's environment: the host id, plus the variables the policy allowlists for runs (`env.allow`, whose
 * names the config schema already vets), so they can reach the runner (FL-006: ANDROID_HOME, JAVA_HOME,
 * GRADLE_USER_HOME for Android builds). Nothing else from the server's environment is passed on.
 */
function supervisorEnv(
  env: Readonly<Record<string, string | undefined>>,
  allow: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const id = env['AUTOTEST_HOST_ID'];
  if (id && /^[A-Za-z0-9._-]{1,64}$/.test(id)) out['AUTOTEST_HOST_ID'] = id;
  for (const name of allow) if (env[name] !== undefined) out[name] = env[name]!;
  return out;
}
