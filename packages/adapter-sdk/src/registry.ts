/**
 * Adapter registry (ADP-001; ADR-0009 §4). Every registered adapter runs `detect`; several may match one
 * repository (a Flutter app also has native folders). An adapter that throws is reported as a limitation instead of
 * failing inspection. Results are ordered by confidence, then id, so output is deterministic.
 */
import type { DetectContext, DetectionResult, PlatformAdapter } from './types.ts';

export interface AdapterRegistry {
  readonly adapters: readonly PlatformAdapter[];
  get(id: string): PlatformAdapter | undefined;
  detectAll(ctx: DetectContext): Promise<DetectionResult[]>;
}

const ID = /^[a-z][a-z0-9-]{1,30}$/;

export function createAdapterRegistry(adapters: readonly PlatformAdapter[]): AdapterRegistry {
  const ids = new Set<string>();
  for (const a of adapters) {
    if (!ID.test(a.id)) throw new Error(`invalid adapter id: ${a.id}`);
    if (ids.has(a.id)) throw new Error(`duplicate adapter id: ${a.id}`);
    ids.add(a.id);
  }
  const sorted = [...adapters].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    adapters: sorted,
    get: (id) => sorted.find((a) => a.id === id),
    async detectAll(ctx) {
      const out: DetectionResult[] = [];
      for (const a of sorted) {
        try {
          out.push(await a.detect(ctx));
        } catch {
          out.push({
            adapterId: a.id,
            detected: false,
            confidence: 0,
            evidence: [],
            platforms: [],
            toolchains: [],
            runners: [],
            limitations: [{ code: 'adapter_failed', message: `${a.id} detection failed` }],
          });
        }
      }
      return out.sort((x, y) => y.confidence - x.confidence || (x.adapterId < y.adapterId ? -1 : 1));
    },
  };
}
