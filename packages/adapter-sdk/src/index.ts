/** PlatformAdapter contract, capability model, spec builders, registry, outcome helpers and JUnit writer (ADP-001/002). */
export type * from './types.ts';
export * from './specs.ts';
export * from './capabilities.ts';
export * from './registry.ts';
export * from './outcomes.ts';
export * from './junit.ts';
export * from './lcov.ts';
/** Core pieces adapters need; adapters may import only the SDK (ADR-0009, `boundaries.json`). */
export { targetId } from '@autotest/core';
export type {
  ExecutionSpec,
  FailureClass,
  FailureSubtype,
  Limitation,
  Platform,
  PlatformStatus,
  TestLevel,
  TestTarget,
  ToolchainResolution,
} from '@autotest/core';
