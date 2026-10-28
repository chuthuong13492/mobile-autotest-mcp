/**
 * Flutter SDK selection for a workspace (B2, 1.4.0). Several SDKs may be configured side by side as `flutter` and
 * `flutter@<label>` (policy pins each by real path). A workspace's explicit `flutterSdk` wins; with one configured SDK
 * nothing is probed (the behaviour before 1.4.0); otherwise each SDK's `flutter --version --machine` is probed and
 * the workspace's pins decide: an exact Flutter version (`.fvmrc`, `.fvm/fvm_config.json`, `.tool-versions`, an
 * exact `environment.flutter`) or, without one, the `environment.sdk` Dart constraint of `pubspec.yaml`. No match or
 * more than one match fails closed with `sdk_mismatch`: another SDK is never used silently.
 */
import type { ExecutableSelection, ExecutableSelectionContext } from '@autotest/adapter-sdk';
import { parseFlutterMachineVersion, pubspecEnvironment, resolveFlutterToolchains } from './toolchain.ts';

type Version = readonly [number, number, number];

function parseVersion(v: string): Version | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Whether `version` satisfies a pub version constraint: `any`, an exact version, `^x.y.z` (caret: below the next
 * breaking version), or space-separated comparisons (`>=3.5.0 <4.0.0`). An unreadable constraint satisfies nothing.
 */
export function satisfiesConstraint(version: string, constraint: string): boolean {
  const v = parseVersion(version);
  const c = constraint.trim();
  if (!v) return false;
  if (c === 'any') return true;
  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(c);
  if (caret) {
    const lo = parseVersion(caret[1]!)!;
    const hi: Version = lo[0] > 0 ? [lo[0] + 1, 0, 0] : [0, lo[1] + 1, 0];
    return compare(v, lo) >= 0 && compare(v, hi) < 0;
  }
  const parts = c.split(/\s+/);
  if (parts.length === 0) return false;
  return parts.every((p) => {
    const m = /^(>=|<=|>|<)?(\d+\.\d+\.\d+)$/.exec(p);
    if (!m) return false;
    const d = compare(v, parseVersion(m[2]!)!);
    switch (m[1]) {
      case '>=':
        return d >= 0;
      case '<=':
        return d <= 0;
      case '>':
        return d > 0;
      case '<':
        return d < 0;
      default:
        return d === 0;
    }
  });
}

const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export async function selectFlutterExecutable(ctx: ExecutableSelectionContext): Promise<ExecutableSelection> {
  const candidates = ctx.configured.filter((n) => n === 'flutter' || n.startsWith('flutter@')).sort();
  if (ctx.preferred)
    return candidates.includes(ctx.preferred)
      ? { ok: true, executable: ctx.preferred, detail: 'bound by flutterSdk' }
      : {
          ok: false,
          code: 'sdk_mismatch',
          message: `the workspace is bound to ${ctx.preferred}, which is not configured`,
        };
  if (candidates.length <= 1) return { ok: true, executable: candidates[0] ?? 'flutter' };
  if (!ctx.probes)
    return { ok: false, code: 'sdk_mismatch', message: 'several Flutter SDKs are configured and none could be probed' };

  const pubspec = ctx.workspace.exists('pubspec.yaml') ? ctx.workspace.readText('pubspec.yaml', 256 * 1024).text : '';
  const [flutterPins] = await resolveFlutterToolchains(ctx.workspace, pubspec);
  const pin = flutterPins?.resolved ?? undefined;
  const dartConstraint = pubspecEnvironment(pubspec).sdk;
  const versions: { name: string; flutter?: string; dart?: string }[] = [];
  for (const name of candidates) {
    const p = await ctx.probes.probe('flutter_version', name);
    versions.push({ name, ...(p.available && p.exitCode === 0 ? parseFlutterMachineVersion(p.stdout) : {}) });
  }
  const listed = versions
    .map((v) => `${v.name} (Flutter ${v.flutter ?? '?'}, Dart ${v.dart ?? '?'})`)
    .join(', ')
    .slice(0, 600);
  const matches =
    pin && EXACT.test(pin)
      ? versions.filter((v) => v.flutter === pin)
      : dartConstraint
        ? versions.filter((v) => v.dart && satisfiesConstraint(v.dart, dartConstraint))
        : [];
  const wanted = pin ? `Flutter ${pin}` : dartConstraint ? `Dart ${dartConstraint}` : 'no version pin';
  if (matches.length === 1)
    return { ok: true, executable: matches[0]!.name, detail: `${wanted} → ${matches[0]!.name}` };
  return {
    ok: false,
    code: 'sdk_mismatch',
    message:
      matches.length === 0
        ? `no configured Flutter SDK matches ${wanted}; configured: ${listed}`
        : `several configured Flutter SDKs match ${wanted} (${matches.map((m) => m.name).join(', ')}): bind one with flutterSdk in the workspace entry`,
  };
}
