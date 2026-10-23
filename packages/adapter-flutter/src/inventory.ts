/**
 * Flutter test inventory (FL-002; platform-adapters §Flutter "Test discovery"). `test/**\/*_test.dart` files are
 * `widget` when a bounded scan (256 KiB) finds `testWidgets(`, otherwise `unit`. `integration_test/**\/*_test.dart`
 * files are `integration` targets that need a device (they run from v1.1, so eligibility marks them unavailable).
 * File-level `@Tags([...])` annotations become target tags; `dart_test.yaml` is listed as an automation config.
 */
import {
  sortedPaths,
  targetId,
  type InventoryContext,
  type InventoryFragment,
  type TestTarget,
} from '@autotest/adapter-sdk';
import { ADAPTER_ID } from './detect.ts';

const SCAN_BYTES = 256 * 1024;
const EXCLUDE = ['build/**', '**/build/**'];
const HELPERS: readonly { readonly glob: string; readonly kind: 'mock' | 'fixture' | 'helper' | 'config' }[] = [
  { glob: 'test/flutter_test_config.dart', kind: 'config' },
  { glob: 'test/mocks/**', kind: 'mock' },
  { glob: 'test/**/mocks/**', kind: 'mock' },
  { glob: 'test/helpers/**', kind: 'helper' },
  { glob: 'test/**/helpers/**', kind: 'helper' },
  { glob: 'test/fixtures/**', kind: 'fixture' },
  { glob: 'test/**/fixtures/**', kind: 'fixture' },
];

/** Tags from a library-level `@Tags(['a', 'b'])` annotation. */
export function fileTags(source: string): string[] {
  const m = /@Tags\(\s*\[([^\]]{0,2000})\]\s*\)/.exec(source);
  if (!m) return [];
  const tags = [...m[1]!.matchAll(/['"]([A-Za-z0-9_-]{1,64})['"]/g)].map((t) => t[1]!);
  return [...new Set(tags)].sort().slice(0, 50);
}

/** `widget` when the file declares a widget test. */
export function classifyLevel(source: string): 'unit' | 'widget' {
  return /\btestWidgets\s*\(/.test(source) ? 'widget' : 'unit';
}

export async function inventoryFlutter(ctx: InventoryContext): Promise<InventoryFragment> {
  const ws = ctx.workspace;
  const reasons = new Set<string>();
  const listed = ws.list(['test/**/*_test.dart', 'integration_test/**/*_test.dart'], {
    maxFiles: ctx.limits.maxFiles,
    exclude: EXCLUDE,
  });
  if (listed.truncated) reasons.add('max_files');
  let budget = ctx.limits.maxReadBytes;
  const targets: TestTarget[] = [];
  for (const path of sortedPaths(listed.files)) {
    const integration = path.startsWith('integration_test/');
    let source = '';
    if (budget > 0) {
      const r = ws.readText(path, Math.min(SCAN_BYTES, budget));
      budget -= Math.min(r.sizeBytes, SCAN_BYTES);
      source = r.binary ? '' : r.text;
    } else reasons.add('max_read_bytes');
    targets.push({
      id: targetId(ADAPTER_ID, path),
      adapterId: ADAPTER_ID,
      level: integration ? 'integration' : classifyLevel(source),
      path,
      selector: { kind: 'file', value: path },
      platforms: integration ? ['android', 'ios'] : ['host'],
      requires: integration ? { host: 'any', device: 'simulator' } : { host: 'any', device: 'none' },
      tags: fileTags(source),
    });
  }
  const helpers = new Map<string, 'mock' | 'fixture' | 'helper' | 'config'>();
  for (const h of HELPERS) {
    for (const p of ws.list([h.glob], { maxFiles: 200, exclude: ['**/*_test.dart'] }).files)
      if (!helpers.has(p)) helpers.set(p, h.kind);
  }
  const automationConfigs = ['dart_test.yaml', 'test/flutter_test_config.dart']
    .filter((p) => ws.exists(p))
    .map((path) => ({ path, kind: path.endsWith('.yaml') ? 'dart_test' : 'flutter_test_config' }));
  return {
    adapterId: ADAPTER_ID,
    targets,
    helpers: [...helpers].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, kind]) => ({ path, kind })),
    automationConfigs,
    complete: reasons.size === 0,
    truncatedAt: reasons.size === 0 ? null : targets.length,
    reasons: [...reasons].sort(),
  };
}
