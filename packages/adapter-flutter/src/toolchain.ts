/**
 * Flutter SDK version resolution (FL-001; FR-007; platform-adapters §Flutter "SDK resolution"). Versions are collected
 * from every source that names one. Exact versions that disagree are reported as a conflict and nothing is picked:
 * execution uses the SDK the user configured in policy, and provenance records which one ran.
 */
import type { AdapterWorkspace, ProbePort, ToolchainResolution } from '@autotest/adapter-sdk';

const MAX_READ = 64 * 1024;
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const VALUE = /^[0-9A-Za-z.^<>=~ +*-]{1,64}$/;

interface Source {
  readonly source: string;
  readonly value: string;
}

const read = (ws: AdapterWorkspace, rel: string): string | undefined => {
  if (!ws.exists(rel)) return undefined;
  const r = ws.readText(rel, MAX_READ);
  return r.binary ? undefined : r.text;
};

const clean = (v: string | undefined): string | undefined => {
  const t = v?.trim().replace(/^['"]|['"]$/g, '');
  return t && VALUE.test(t) ? t : undefined;
};

/** `environment:` → `flutter:` / `sdk:` constraint in pubspec.yaml (a range or an exact version). */
export function pubspecEnvironment(text: string): { flutter?: string; sdk?: string } {
  const block = /^environment:[ \t]*\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1] ?? '';
  const flutter = clean(/^[ \t]+flutter:[ \t]*(.+)$/m.exec(block)?.[1]);
  const sdk = clean(/^[ \t]+sdk:[ \t]*(.+)$/m.exec(block)?.[1]);
  return { ...(flutter ? { flutter } : {}), ...(sdk ? { sdk } : {}) };
}

function fvmVersion(ws: AdapterWorkspace): Source[] {
  const out: Source[] = [];
  for (const [rel, key] of [
    ['.fvmrc', 'flutter'],
    ['.fvm/fvm_config.json', 'flutterSdkVersion'],
  ] as const) {
    const text = read(ws, rel);
    if (!text) continue;
    try {
      const value = clean(String((JSON.parse(text) as Record<string, unknown>)[key] ?? ''));
      if (value) out.push({ source: rel, value });
    } catch {
      // A malformed FVM file names no version; it is not an error for detection.
    }
  }
  return out;
}

function ciHints(ws: AdapterWorkspace): Source[] {
  const out: Source[] = [];
  const files = ws.list(['bitrise.yml', 'codemagic.yaml', '.github/workflows/*.yml', '.github/workflows/*.yaml'], {
    maxFiles: 20,
  }).files;
  for (const rel of [...files].sort()) {
    const text = read(ws, rel) ?? '';
    const m = /(?:FLUTTER_VERSION|flutter-version|flutter_version)["']?\s*[:=]\s*["']?([0-9][0-9A-Za-z.+-]{0,40})/.exec(
      text,
    );
    const value = clean(m?.[1]);
    if (value) out.push({ source: rel, value });
  }
  return out;
}

/**
 * The first balanced JSON object in `text`. Flutter prints notices around `--machine` output (for example the
 * first-run telemetry banner after the JSON when HOME is fresh, which it is for every run-scoped probe).
 */
export function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Parses `flutter --version --machine` output (RL-034). */
export function parseFlutterMachineVersion(stdout: string): { flutter?: string; dart?: string; root?: string } {
  try {
    const j = JSON.parse(firstJsonObject(stdout) ?? '') as Record<string, unknown>;
    const flutter = clean(typeof j['frameworkVersion'] === 'string' ? j['frameworkVersion'] : undefined);
    const dart = clean(typeof j['dartSdkVersion'] === 'string' ? j['dartSdkVersion'].split(' ')[0] : undefined);
    const root = typeof j['flutterRoot'] === 'string' ? j['flutterRoot'] : undefined;
    return { ...(flutter ? { flutter } : {}), ...(dart ? { dart } : {}), ...(root ? { root } : {}) };
  } catch {
    return {};
  }
}

function resolve(tool: string, sources: readonly Source[]): ToolchainResolution {
  const exact = [...new Set(sources.map((s) => s.value).filter((v) => EXACT.test(v)))];
  const conflicts =
    exact.length > 1
      ? [
          `${tool} versions disagree: ${sources
            .filter((s) => EXACT.test(s.value))
            .map((s) => `${s.source}=${s.value}`)
            .join(', ')}`.slice(0, 256),
        ]
      : [];
  return {
    tool,
    versionsBySource: sources.slice(0, 20).map((s) => ({ source: s.source.slice(0, 256), value: s.value })),
    resolved: exact.length === 1 ? exact[0]! : null,
    conflicts,
  };
}

/** Flutter and Dart toolchain resolutions for the workspace root package. */
export async function resolveFlutterToolchains(
  ws: AdapterWorkspace,
  pubspec: string,
  probes?: ProbePort,
): Promise<ToolchainResolution[]> {
  const env = pubspecEnvironment(pubspec);
  const flutter: Source[] = [];
  const dart: Source[] = [];
  if (env.flutter) flutter.push({ source: 'pubspec.yaml', value: env.flutter });
  if (env.sdk) dart.push({ source: 'pubspec.yaml', value: env.sdk });
  flutter.push(...fvmVersion(ws));
  const toolVersions = read(ws, '.tool-versions');
  const tv = clean(/^flutter[ \t]+(\S+)/m.exec(toolVersions ?? '')?.[1]);
  if (tv) flutter.push({ source: '.tool-versions', value: tv.replace(/-stable$/, '') });
  flutter.push(...ciHints(ws));
  if (probes) {
    const p = await probes.probe('flutter_version');
    if (p.available && p.exitCode === 0) {
      const v = parseFlutterMachineVersion(p.stdout);
      if (v.flutter) flutter.push({ source: 'probe:flutter --version --machine', value: v.flutter });
      if (v.dart) dart.push({ source: 'probe:flutter --version --machine', value: v.dart });
    }
  }
  return [resolve('flutter', flutter), resolve('dart', dart)];
}
