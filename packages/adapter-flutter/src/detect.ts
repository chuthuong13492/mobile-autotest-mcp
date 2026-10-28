/**
 * Flutter project detection (FL-001; platform-adapters §Flutter "Detection signals"). A `pubspec.yaml` that depends
 * on the Flutter SDK is the signal (0.9), `lib/main.dart` and a `test/` directory add 0.05 each. Platform folders
 * are reported with their own evidence. Nested packages (monorepos) and Melos are reported, not orchestrated: each
 * package is selected explicitly as its own workspace (A-09).
 */
import type { DetectContext, DetectionResult, Limitation, Platform } from '@autotest/adapter-sdk';
import { resolveFlutterToolchains } from './toolchain.ts';

export const ADAPTER_ID = 'flutter';
const PLATFORM_DIRS: readonly Platform[] = ['android', 'ios', 'web', 'macos', 'linux', 'windows'];

/** True when the pubspec declares `flutter: sdk: flutter` under `dependencies`. */
export function dependsOnFlutterSdk(pubspec: string): boolean {
  return /^dependencies:[ \t]*\n(?:(?:[ \t]+.*|[ \t]*)\n)*?[ \t]+flutter:[ \t]*\n[ \t]+sdk:[ \t]*["']?flutter["']?[ \t]*$/m.test(
    pubspec.replace(/\r\n/g, '\n'),
  );
}

/** True when the pubspec lists `flutter_test` (the host test runner). */
export function hasFlutterTest(pubspec: string): boolean {
  return /^[ \t]+flutter_test:[ \t]*\n[ \t]+sdk:[ \t]*["']?flutter["']?/m.test(pubspec.replace(/\r\n/g, '\n'));
}

export function readPubspec(ctx: DetectContext): string | undefined {
  if (!ctx.workspace.exists('pubspec.yaml')) return undefined;
  const r = ctx.workspace.readText('pubspec.yaml', 256 * 1024);
  return r.binary ? undefined : r.text;
}

export async function detectFlutter(ctx: DetectContext): Promise<DetectionResult> {
  const pubspec = readPubspec(ctx);
  const none: DetectionResult = {
    adapterId: ADAPTER_ID,
    detected: false,
    confidence: 0,
    evidence: [],
    platforms: [],
    toolchains: [],
    runners: [],
    limitations: [],
  };
  if (pubspec === undefined || !dependsOnFlutterSdk(pubspec)) return none;
  const ws = ctx.workspace;
  const evidence = ['pubspec.yaml'];
  let confidence = 0.9;
  if (ws.exists('lib/main.dart')) {
    confidence += 0.05;
    evidence.push('lib/main.dart');
  }
  if (ws.exists('test')) {
    confidence += 0.05;
    evidence.push('test');
  }
  const limitations: Limitation[] = [];
  const nested = ws
    .list(['*/**/pubspec.yaml'], { maxFiles: 50, exclude: ['build/**', '**/build/**', '**/.symlinks/**'] })
    .files.filter((p) => p !== 'pubspec.yaml');
  if (nested.length > 0)
    limitations.push({
      code: 'flutter:monorepo_packages',
      message:
        `${nested.length} nested package(s) found (e.g. ${[...nested].sort()[0]}); add each package as its own workspace to test it`.slice(
          0,
          500,
        ),
    });
  if (ws.exists('melos.yaml'))
    limitations.push({
      code: 'flutter:melos_not_orchestrated',
      message: 'melos.yaml found; Melos scripts are not run',
    });
  if (ws.exists('integration_test'))
    limitations.push({
      code: 'flutter:integration_test_needs_device',
      message: 'integration_test/ runs on an AutoTest-owned simulator or emulator (pass its id to run_tests devices)',
    });
  if (ws.exists('integration_test/appium_test.dart'))
    limitations.push({
      code: 'flutter:appium_entry_point',
      message:
        'integration_test/appium_test.dart starts the app for Appium; it is not run as a Flutter test (Appium adapter)',
    });
  const platforms = [
    { platform: 'host' as const, status: 'present' as const, evidence: ['pubspec.yaml'] },
    ...PLATFORM_DIRS.map((p) =>
      ws.exists(p)
        ? { platform: p, status: 'present' as const, evidence: [p] }
        : { platform: p, status: 'absent' as const, evidence: [] },
    ),
  ];
  return {
    adapterId: ADAPTER_ID,
    detected: true,
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    evidence,
    platforms,
    toolchains: await resolveFlutterToolchains(ws, pubspec, ctx.probes),
    runners: [{ kind: 'flutter_test', configured: hasFlutterTest(pubspec), evidence: ['pubspec.yaml'] }],
    limitations,
  };
}
