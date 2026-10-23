/**
 * Detached supervisor entrypoint: `node main.ts <runId> <dataRoot>` (ADR-0007 §2). The argv carries only the run id
 * and the data-root path; everything else comes from the run directory and the user config. Logs go to
 * `runs/<runId>/supervisor.log` (the launcher's stdout/stderr target).
 */
import path from 'node:path';
import { RunId } from '@autotest/core';
import { defaultHooks } from './hooks.ts';
import { runSupervisor } from './supervisor.ts';

const [runId, dataRoot] = process.argv.slice(2);
if (!runId || !RunId.safeParse(runId).success || !dataRoot || !path.isAbsolute(dataRoot)) {
  console.error('usage: main.ts <run_ULID> <absolute data root>');
  process.exit(2);
}
try {
  const record = await runSupervisor({
    runId,
    dataRoot,
    hooks: defaultHooks(dataRoot, runId, { ...process.env }),
    listenSignals: true,
  });
  console.log(`${new Date().toISOString()} ${runId} terminal ${record.state}`);
  process.exit(0);
} catch (e) {
  console.error(`${new Date().toISOString()} ${runId} supervisor failed: ${(e as Error).message}`);
  process.exit(1);
}
