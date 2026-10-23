/** A short-lived "server": launches the supervisor detached, records its identity, then waits to be killed. */
import fs from 'node:fs';
import { launchSupervisor } from '../../src/index.ts';

const [dataRoot, runId, out] = process.argv.slice(2);
const identity = launchSupervisor(dataRoot!, runId!);
fs.writeFileSync(out!, JSON.stringify({ parent: process.pid, supervisor: identity }));
setInterval(() => undefined, 60_000);
