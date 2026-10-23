/**
 * Detached run supervisor for the server app, loaded by `supervisorBoot.ts`: `node supervisorBoot.ts <runId> <dataRoot>`
 * (ADR-0007 §2).
 *
 * It wires what `@autotest/execution` deliberately leaves to the app: the platform adapters (later-attempt specs and
 * per-attempt parsing), and the full dispatch-time re-authorization over the stores (RUN-002). Everything else —
 * policy re-loading, workspace re-resolution, spawn re-validation — comes from `defaultHooks`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createAdapterRegistry } from '@autotest/adapter-sdk';
import { createCursorCodec, createIdGenerator, RunId } from '@autotest/core';
import { adapterAttemptHooks, defaultHooks, runSupervisor } from '@autotest/execution';
import { loadPolicyConfig } from '@autotest/policy';
import { loadOrCreateKey, openDataRoot } from '@autotest/storage';
import { dispatchAuthorize, serverEnvironmentOf, type RunDeps, type WorkflowPorts } from '@autotest/workflow';
import { builtInAdapters } from './adapters.ts';

const [runId, dataRoot] = process.argv.slice(2);
if (!runId || !RunId.safeParse(runId).success || !dataRoot || !path.isAbsolute(dataRoot)) {
  console.error('usage: supervisorEntry <run_ULID> <absolute data root>');
  process.exit(2);
}

const { sql, stores } = openDataRoot(dataRoot);
let configText: string | undefined;
try {
  configText = fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8');
} catch {
  configText = undefined;
}
const clock = { now: () => new Date() };
// The supervisor never answers tool calls, so it has no use for the idempotency store.
const { idempotency, ...domain } = stores;
void idempotency;
const ports: WorkflowPorts = {
  clock,
  ids: createIdGenerator(),
  ...domain,
  execution: { startSupervisor: async () => Promise.reject(new Error('supervisors do not start supervisors')) },
  cursors: createCursorCodec(loadOrCreateKey(dataRoot, 'cursor'), clock),
};
const registry = createAdapterRegistry(builtInAdapters());
const deps: RunDeps = {
  ports,
  policy: loadPolicyConfig(configText),
  registry,
  // The server passes AUTOTEST_HOST_ID through, so both processes bind the same environment id.
  serverEnvironment: serverEnvironmentOf(process.env),
  dataRoot,
  host: { os: process.platform === 'darwin' ? 'macos' : 'linux' },
};
const base = defaultHooks(dataRoot, runId, { ...process.env });
try {
  const record = await runSupervisor({
    runId,
    dataRoot,
    hooks: { ...base, authorize: (header) => dispatchAuthorize(deps, header), attempts: adapterAttemptHooks(registry) },
    listenSignals: true,
  });
  console.log(`${new Date().toISOString()} ${runId} terminal ${record.state}`);
  sql.close();
  process.exit(0);
} catch (e) {
  console.error(`${new Date().toISOString()} ${runId} supervisor failed: ${(e as Error).message}`);
  process.exit(1);
}
