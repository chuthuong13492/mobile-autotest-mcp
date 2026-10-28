/** Flutter platform adapter (FL-001 – FL-005): detection, inventory, `flutter test` specs, JSON reporter parsing. */
export const PACKAGE_NAME = '@autotest/adapter-flutter' as const;
export * from './adapter.ts';
export { ADAPTER_ID, dependsOnFlutterSdk, detectFlutter, hasFlutterTest } from './detect.ts';
export { parseFlutterMachineVersion, pubspecEnvironment, resolveFlutterToolchains } from './toolchain.ts';
export { classifyLevel, fileTags, inventoryFlutter } from './inventory.ts';
export { buildFlutterExecution, LCOV_FILE, RESULTS_FILE } from './execution.ts';
export { parseFlutterResults, runnerFiles } from './parse.ts';
export { flutterEvidenceHints, flutterFailureSignals } from './evidence.ts';
export { satisfiesConstraint, selectFlutterExecutable } from './sdk.ts';
