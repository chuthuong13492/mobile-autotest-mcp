/**
 * Static reading of Xcode projects (IOS-002): projects, shared schemes and their testables, target product types
 * from `project.pbxproj`, and XCTest classes from Swift sources. Nothing is executed (T-02); scheme XML is read with
 * regular expressions over bounded text, so no entity expansion can happen.
 */
import type { AdapterWorkspace } from '@autotest/adapter-sdk';

export interface XcodeProject {
  /** Workspace-relative `.xcodeproj` directory. */
  readonly path: string;
  /** Directory the project lives in ('' for the workspace root). */
  readonly dir: string;
}

export interface Testable {
  readonly scheme: string;
  readonly target: string;
}

const MAX_TEXT = 1024 * 1024;

export function findProjects(ws: AdapterWorkspace): XcodeProject[] {
  const listed = ws.list(['*.xcodeproj/project.pbxproj', '*/*.xcodeproj/project.pbxproj'], {
    maxFiles: 50,
    exclude: ['Pods/**', '**/Pods/**', 'build/**', '**/build/**'],
  });
  return listed.files
    .map((f) => f.slice(0, -'/project.pbxproj'.length))
    .sort()
    .map((p) => ({ path: p, dir: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '' }));
}

/** `PBXNativeTarget` name → product type, from the pbxproj text. */
export function targetProductTypes(pbxproj: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of pbxproj.matchAll(/isa = PBXNativeTarget;([\s\S]*?)\n\t\t};/g)) {
    const body = m[1]!;
    const name = /\n\s*name = "?([^";\n]+)"?;/.exec(body)?.[1];
    const type = /\n\s*productType = "([^"]+)";/.exec(body)?.[1];
    if (name && type) out.set(name, type);
  }
  return out;
}

/** Testables of the project's shared schemes (`xcshareddata/xcschemes/*.xcscheme`), skipped ones excluded. */
export function schemeTestables(ws: AdapterWorkspace, project: XcodeProject): Testable[] {
  const out: Testable[] = [];
  for (const file of ws
    .list([`${project.path}/xcshareddata/xcschemes/*.xcscheme`], { maxFiles: 50 })
    .files.slice()
    .sort()) {
    const scheme = file.slice(file.lastIndexOf('/') + 1, -'.xcscheme'.length);
    const text = ws.readText(file, MAX_TEXT).text;
    const testAction = /<TestAction[\s\S]*?<\/TestAction>/.exec(text)?.[0] ?? '';
    for (const m of testAction.matchAll(/<TestableReference([^>]*)>[\s\S]*?BlueprintName\s*=\s*"([^"]+)"/g)) {
      if (/skipped\s*=\s*"YES"/.test(m[1]!)) continue;
      out.push({ scheme, target: m[2]! });
    }
  }
  return out;
}

/** XCTestCase subclasses declared in a Swift source, with their `test…` methods. */
export function xctestClasses(source: string): { readonly name: string; readonly methods: readonly string[] }[] {
  const out: { name: string; methods: string[] }[] = [];
  const classes = [...source.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*XCTestCase\b/g)];
  classes.forEach((m, i) => {
    const end = classes[i + 1]?.index ?? source.length;
    const body = source.slice(m.index, end);
    out.push({
      name: m[1]!,
      methods: [...body.matchAll(/\bfunc\s+(test[A-Za-z0-9_]*)\s*\(\s*\)/g)].map((x) => x[1]!),
    });
  });
  return out;
}

/** The test level of a target product type: unit-test bundles are `unit`, UI-testing bundles `e2e`. */
export function levelOf(productType: string | undefined): 'unit' | 'e2e' | undefined {
  if (productType === 'com.apple.product-type.bundle.unit-test') return 'unit';
  if (productType === 'com.apple.product-type.bundle.ui-testing') return 'e2e';
  return undefined;
}
