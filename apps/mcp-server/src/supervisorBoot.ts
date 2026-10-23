/**
 * First module of the detached supervisor process. It installs a SIGTERM handler before anything else loads, so a
 * cancel that arrives while the supervisor is still starting cannot kill it silently (which would leave the run
 * with no events and no terminal record). The request itself is not lost: the server writes `control.json` before
 * signalling, and the supervisor reads it as its first step.
 */
process.on('SIGTERM', () => undefined);
await import('./supervisorEntry.ts');
