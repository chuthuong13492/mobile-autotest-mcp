/**
 * ADP-001 policy conformance: the adapter contract kit with the *real* policy validator (argument schemas, path
 * containment). Adapters cannot import policy, so this check lives where specs meet policy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import type { AdapterWorkspace, PlatformAdapter } from '@autotest/adapter-sdk';
import { adapterContractCases, createExampleAdapter, type KitFixtures } from '@autotest/adapter-sdk/testing';
import { buildRegistry, nodeFsPort, validateSpec } from '@autotest/policy';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-adp-')));
const ws = path.join(base, 'ws');
const runDir = path.join(base, 'run');
const files: Record<string, string> = { 'example.json': '{}', 'test/a_test.dart': '', 'test/sub/b_test.dart': '' };
for (const [rel, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), text);
}
fs.mkdirSync(runDir);
fs.writeFileSync(path.join(base, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });

const fsp = nodeFsPort();
const registry = buildRegistry(fsp, { flutter: { path: path.join(base, 'flutter') } });
const workspace: AdapterWorkspace = {
  readText: (rel) => ({
    text: files[rel] ?? '',
    sizeBytes: (files[rel] ?? '').length,
    truncated: false,
    binary: false,
  }),
  exists: (rel) => rel in files,
  list: () => {
    const f = Object.keys(files)
      .filter((k) => k.endsWith('_test.dart'))
      .sort();
    return { files: f, matched: f.length, truncated: false };
  },
};
const ctx = { workspace, host: { os: 'macos' as const } };
const inv = await createExampleAdapter().inventory({ ...ctx, limits: { maxFiles: 10, maxReadBytes: 1024 } });
const fx: KitFixtures = {
  detect: ctx,
  inventory: { ...ctx, limits: { maxFiles: 10, maxReadBytes: 1024 } },
  requests: [{ attemptNo: 1, targets: inv.targets, options: { coverage: true, timeoutMs: 60_000 } }],
  outputs: {
    attemptNo: 1,
    targets: inv.targets,
    files: { 'attempts/1/runner/results.jsonl': 'RESULT PASS a\n' },
    processes: [{ exitCode: 0 }],
    interrupted: false,
  },
};
const validate = (spec: Parameters<typeof validateSpec>[0]) => {
  const r = validateSpec(spec, {
    fs: fsp,
    registry,
    workspaceRoot: ws,
    runDir,
    allowDependencyResolution: false,
    allowedClasses: ['test_runner'],
  });
  return r.ok ? { ok: true } : { ok: false, detail: r.denials.map((d) => `${d.code}:${d.detail}`).join(',') };
};

describe('ADP-001 kit with the real policy validator', () => {
  for (const c of adapterContractCases(createExampleAdapter, fx, { validateSpec: validate })) it(c.name, c.run);

  it('a spec with a forbidden flag is rejected by the real validator through the kit', async () => {
    const goldens = (): PlatformAdapter => {
      const a = createExampleAdapter();
      return {
        ...a,
        buildExecution: (req) =>
          a.buildExecution(req).map((s) => ({ ...s, args: [...s.args, { kind: 'flag', name: '--update-goldens' }] })),
      };
    };
    const c = adapterContractCases(goldens, fx, { validateSpec: validate }).find((x) =>
      x.name.includes('buildExecution'),
    )!;
    let message = '';
    try {
      await c.run();
    } catch (e) {
      message = (e as Error).message;
    }
    if (!message.includes('forbidden_flag:--update-goldens'))
      throw new Error(`expected a policy denial, got: ${message}`);
  });
});
