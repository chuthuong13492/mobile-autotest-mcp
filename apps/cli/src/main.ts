/** `autotest` entrypoint. */
import { processIo } from './io.ts';
import { run } from './run.ts';

process.exitCode = await run(process.argv.slice(2), processIo(), { env: process.env });
