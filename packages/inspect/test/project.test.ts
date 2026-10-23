import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '@autotest/adapter-sdk';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import { InspectProjectOutput } from '@autotest/core';
import { InspectError, inspectProject } from '@autotest/inspect';
import { fakeAdapter, memoryWorkspace } from './helpers.ts';

const host = { os: 'macos' as const };
const ws = memoryWorkspace({
  'example.json': '{}',
  'lib/main.dart': '',
  'test/a_test.dart': '',
  'android/app/Main.kt': '',
  'ios/Runner/App.swift': '',
  'tool/x.ts': '',
});

describe('INS-001 inspectProject', () => {
  it('reports frameworks, platforms, languages and runners with evidence; output fits the contract', async () => {
    const r = await inspectProject({
      registry: createAdapterRegistry([createExampleAdapter()]),
      workspace: ws,
      host,
      maxFiles: 1000,
    });
    expect(r.frameworks).toEqual([{ adapterId: 'example', confidence: 0.9, evidence: ['example.json'] }]);
    expect(r.platforms).toEqual([{ platform: 'host', status: 'present', evidence: ['example.json'] }]);
    expect(r.languages).toEqual(['dart', 'kotlin', 'swift', 'typescript']);
    expect(r.runners).toEqual([
      { adapterId: 'example', kind: 'example', configured: true, evidence: ['example.json'] },
    ]);
    const rest = Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'filesScanned'));
    expect(r.filesScanned).toBe(6);
    expect(
      InspectProjectOutput.safeParse({ projectProfileId: 'prj_01JC0000000000000000000002', ...rest }).success,
    ).toBe(true);
    expect(
      await inspectProject({
        registry: createAdapterRegistry([createExampleAdapter()]),
        workspace: ws,
        host,
        maxFiles: 1000,
      }),
    ).toEqual(r);
  });

  it('a version range is recorded but never resolved or compared', async () => {
    const a = fakeAdapter('alpha', {
      toolchains: [
        {
          tool: 'dart',
          versionsBySource: [
            { source: 'pubspec.yaml', value: '>=3.5.0 <4.0.0' },
            { source: 'probe:flutter --version --machine', value: '3.13.1' },
          ],
          resolved: '3.13.1',
          conflicts: [],
        },
      ],
    });
    const only = fakeAdapter('beta', {
      toolchains: [
        { tool: 'kotlin', versionsBySource: [{ source: 'gradle', value: '^2.0.0' }], resolved: null, conflicts: [] },
      ],
    });
    const r = await inspectProject({ registry: createAdapterRegistry([a, only]), workspace: ws, host, maxFiles: 1000 });
    expect(r.toolchains.map((t) => [t.tool, t.resolved, t.conflicts])).toEqual([
      ['dart', '3.13.1', []],
      ['kotlin', null, []],
    ]);
  });

  it('resolves agreeing toolchain sources and reports conflicts without picking one', async () => {
    const a = fakeAdapter('alpha', {
      toolchains: [
        {
          tool: 'flutter',
          versionsBySource: [{ source: 'pubspec.yaml:environment.flutter', value: '3.38.4' }],
          resolved: '3.38.4',
          conflicts: [],
        },
      ],
    });
    const b = fakeAdapter('beta', {
      toolchains: [
        {
          tool: 'flutter',
          versionsBySource: [{ source: 'bitrise.yml:CURRENT_FLUTTER_VERSION', value: '3.38.10' }],
          resolved: '3.38.10',
          conflicts: [],
        },
        {
          tool: 'dart',
          versionsBySource: [
            { source: '.tool-versions', value: '3.10.0' },
            { source: 'probe:dart --version', value: '3.10.0' },
          ],
          resolved: null,
          conflicts: [],
        },
      ],
    });
    const r = await inspectProject({ registry: createAdapterRegistry([a, b]), workspace: ws, host, maxFiles: 1000 });
    expect(r.toolchains).toEqual([
      {
        tool: 'dart',
        versionsBySource: [
          { source: '.tool-versions', value: '3.10.0' },
          { source: 'probe:dart --version', value: '3.10.0' },
        ],
        resolved: '3.10.0',
        conflicts: [],
      },
      {
        tool: 'flutter',
        versionsBySource: [
          { source: 'bitrise.yml:CURRENT_FLUTTER_VERSION', value: '3.38.10' },
          { source: 'pubspec.yaml:environment.flutter', value: '3.38.4' },
        ],
        resolved: null,
        conflicts: ['bitrise.yml vs pubspec.yaml'],
      },
    ]);
    expect(r.limitations).toContainEqual({
      code: 'version_conflict',
      message: 'flutter version sources disagree; not auto-selected',
    });
  });

  it('never reports a platform present without evidence; the strongest evidenced claim wins', async () => {
    const vague = fakeAdapter('vague', {
      platforms: [
        { platform: 'android', status: 'present', evidence: [] },
        { platform: 'ios', status: 'absent', evidence: [] },
      ],
    });
    const sure = fakeAdapter('sure', {
      platforms: [{ platform: 'ios', status: 'present', evidence: ['ios/Runner.xcodeproj'] }],
    });
    const r = await inspectProject({
      registry: createAdapterRegistry([vague, sure]),
      workspace: ws,
      host,
      maxFiles: 1000,
    });
    expect(r.platforms).toEqual([
      { platform: 'android', status: 'unknown', evidence: [] },
      { platform: 'ios', status: 'present', evidence: ['ios/Runner.xcodeproj'] },
    ]);
    expect(r.limitations.map((l) => l.code)).toContain('platform_without_evidence');
    for (const p of r.platforms) if (p.status === 'present') expect(p.evidence.length).toBeGreaterThan(0);
  });

  it('enforces the time budget with partial results and survives a failing adapter', async () => {
    const fast = fakeAdapter('aaa', { confidence: 0.4 });
    const failing = fakeAdapter('bbb', {}, { detect: async () => Promise.reject(new Error('boom')) });
    const slow = fakeAdapter(
      'ccc',
      {},
      {
        detect: () =>
          new Promise((res) =>
            setTimeout(
              () =>
                res({
                  adapterId: 'ccc',
                  detected: true,
                  confidence: 1,
                  evidence: ['x'],
                  platforms: [],
                  toolchains: [],
                  runners: [],
                  limitations: [],
                }),
              5000,
            ),
          ),
      },
    );
    const t0 = Date.now();
    const r = await inspectProject({
      registry: createAdapterRegistry([fast, failing, slow]),
      workspace: ws,
      host,
      maxFiles: 1000,
      budgetMs: 150,
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.frameworks.map((f) => f.adapterId)).toEqual(['aaa']);
    expect(r.limitations.map((l) => l.code)).toEqual(
      expect.arrayContaining(['adapter_failed', 'inspection_truncated']),
    );
  });

  it('restricts detection to requested adapters and rejects unknown ones; reports a truncated scan', async () => {
    const reg = createAdapterRegistry([createExampleAdapter(), fakeAdapter('other', {})]);
    expect(
      (
        await inspectProject({ registry: reg, workspace: ws, host, maxFiles: 1000, adapterIds: ['other'] })
      ).frameworks.map((f) => f.adapterId),
    ).toEqual(['other']);
    await expect(
      inspectProject({ registry: reg, workspace: ws, host, maxFiles: 1000, adapterIds: ['nope'] }),
    ).rejects.toBeInstanceOf(InspectError);
    const small = await inspectProject({ registry: reg, workspace: ws, host, maxFiles: 2 });
    expect(small.limitations.map((l) => l.code)).toContain('file_scan_truncated');
  });
});
