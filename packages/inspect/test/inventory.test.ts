import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '@autotest/adapter-sdk';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import {
  createCursorCodec,
  InspectTestInventoryOutput,
  targetId,
  TestInventory,
  type TestTarget,
} from '@autotest/core';
import { buildInventory, InspectError, normalizePrefix, pageInventory } from '@autotest/inspect';
import { fakeAdapter, memoryWorkspace } from './helpers.ts';

const host = { os: 'linux' as const };
const codec = createCursorCodec(new Uint8Array(32).fill(3), { now: () => new Date('2026-10-23T01:00:00Z') });
const limits = { maxFiles: 50_000, maxBytes: 262_144 };

const target = (adapterId: string, path: string, level: TestTarget['level'] = 'unit'): TestTarget => ({
  id: targetId(adapterId, path),
  adapterId,
  level,
  path,
  selector: { kind: 'file', value: path },
  platforms: ['host'],
  requires: { host: 'any', device: 'none' },
  tags: [],
});

function inventoryOf(targets: TestTarget[]): TestInventory {
  return TestInventory.parse({
    id: 'inv_01JC0000000000000000000003',
    schemaVersion: 1,
    createdAt: '2026-10-23T00:00:00Z',
    profileId: 'prj_01JC0000000000000000000002',
    targets,
    helpers: [],
    automationConfigs: [],
    counts: { total: targets.length, byLevel: {}, byAdapter: {} },
    completeness: { complete: true, truncatedAt: null, reasons: [] },
    limits,
  });
}

describe('INS-002 buildInventory', () => {
  it('merges adapter fragments deterministically with counts, helpers and completeness', async () => {
    const files = Object.fromEntries(
      ['test/b_test.dart', 'test/a_test.dart', 'test/sub/c_test.dart'].map((f) => [f, '']),
    );
    const helperAdapter = fakeAdapter(
      'helpers',
      {},
      {
        inventory: async () => ({
          adapterId: 'helpers',
          targets: [target('helpers', 'test/z_test.dart', 'widget')],
          helpers: [
            { path: 'test/mocks/mock_http.dart', kind: 'mock' },
            { path: 'test/mocks/mock_http.dart', kind: 'mock' },
          ],
          automationConfigs: [],
          complete: true,
          truncatedAt: null,
          reasons: [],
        }),
      },
    );
    const reg = createAdapterRegistry([createExampleAdapter(), helperAdapter]);
    const inv = await buildInventory({
      registry: reg,
      adapterIds: ['helpers', 'example'],
      workspace: memoryWorkspace(files),
      host,
      limits,
    });
    expect(inv.targets.map((t) => t.path)).toEqual([
      'test/a_test.dart',
      'test/b_test.dart',
      'test/sub/c_test.dart',
      'test/z_test.dart',
    ]);
    expect(inv.counts).toEqual({ total: 4, byLevel: { unit: 3, widget: 1 }, byAdapter: { example: 3, helpers: 1 } });
    expect(inv.helpers).toEqual([{ path: 'test/mocks/mock_http.dart', kind: 'mock' }]);
    expect(inv.completeness).toEqual({ complete: true, truncatedAt: null, reasons: [] });
    expect(
      await buildInventory({
        registry: reg,
        adapterIds: ['example', 'helpers'],
        workspace: memoryWorkspace(files),
        host,
        limits,
      }),
    ).toEqual(inv);
  });

  it('marks the snapshot incomplete when limits, failures or the budget are hit', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`test/t${String(i).padStart(2, '0')}_test.dart`, '']),
    );
    const capped = await buildInventory({
      registry: createAdapterRegistry([createExampleAdapter()]),
      adapterIds: ['example'],
      workspace: memoryWorkspace(many),
      host,
      limits: { maxFiles: 10, maxBytes: 1000 },
    });
    expect(capped.targets).toHaveLength(10);
    expect(capped.completeness).toEqual({ complete: false, truncatedAt: 10, reasons: ['example:max_files'] });
    const failing = fakeAdapter('bad', {}, { inventory: async () => Promise.reject(new Error('x')) });
    const slow = fakeAdapter('slow', {}, { inventory: () => new Promise(() => undefined) });
    const r = await buildInventory({
      registry: createAdapterRegistry([failing, slow]),
      adapterIds: ['bad', 'slow', 'gone'],
      workspace: memoryWorkspace({}),
      host,
      limits,
      budgetMs: 100,
    });
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.reasons).toEqual([
      'adapter_failed:bad',
      'adapter_unavailable:gone',
      'inspection_truncated:slow',
    ]);
  });

  it('treats filenames with shell metacharacters as inert data', async () => {
    const weird = [
      'test/$(rm -rf ~)_test.dart',
      'test/`id`;echo_test.dart',
      'test/a|b&c_test.dart',
      'test/naïve ünïcödé_test.dart',
    ];
    const inv = await buildInventory({
      registry: createAdapterRegistry([createExampleAdapter()]),
      adapterIds: ['example'],
      workspace: memoryWorkspace(Object.fromEntries(weird.map((w) => [w, '']))),
      host,
      limits,
    });
    expect(inv.targets.map((t) => t.path).sort()).toEqual([...weird].sort());
    const spec = createExampleAdapter().buildExecution({
      attemptNo: 1,
      targets: inv.targets,
      options: { coverage: false, timeoutMs: 1000 },
    })[0]!;
    const paths = spec.args.flatMap((a) => (a.kind === 'workspacePath' ? [a.rel] : []));
    expect(paths.sort()).toEqual([...weird].sort());
  });
});

describe('INS-002 pageInventory', () => {
  const targets = [
    ...Array.from({ length: 30 }, (_, i) => target('flutter', `test/unit/u${String(i).padStart(2, '0')}_test.dart`)),
    ...Array.from({ length: 20 }, (_, i) =>
      target('flutter', `test/widget/w${String(i).padStart(2, '0')}_test.dart`, 'widget'),
    ),
  ];
  const inv = inventoryOf(targets);

  it('pages with cursors, filters by level and prefix, and fits the contract', () => {
    const p1 = pageInventory(inv, { codec, limit: 2, filter: { level: 'widget' } });
    if (!p1.ok) throw new Error('unexpected');
    expect(p1.value.targets.map((t) => t.path)).toEqual(['test/widget/w00_test.dart', 'test/widget/w01_test.dart']);
    expect(InspectTestInventoryOutput.safeParse(p1.value).success).toBe(true);
    const p2 = pageInventory(inv, { codec, limit: 2, filter: { level: 'widget' }, cursor: p1.value.nextCursor! });
    expect(p2.ok && p2.value.targets[0]!.path).toBe('test/widget/w02_test.dart');
    const byPrefix = pageInventory(inv, { codec, limit: 200, filter: { pathPrefix: 'test/unit/' } });
    expect(byPrefix.ok && byPrefix.value.targets).toHaveLength(30);
    expect(
      pageInventory(inv, { codec, limit: 2, filter: { level: 'unit' }, cursor: p1.value.nextCursor! }),
    ).toMatchObject({ ok: false, error: { error: { code: 'E_CURSOR_INVALID' } } });
  });

  it('rejects escaping path prefixes', () => {
    for (const bad of ['../x', '/abs', 'test/../..', '%2e%2e/x', 'a\\b', './test', ''])
      expect(() => normalizePrefix(bad)).toThrow(InspectError);
    expect(normalizePrefix('test/unit/')).toBe('test/unit');
  });

  it('property: paging any filter with any limit yields every matching target exactly once, in order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.constantFrom(undefined, 'unit', 'widget'),
        fc.constantFrom(undefined, 'test/unit', 'test/widget', 'test'),
        (limit, level, pathPrefix) => {
          const filter = {
            ...(level ? { level: level as TestTarget['level'] } : {}),
            ...(pathPrefix ? { pathPrefix } : {}),
          };
          const expected = targets
            .filter((t) => (!level || t.level === level) && (!pathPrefix || t.path.startsWith(`${pathPrefix}/`)))
            .map((t) => t.id);
          const seen: string[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 200; i++) {
            const p = pageInventory(inv, { codec, limit, filter, ...(cursor ? { cursor } : {}) });
            if (!p.ok) return false;
            seen.push(...p.value.targets.map((t) => t.id));
            if (!p.value.nextCursor) break;
            cursor = p.value.nextCursor;
          }
          return JSON.stringify(seen) === JSON.stringify(expected);
        },
      ),
      { numRuns: 200 },
    );
  });
});
