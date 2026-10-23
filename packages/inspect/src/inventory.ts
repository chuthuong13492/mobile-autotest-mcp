/**
 * Test inventory snapshots and paging (INS-002; TL-03; FR-008; NFR-004).
 *
 * `buildInventory` runs each profiled adapter's `inventory` within the budget and merges the fragments into one
 * snapshot: targets de-duplicated by id and ordered by path, helpers de-duplicated, counts computed, and
 * completeness reported honestly (an adapter timeout, failure or truncation, or the overall file cap, all make the
 * snapshot incomplete with a reason). `pageInventory` serves pages from a stored snapshot only, through HMAC
 * cursors, so pages never shift. Paths and names are data: nothing here interprets or executes them.
 */
import {
  paginate,
  type CursorCodec,
  type TestInventory,
  type TestLevel,
  type TestTarget,
  type ToolError,
} from '@autotest/core';
import type { AdapterRegistry, HostInfo, InventoryContext, AdapterWorkspace } from '@autotest/adapter-sdk';
import { createBudget, DEFAULT_BUDGET_MS } from './budget.ts';
import { InspectError } from './project.ts';

export type InventoryContent = Pick<
  TestInventory,
  'targets' | 'helpers' | 'automationConfigs' | 'counts' | 'completeness' | 'limits'
>;

export interface BuildInventoryOptions {
  readonly registry: AdapterRegistry;
  readonly adapterIds: readonly string[];
  readonly workspace: AdapterWorkspace;
  readonly host: HostInfo;
  readonly limits: { readonly maxFiles: number; readonly maxBytes: number };
  readonly budgetMs?: number;
}

export async function buildInventory(o: BuildInventoryOptions): Promise<InventoryContent> {
  const budget = createBudget(o.budgetMs ?? DEFAULT_BUDGET_MS);
  const ctx: InventoryContext = {
    workspace: o.workspace,
    host: o.host,
    limits: { maxFiles: o.limits.maxFiles, maxReadBytes: o.limits.maxBytes },
  };
  const targets = new Map<string, TestTarget>();
  const helpers = new Map<string, TestInventory['helpers'][number]>();
  const configs = new Map<string, TestInventory['automationConfigs'][number]>();
  const reasons: string[] = [];
  let complete = true;
  let truncatedAt: number | null = null;

  for (const id of [...o.adapterIds].sort()) {
    const adapter = o.registry.get(id);
    if (!adapter) {
      complete = false;
      reasons.push(`adapter_unavailable:${id}`);
      continue;
    }
    const r = await budget.run(() => adapter.inventory(ctx));
    if (!r.ok) {
      complete = false;
      reasons.push(r.reason === 'timeout' ? `inspection_truncated:${id}` : `adapter_failed:${id}`);
      if (r.reason === 'timeout') break;
      continue;
    }
    const f = r.value;
    if (!f.complete) {
      complete = false;
      truncatedAt ??= f.truncatedAt;
      for (const reason of f.reasons) reasons.push(`${id}:${reason}`);
    }
    for (const t of f.targets) if (t.adapterId === id && !targets.has(t.id)) targets.set(t.id, t);
    for (const h of f.helpers) helpers.set(`${h.kind}\u0000${h.path}`, { path: h.path, kind: h.kind });
    for (const c of f.automationConfigs) configs.set(`${c.kind}\u0000${c.path}`, { path: c.path, kind: c.kind });
  }

  let ordered = [...targets.values()].sort((a, b) =>
    a.path === b.path ? (a.id < b.id ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  if (ordered.length > o.limits.maxFiles) {
    ordered = ordered.slice(0, o.limits.maxFiles);
    complete = false;
    truncatedAt = o.limits.maxFiles;
    reasons.push('max_files');
  }
  const byLevel: Record<string, number> = {};
  const byAdapter: Record<string, number> = {};
  for (const t of ordered) {
    byLevel[t.level] = (byLevel[t.level] ?? 0) + 1;
    byAdapter[t.adapterId] = (byAdapter[t.adapterId] ?? 0) + 1;
  }
  const sortBy = <T extends { path: string; kind: string }>(xs: Iterable<T>) =>
    [...xs].sort((a, b) => (a.path === b.path ? (a.kind < b.kind ? -1 : 1) : a.path < b.path ? -1 : 1));
  return {
    targets: ordered,
    helpers: sortBy(helpers.values()),
    automationConfigs: sortBy(configs.values()),
    counts: { total: ordered.length, byLevel, byAdapter },
    completeness: { complete, truncatedAt: complete ? null : truncatedAt, reasons: [...new Set(reasons)].slice(0, 50) },
    limits: { maxFiles: o.limits.maxFiles, maxBytes: o.limits.maxBytes },
  };
}

export interface InventoryFilter {
  readonly adapterId?: string | undefined;
  readonly level?: TestLevel | undefined;
  readonly pathPrefix?: string | undefined;
}

/** Normalizes a workspace-relative prefix; rejects absolute, traversing or otherwise suspicious values. */
export function normalizePrefix(prefix: string): string {
  const p = prefix.replace(/\/+$/, '');
  if (
    !p ||
    p.startsWith('/') ||
    p.includes('\\') ||
    p.includes('\0') ||
    /%(2e|2f|5c)/i.test(p) ||
    p.split('/').some((s) => s === '..' || s === '.' || s === '')
  ) {
    throw new InspectError('path_escape', 'pathPrefix must be a contained workspace-relative path');
  }
  return p;
}

export function filterTargets(targets: readonly TestTarget[], filter: InventoryFilter | undefined): TestTarget[] {
  const prefix = filter?.pathPrefix === undefined ? undefined : normalizePrefix(filter.pathPrefix);
  return targets.filter(
    (t) =>
      (filter?.adapterId === undefined || t.adapterId === filter.adapterId) &&
      (filter?.level === undefined || t.level === filter.level) &&
      (prefix === undefined || t.path === prefix || t.path.startsWith(`${prefix}/`)),
  );
}

export interface InventoryPage {
  readonly inventoryId: string;
  readonly counts: TestInventory['counts'];
  readonly completeness: TestInventory['completeness'];
  readonly helpers: TestInventory['helpers'];
  readonly targets: TestTarget[];
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly untrustedFields: string[];
}

export function pageInventory(
  inventory: TestInventory,
  opts: {
    readonly codec: CursorCodec;
    readonly filter?: InventoryFilter | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  },
): { ok: true; value: InventoryPage } | { ok: false; error: ToolError } {
  const items = filterTargets(inventory.targets, opts.filter);
  return paginate({
    codec: opts.codec,
    tool: 'inspect_test_inventory',
    cursor: opts.cursor,
    limit: opts.limit,
    filter: opts.filter ?? null,
    snapshotId: inventory.id,
    items,
    render: (page, meta) => ({
      inventoryId: inventory.id,
      counts: inventory.counts,
      completeness: inventory.completeness,
      helpers: inventory.helpers.slice(0, 50),
      targets: [...page],
      ...meta,
      untrustedFields: ['/targets/*/path'],
    }),
  });
}
