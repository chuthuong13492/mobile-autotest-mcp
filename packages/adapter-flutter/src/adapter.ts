/**
 * The Flutter {@link PlatformAdapter} (FL-001 – FL-005): host unit and widget tests through `flutter test` and the
 * Dart JSON reporter. Integration tests on devices arrive with FL-006 (v1.1).
 */
import type { CapabilitySet, PlatformAdapter } from '@autotest/adapter-sdk';
import { ADAPTER_ID, detectFlutter } from './detect.ts';
import { flutterEvidenceHints, flutterFailureSignals } from './evidence.ts';
import { buildFlutterExecution } from './execution.ts';
import { inventoryFlutter } from './inventory.ts';
import { parseFlutterResults } from './parse.ts';

export const FLUTTER_ADAPTER_VERSION = '1.0.0';

export const FLUTTER_CAPABILITIES: CapabilitySet = {
  levels: ['unit', 'widget'],
  host: { requires: 'any', available: true },
  devices: { needs: 'none', available: true },
  selection: ['file', 'name', 'tag'],
  resultFormats: ['dart-json-reporter@0.1'],
  resultGranularity: 'test',
  cancellation: 'graceful_then_group',
  coverage: true,
  limitations: ['integration_test on simulators and emulators arrives in v1.1 (FL-006)'],
};

export function createFlutterAdapter(): PlatformAdapter {
  return {
    id: ADAPTER_ID,
    version: FLUTTER_ADAPTER_VERSION,
    detect: detectFlutter,
    async capabilities() {
      return FLUTTER_CAPABILITIES;
    },
    inventory: inventoryFlutter,
    resolveTargets(input) {
      const ids = new Set(input.targets.map((t) => t.id));
      const resolved: { testCaseId: string; targetId: string }[] = [];
      const unresolved: { testCaseId: string; reason: string }[] = [];
      for (const c of input.testCases) {
        if (c.targetRef && ids.has(c.targetRef)) resolved.push({ testCaseId: c.id, targetId: c.targetRef });
        else unresolved.push({ testCaseId: c.id, reason: c.targetRef ? 'target_not_in_inventory' : 'no_target' });
      }
      return { resolved, unresolved };
    },
    buildExecution: buildFlutterExecution,
    parseResults: parseFlutterResults,
    evidenceHints: flutterEvidenceHints,
    failureSignals: (results) => flutterFailureSignals(results),
    cleanupSpecs: () => [],
    baselineDependencies: {
      lockFiles: ['pubspec.lock'],
      copy: [
        '.dart_tool/package_config.json',
        '.dart_tool/package_graph.json',
        '.flutter-plugins',
        '.flutter-plugins-dependencies',
      ],
    },
    async prerequisites(ctx) {
      // Runs use --no-pub (SR-014): dependencies must already be resolved in the workspace.
      const resolved = ctx.workspace.exists('.dart_tool/package_config.json');
      return resolved
        ? { satisfied: true, missing: [] }
        : {
            satisfied: false,
            missing: [
              {
                code: 'pub_get',
                message: 'dependencies are not resolved: run `flutter pub get` in the workspace, then retry',
              },
            ],
          };
    },
  };
}
