/** In-memory workspace and kit fixtures (adapter-sdk tests may not touch the filesystem). */
import type { AdapterWorkspace } from '@autotest/adapter-sdk';
import type { KitFixtures } from '@autotest/adapter-sdk/testing';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';

function globToRe(glob: string): RegExp {
  const re = glob
    .split('**/')
    .map((part) => part.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('(?:[^/]+/)*');
  return new RegExp(`^${re}$`);
}

export function memoryWorkspace(files: Record<string, string>): AdapterWorkspace {
  return {
    readText: (rel, max = 1 << 20) => {
      const t = files[rel];
      if (t === undefined) throw new Error('not found');
      return { text: t.slice(0, max), sizeBytes: t.length, truncated: t.length > max, binary: false };
    },
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

export async function exampleFixtures(): Promise<KitFixtures> {
  const workspace = memoryWorkspace({
    'example.json': '{}',
    'test/a_test.dart': '',
    'test/sub/b_test.dart': '',
    'lib/main.dart': '',
  });
  const ctx = { workspace, host: { os: 'macos' as const } };
  const inv = await createExampleAdapter().inventory({ ...ctx, limits: { maxFiles: 100, maxReadBytes: 1 << 20 } });
  const results = 'RESULT PASS badge shows count\nRESULT FAIL badge hidden\nRESULT SKIP slow\n';
  return {
    detect: ctx,
    inventory: { ...ctx, limits: { maxFiles: 100, maxReadBytes: 1 << 20 } },
    requests: [
      { attemptNo: 1, targets: inv.targets, options: { coverage: false, timeoutMs: 60_000 } },
      { attemptNo: 2, targets: [...inv.targets].reverse(), options: { coverage: true, timeoutMs: 60_000 } },
    ],
    outputs: {
      attemptNo: 1,
      targets: inv.targets,
      files: { 'attempts/1/runner/results.jsonl': results },
      processes: [{ exitCode: 1 }],
      interrupted: false,
    },
    unknownStateOutputs: {
      attemptNo: 1,
      targets: inv.targets,
      files: { 'attempts/1/runner/results.jsonl': 'RESULT WEIRD something odd\n' },
      processes: [{ exitCode: 0 }],
      interrupted: false,
    },
  };
}
