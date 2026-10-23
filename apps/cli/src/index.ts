/** autotest CLI (approve, revoke, approvals, init; doctor, cleanup and ci arrive with CLI-002 – CLI-004). */
export const PACKAGE_NAME = '@autotest/cli' as const;
export * from './io.ts';
export * from './context.ts';
export * from './run.ts';
export { challengePositions } from './commands/approve.ts';
export { CONFIG_TEMPLATE } from './commands/init.ts';
