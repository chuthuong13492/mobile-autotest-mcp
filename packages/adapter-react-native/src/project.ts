/**
 * Static reading of React Native projects (RN-001): the `package.json` dependencies that make a project React
 * Native (or Expo), its Jest test files, Maestro flows and Detox configurations. Nothing is run here: Jest, Detox and
 * Metro configs are JavaScript, and evaluating them would execute repository code (T-02).
 */
import type { AdapterWorkspace } from '@autotest/adapter-sdk';

export interface PackageInfo {
  readonly deps: ReadonlySet<string>;
  readonly hasJestConfig: boolean;
}

const MAX_TEXT = 1024 * 1024;

export function readPackage(ws: AdapterWorkspace): PackageInfo | undefined {
  if (!ws.exists('package.json')) return undefined;
  const r = ws.readText('package.json', MAX_TEXT);
  if (r.binary || r.truncated) return undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(r.text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const deps = new Set<string>();
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies'])
    if (json[k] && typeof json[k] === 'object') for (const name of Object.keys(json[k] as object)) deps.add(name);
  const hasJestConfig =
    'jest' in json ||
    ['jest.config.js', 'jest.config.ts', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json'].some((f) =>
      ws.exists(f),
    );
  return { deps, hasJestConfig };
}

const EXCLUDE = [
  'node_modules/**',
  '**/node_modules/**',
  'ios/**',
  'android/**',
  'e2e/**',
  '.maestro/**',
  'build/**',
  'coverage/**',
];

/** Jest test files: anything under `__tests__/`, or named `*.test.*` / `*.spec.*` (JS or TS), outside e2e folders. */
export function jestTestFiles(ws: AdapterWorkspace, maxFiles: number): { files: string[]; truncated: boolean } {
  const exts = ['js', 'jsx', 'ts', 'tsx'];
  const listed = ws.list(
    exts.flatMap((e) => [`**/__tests__/**/*.${e}`, `**/*.test.${e}`, `**/*.spec.${e}`]),
    { maxFiles, exclude: EXCLUDE },
  );
  return { files: [...new Set(listed.files)].sort(), truncated: listed.truncated };
}

/** `component` when the file renders components (React Native Testing Library or the test renderer), else `unit`. */
export function jestLevel(source: string): 'unit' | 'component' {
  return /from\s+['"](?:@testing-library\/react-native|react-test-renderer)['"]|require\(\s*['"](?:@testing-library\/react-native|react-test-renderer)['"]\s*\)/.test(
    source,
  )
    ? 'component'
    : 'unit';
}

/** Maestro flow files under `.maestro/` (the workspace config `config.yaml` is not a flow). */
export function maestroFlows(ws: AdapterWorkspace, maxFiles: number): string[] {
  return [...ws.list(['.maestro/**/*.yaml', '.maestro/**/*.yml'], { maxFiles }).files]
    .filter((f) => !/(^|\/)config\.ya?ml$/.test(f))
    .sort();
}

export interface DetoxConfiguration {
  readonly name: string;
  readonly platform: 'ios' | 'android';
}

const DETOX_FILES = ['.detoxrc.json', '.detoxrc', '.detoxrc.js', 'detox.config.js', 'detox.config.json'];

export function detoxConfigFile(ws: AdapterWorkspace): string | undefined {
  return DETOX_FILES.find((f) => ws.exists(f));
}

/**
 * Configuration names and platforms from a Detox config, read as text: JSON is parsed, a JS config is scanned for
 * `'name': { … device: '<ios.…|android.…>' }` keys. A name whose platform cannot be read is skipped.
 */
export function detoxConfigurations(text: string): DetoxConfiguration[] {
  const platformOf = (s: string) =>
    /\bios\b|ios\.|simulator/i.test(s) ? 'ios' : /android|emulator/i.test(s) ? 'android' : undefined;
  try {
    const json = JSON.parse(text) as {
      configurations?: Record<string, { device?: unknown }>;
      devices?: Record<string, { type?: string }>;
    };
    const out: DetoxConfiguration[] = [];
    for (const [name, cfg] of Object.entries(json.configurations ?? {})) {
      const dev =
        typeof cfg.device === 'string'
          ? (json.devices?.[cfg.device]?.type ?? cfg.device)
          : JSON.stringify(cfg.device ?? '');
      const platform = platformOf(dev) ?? platformOf(name);
      if (platform) out.push({ name, platform });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    // a JS config
  }
  const at = text.search(/configurations\s*:\s*\{/);
  if (at < 0) return [];
  const out: DetoxConfiguration[] = [];
  for (const m of text
    .slice(at)
    .matchAll(/['"]([A-Za-z0-9._-]{1,64})['"]\s*:\s*\{\s*device\s*:\s*['"]([^'"]{1,64})['"]/g)) {
    const platform = platformOf(m[1]!) ?? platformOf(m[2]!);
    if (platform) out.push({ name: m[1]!, platform });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Detox test files (Jest-based) under `e2e/`. */
export function detoxTestFiles(ws: AdapterWorkspace, maxFiles: number): string[] {
  return [
    ...ws.list(['e2e/**/*.test.js', 'e2e/**/*.test.ts', 'e2e/**/*.e2e.js', 'e2e/**/*.e2e.ts'], { maxFiles }).files,
  ].sort();
}
