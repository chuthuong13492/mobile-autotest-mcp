/**
 * Project inspection (INS-001; TL-02; FR-005 – FR-007; ADR-0009).
 *
 * Runs every selected adapter's `detect` within the time budget, scans file extensions for languages, merges
 * platforms (a `present` platform must carry evidence, otherwise it is reported `unknown`), and resolves toolchain
 * versions across all sources: one distinct value resolves, several distinct values are a conflict that is reported
 * and never auto-selected. Detection is static: no repository file is executed.
 */
import type { Limitation, Platform, PlatformStatus, ToolchainResolution } from '@autotest/core';
import type { AdapterRegistry, AdapterWorkspace, DetectionResult, HostInfo, ProbePort } from '@autotest/adapter-sdk';
import { createBudget, DEFAULT_BUDGET_MS } from './budget.ts';

export class InspectError extends Error {
  override readonly name = 'InspectError';
  readonly code: 'unknown_adapter' | 'path_escape';
  constructor(code: InspectError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface InspectProjectOptions {
  readonly registry: AdapterRegistry;
  readonly workspace: AdapterWorkspace;
  readonly host: HostInfo;
  readonly probes?: ProbePort;
  readonly adapterIds?: readonly string[];
  readonly maxFiles: number;
  readonly budgetMs?: number;
}

export interface ProjectInspection {
  readonly frameworks: { adapterId: string; confidence: number; evidence: string[] }[];
  readonly platforms: { platform: Platform; status: PlatformStatus; evidence: string[] }[];
  readonly languages: string[];
  readonly toolchains: ToolchainResolution[];
  readonly runners: { adapterId: string; kind: string; configured: boolean; evidence: string[] }[];
  readonly limitations: Limitation[];
  readonly filesScanned: number;
}

const LANGUAGES: Readonly<Record<string, string>> = {
  dart: 'dart',
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  swift: 'swift',
  m: 'objective-c',
  mm: 'objective-c',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
};

export function selectAdapters(registry: AdapterRegistry, ids: readonly string[] | undefined) {
  if (!ids) return registry.adapters;
  const unknown = ids.filter((id) => !registry.get(id));
  if (unknown.length) throw new InspectError('unknown_adapter', `unknown adapter: ${unknown.join(', ')}`);
  return registry.adapters.filter((a) => ids.includes(a.id));
}

export async function inspectProject(o: InspectProjectOptions): Promise<ProjectInspection> {
  const adapters = selectAdapters(o.registry, o.adapterIds);
  const budget = createBudget(o.budgetMs ?? DEFAULT_BUDGET_MS);
  const limitations: Limitation[] = [];

  // Languages from a bounded extension scan (no file contents are read).
  const scan = o.workspace.list(['**/*'], { maxFiles: o.maxFiles });
  const langs = new Set<string>();
  for (const f of scan.files) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(f)?.[1]?.toLowerCase();
    const lang = ext ? LANGUAGES[ext] : undefined;
    if (lang) langs.add(lang);
  }
  if (scan.truncated)
    limitations.push({ code: 'file_scan_truncated', message: `language scan stopped at ${o.maxFiles} files` });

  const detections: DetectionResult[] = [];
  for (const a of adapters) {
    const r = await budget.run(() =>
      a.detect({ workspace: o.workspace, host: o.host, ...(o.probes ? { probes: o.probes } : {}) }),
    );
    if (r.ok) detections.push(r.value);
    else if (r.reason === 'timeout') {
      limitations.push({ code: 'inspection_truncated', message: `inspection budget exhausted at adapter ${a.id}` });
      break;
    } else limitations.push({ code: 'adapter_failed', message: `${a.id} detection failed` });
  }

  const detected = detections
    .filter((d) => d.detected)
    .sort((x, y) => y.confidence - x.confidence || (x.adapterId < y.adapterId ? -1 : 1));
  for (const d of detected) for (const l of d.limitations) limitations.push(l);

  return {
    frameworks: detected.map((d) => ({
      adapterId: d.adapterId,
      confidence: d.confidence,
      evidence: [...d.evidence].slice(0, 20),
    })),
    platforms: mergePlatforms(detected, limitations),
    languages: [...langs].sort(),
    toolchains: resolveToolchains(detected, limitations),
    runners: detected.flatMap((d) =>
      d.runners.map((r) => ({
        adapterId: d.adapterId,
        kind: r.kind,
        configured: r.configured,
        evidence: [...r.evidence].slice(0, 10),
      })),
    ),
    limitations: dedupe(limitations),
    filesScanned: scan.files.length,
  };
}

const RANK: Readonly<Record<PlatformStatus, number>> = { present: 2, unknown: 1, absent: 0 };

function mergePlatforms(
  detected: readonly DetectionResult[],
  limitations: Limitation[],
): ProjectInspection['platforms'] {
  const by = new Map<Platform, { status: PlatformStatus; evidence: Set<string> }>();
  for (const d of detected) {
    for (const p of d.platforms) {
      let status = p.status;
      if (status === 'present' && p.evidence.length === 0) {
        // FR-006: never report presence without evidence.
        status = 'unknown';
        limitations.push({
          code: 'platform_without_evidence',
          message: `${d.adapterId} reported ${p.platform} present without evidence`,
        });
      }
      // Across adapters the strongest claim wins: present > unknown > absent.
      const cur = by.get(p.platform);
      if (!cur || RANK[status] > RANK[cur.status])
        by.set(p.platform, { status, evidence: cur?.evidence ?? new Set<string>() });
      if (status === 'present') for (const e of p.evidence) by.get(p.platform)!.evidence.add(e);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([platform, v]) => ({ platform, status: v.status, evidence: [...v.evidence].sort().slice(0, 10) }));
}

function resolveToolchains(detected: readonly DetectionResult[], limitations: Limitation[]): ToolchainResolution[] {
  const by = new Map<string, Map<string, string>>();
  for (const d of detected) {
    for (const t of d.toolchains) {
      const sources = by.get(t.tool) ?? new Map<string, string>();
      for (const s of t.versionsBySource) sources.set(s.source, s.value);
      by.set(t.tool, sources);
    }
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([tool, sources]) => {
      const versionsBySource = [...sources.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([source, value]) => ({ source, value }));
      const values = [...new Set(versionsBySource.map((s) => s.value))];
      if (values.length <= 1) return { tool, versionsBySource, resolved: values[0] ?? null, conflicts: [] };
      const firstSourceOf = (v: string) => versionsBySource.find((s) => s.value === v)!.source.split(':')[0]!;
      const conflicts: string[] = [];
      for (let i = 0; i < values.length; i++)
        for (let j = i + 1; j < values.length; j++)
          conflicts.push(`${firstSourceOf(values[i]!)} vs ${firstSourceOf(values[j]!)}`);
      limitations.push({ code: 'version_conflict', message: `${tool} version sources disagree; not auto-selected` });
      return { tool, versionsBySource, resolved: null, conflicts: conflicts.slice(0, 20) };
    });
}

function dedupe(ls: readonly Limitation[]): Limitation[] {
  const seen = new Set<string>();
  return ls.filter((l) => {
    const k = `${l.code}\u0000${l.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
