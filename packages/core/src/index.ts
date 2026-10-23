/**
 * @autotest/core — domain behavior shared by all packages: IDs, RFC 8785 canonical JSON and hashing, the run
 * lifecycle state machine, verdict rules, the audit hash chain and workflow ports.
 *
 * It re-exports @autotest/contracts so packages that may depend only on core (planning, coverage-gate, analysis,
 * reporting, storage) reach the contracts through this entrypoint (ADR-0015, boundaries.json).
 */
export * from '@autotest/contracts';
export * from './ids.ts';
export * from './runState.ts';
export * from './verdict.ts';
export * from './audit.ts';
export * from './auditData.ts';
export * from './log.ts';
export * from './metrics.ts';
export * from './cursor.ts';
export * from './ports.ts';
