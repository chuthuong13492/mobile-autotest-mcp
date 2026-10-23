/** autotest CLI: init, approve, revoke, approvals (CLI-001), doctor (CLI-002), cleanup (CLI-003); ci arrives with CLI-004. */
export const PACKAGE_NAME = '@autotest/cli' as const;
export * from './io.ts';
export * from './context.ts';
export * from './run.ts';
export { challengePositions } from './commands/approve.ts';
export { CONFIG_TEMPLATE } from './commands/init.ts';
export * from './commands/doctor.ts';
export * from './commands/cleanup.ts';
export * from './adapters.ts';
