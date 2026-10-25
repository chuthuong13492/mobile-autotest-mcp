/**
 * Static reading of Gradle Android projects (AND-002): Gradle roots, the modules `settings.gradle(.kts)` includes,
 * which of them apply an Android plugin, and the JUnit test classes in their `src/test` and `src/androidTest` source
 * sets. Gradle is never run here: running it would execute the repository's build scripts (T-02). What cannot be
 * read statically (custom project directories, product flavors) is reported, not guessed.
 */
import type { AdapterWorkspace } from '@autotest/adapter-sdk';

export interface GradleRoot {
  /** Workspace-relative directory of `settings.gradle(.kts)` ('' for the workspace root). */
  readonly dir: string;
  readonly settings: string;
  /** Workspace-relative wrapper jar, when the root has one. */
  readonly wrapperJar?: string;
}

export interface AndroidModule {
  readonly root: GradleRoot;
  /** Gradle path, e.g. `:app` or `:feature:login`. */
  readonly gradlePath: string;
  /** Workspace-relative module directory. */
  readonly dir: string;
  readonly buildFile: string;
  readonly kind: 'application' | 'library';
  readonly flavors: boolean;
}

export interface TestClass {
  /** Fully qualified class name. */
  readonly fqcn: string;
  readonly path: string;
}

const MAX_TEXT = 1024 * 1024;
const EXCLUDE = ['**/node_modules/**', '**/build/**', '**/.gradle/**'];
const join = (...parts: string[]) => parts.filter(Boolean).join('/');

export function findGradleRoots(ws: AdapterWorkspace): GradleRoot[] {
  const listed = ws.list(['settings.gradle', 'settings.gradle.kts', '*/settings.gradle', '*/settings.gradle.kts'], {
    maxFiles: 20,
    exclude: EXCLUDE,
  });
  const flutter = ws.exists('pubspec.yaml');
  const byDir = new Map<string, string>();
  for (const f of [...listed.files].sort()) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    // A Flutter project's android/ folder belongs to the Flutter adapter.
    if (flutter && dir === 'android') continue;
    if (!byDir.has(dir)) byDir.set(dir, f);
  }
  return [...byDir.entries()].map(([dir, settings]) => {
    const jar = join(dir, 'gradle/wrapper/gradle-wrapper.jar');
    return { dir, settings, ...(ws.exists(jar) ? { wrapperJar: jar } : {}) };
  });
}

/** Gradle paths named by `include(...)` / `include '…'` statements, in order, without duplicates. */
export function includedProjects(settings: string): string[] {
  const out: string[] = [];
  const text = settings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const m of text.matchAll(/^\s*include\s*\(?([^\n)]*)\)?/gm))
    for (const q of m[1]!.matchAll(/["'](:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)["']/g)) {
      const p = q[1]!.startsWith(':') ? q[1]! : `:${q[1]!}`;
      if (!out.includes(p)) out.push(p);
    }
  return out;
}

/** True when the settings move a project directory (`project(":x").projectDir = …`), which is not followed. */
export const customProjectDirs = (settings: string) => /\.projectDir\s*=/.test(settings);

export function androidKind(buildFile: string): AndroidModule['kind'] | undefined {
  if (/com\.android\.application|android\.application\b/.test(buildFile)) return 'application';
  if (/com\.android\.library|android\.library\b/.test(buildFile)) return 'library';
  return undefined;
}

export function findAndroidModules(ws: AdapterWorkspace, root: GradleRoot): AndroidModule[] {
  const out: AndroidModule[] = [];
  for (const gradlePath of includedProjects(ws.readText(root.settings, MAX_TEXT).text)) {
    const dir = join(root.dir, gradlePath.slice(1).replaceAll(':', '/'));
    const buildFile = [join(dir, 'build.gradle.kts'), join(dir, 'build.gradle')].find((f) => ws.exists(f));
    if (!buildFile) continue;
    const text = ws.readText(buildFile, MAX_TEXT).text;
    const kind = androidKind(text);
    if (kind) out.push({ root, gradlePath, dir, buildFile, kind, flavors: /\bproductFlavors\s*\{/.test(text) });
  }
  return out;
}

/** The top-level JUnit class of a Java or Kotlin source: the class named like the file, with `@Test` methods. */
export function testClassOf(file: string, source: string): string | undefined {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.(java|kt)$/, '');
  if (!/@Test\b/.test(source)) return undefined;
  const decl = new RegExp(`\\b(abstract\\s+)?(?:open\\s+)?class\\s+${base}\\b`).exec(source);
  if (!decl || decl[1]) return undefined;
  const pkg = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)/m.exec(source)?.[1];
  return pkg ? `${pkg}.${base}` : base;
}

export function testClasses(
  ws: AdapterWorkspace,
  module: AndroidModule,
  sourceSet: 'test' | 'androidTest',
  maxFiles: number,
): { classes: TestClass[]; truncated: boolean } {
  const listed = ws.list(
    [`${join(module.dir, 'src', sourceSet)}/**/*.java`, `${join(module.dir, 'src', sourceSet)}/**/*.kt`],
    {
      maxFiles,
    },
  );
  const classes: TestClass[] = [];
  for (const file of [...listed.files].sort()) {
    const fqcn = testClassOf(file, ws.readText(file, 512 * 1024).text);
    if (fqcn) classes.push({ fqcn, path: file });
  }
  return { classes, truncated: listed.truncated };
}
