import type { AdapterWorkspace, DetectionResult, PlatformAdapter } from '@autotest/adapter-sdk';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';

const globToRe = (glob: string) =>
  new RegExp(
    `^${glob
      .split('**/')
      .map((p) =>
        p
          .replace(/[.+^$()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/(?<!\.)\*/g, '[^/]*'),
      )
      .join('(?:[^/]+/)*')}$`,
  );

export function memoryWorkspace(files: Record<string, string>): AdapterWorkspace {
  return {
    readText: (rel, max = 1 << 20) => ({
      text: (files[rel] ?? '').slice(0, max),
      sizeBytes: (files[rel] ?? '').length,
      truncated: false,
      binary: false,
    }),
    exists: (rel) => rel in files,
    list: (globs, opts = {}) => {
      const res = globs.map(globToRe);
      const all = Object.keys(files)
        .filter((f) => res.some((r) => r.test(f)))
        .sort();
      const max = opts.maxFiles ?? 5000;
      return { files: all.slice(0, max), matched: all.length, truncated: all.length > max };
    },
  };
}

/** An adapter that detects with the given result and inventories nothing special. */
export function fakeAdapter(
  id: string,
  detection: Partial<DetectionResult>,
  over: Partial<PlatformAdapter> = {},
): PlatformAdapter {
  const base = createExampleAdapter();
  return {
    ...base,
    id,
    detect: async () => ({
      adapterId: id,
      detected: true,
      confidence: 0.5,
      evidence: ['marker'],
      platforms: [],
      toolchains: [],
      runners: [],
      limitations: [],
      ...detection,
    }),
    inventory: async () => ({
      adapterId: id,
      targets: [],
      helpers: [],
      automationConfigs: [],
      complete: true,
      truncatedAt: null,
      reasons: [],
    }),
    ...over,
  };
}
