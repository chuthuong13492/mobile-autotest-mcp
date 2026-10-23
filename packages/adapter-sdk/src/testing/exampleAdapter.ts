/**
 * A small, complete example adapter used by the kit's self-tests and by policy-conformance tests. It "detects" a
 * `example.json` marker, inventories `test/**\/*_test.dart`, builds Flutter-shaped specs (so the real policy argument
 * schema can validate them) and parses a line protocol: `RESULT <status> <name>`.
 */
import { targetId } from '@autotest/core';
import { flag, flagRunPath, runnerOutput, sortedPaths, word, workspacePath, buildSpec } from '../specs.ts';
import { excerpt, mapRunnerState, type OutcomeMapping } from '../outcomes.ts';
import type { CapabilitySet, NormalizedResult, ParseDiagnostic, PlatformAdapter } from '../types.ts';

const STATES: Readonly<Record<string, OutcomeMapping>> = {
  PASS: { outcome: 'passed' },
  FAIL: { outcome: 'failed', failureKind: 'assertion' },
  ERROR: { outcome: 'failed', failureKind: 'exception' },
  SKIP: { outcome: 'skipped' },
};

export const EXAMPLE_CAPABILITIES: CapabilitySet = {
  levels: ['unit', 'widget'],
  host: { requires: 'any', available: true },
  devices: { needs: 'none', available: true },
  selection: ['file', 'name'],
  resultFormats: ['example-lines@1'],
  resultGranularity: 'test',
  cancellation: 'graceful_then_group',
  coverage: true,
  limitations: [],
};

export function createExampleAdapter(): PlatformAdapter {
  return {
    id: 'example',
    version: '1.0.0',
    async detect(ctx) {
      const found = ctx.workspace.exists('example.json');
      return {
        adapterId: 'example',
        detected: found,
        confidence: found ? 0.9 : 0,
        evidence: found ? ['example.json'] : [],
        platforms: found ? [{ platform: 'host', status: 'present', evidence: ['example.json'] }] : [],
        toolchains: [],
        runners: found ? [{ kind: 'example', configured: true, evidence: ['example.json'] }] : [],
        limitations: [],
      };
    },
    async capabilities() {
      return EXAMPLE_CAPABILITIES;
    },
    async inventory(ctx) {
      const listed = ctx.workspace.list(['test/**/*_test.dart'], { maxFiles: ctx.limits.maxFiles });
      const targets = sortedPaths(listed.files).map((path) => ({
        id: targetId('example', path),
        adapterId: 'example',
        level: 'unit' as const,
        path,
        selector: { kind: 'file' as const, value: path },
        platforms: ['host' as const],
        requires: { host: 'any' as const, device: 'none' as const },
        tags: [],
      }));
      return {
        adapterId: 'example',
        targets,
        helpers: [],
        automationConfigs: [],
        complete: !listed.truncated,
        truncatedAt: listed.truncated ? targets.length : null,
        reasons: listed.truncated ? ['max_files'] : [],
      };
    },
    resolveTargets(input) {
      const ids = new Set(input.targets.map((t) => t.id));
      const resolved: { testCaseId: string; targetId: string }[] = [];
      const unresolved: { testCaseId: string; reason: string }[] = [];
      for (const c of input.testCases) {
        if (c.targetRef && ids.has(c.targetRef)) resolved.push({ testCaseId: c.id, targetId: c.targetRef });
        else unresolved.push({ testCaseId: c.id, reason: c.targetRef ? 'target_not_in_inventory' : 'no_target' });
      }
      return { resolved, unresolved };
    },
    buildExecution(req) {
      const paths = sortedPaths(req.targets.map((t) => t.path));
      return [
        buildSpec({
          executable: 'flutter',
          args: [
            word('test'),
            flag('--no-pub'),
            flagRunPath('--file-reporter', runnerOutput(req.attemptNo, 'results.jsonl'), 'json:'),
            ...(req.options.coverage
              ? [flag('--coverage'), flagRunPath('--coverage-path', runnerOutput(req.attemptNo, 'lcov.info'))]
              : []),
            ...paths.map(workspacePath),
          ],
          cwd: '.',
          envNeeds: [],
          expectedOutputs: [{ kind: 'runner_json', rel: runnerOutput(req.attemptNo, 'results.jsonl') }],
          timeoutMs: req.options.timeoutMs,
          cancellation: 'graceful_then_group',
          requires: { host: 'any', device: 'none' },
        }),
      ];
    },
    parseResults(outputs) {
      const diagnostics: ParseDiagnostic[] = [];
      const text = outputs.files[runnerOutput(outputs.attemptNo, 'results.jsonl')];
      if (text === undefined)
        return { results: [], diagnostics: [{ code: 'runner_output_missing', message: 'no results file' }] };
      const results: NormalizedResult[] = [];
      const target = outputs.targets[0]?.id;
      for (const line of text.split('\n').slice(0, 100_000)) {
        const m = /^RESULT (\S{1,32}) (.{1,500})$/.exec(line);
        if (!m) {
          if (line.trim())
            diagnostics.push({ code: 'unparsable_line', message: 'ignored a line that is not a result' });
          continue;
        }
        if (!target) continue;
        const mapped = mapRunnerState(m[1]!, STATES, diagnostics);
        results.push({
          targetId: target,
          name: m[2]!,
          outcome: mapped.outcome,
          ...(mapped.failureKind ? { failureKind: mapped.failureKind } : {}),
          rawStatus: m[1]!,
        });
      }
      return { results, diagnostics: diagnostics.slice(0, 100), protocol: 'example-lines@1' };
    },
    evidenceHints(outputs) {
      return [
        {
          kind: 'runner_json',
          rel: runnerOutput(outputs.attemptNo, 'results.jsonl'),
          mimeType: 'application/x-ndjson',
          required: true,
        },
      ];
    },
    failureSignals(results) {
      return results
        .filter((r) => r.outcome === 'failed')
        .map((r) => ({
          targetId: r.targetId,
          resultName: r.name,
          signal: r.failureKind === 'exception' ? 'example.exception' : 'example.assertion',
          indicates: { class: r.failureKind === 'exception' ? ('unknown' as const) : ('product_defect' as const) },
          evidence: excerpt(r.messageExcerpt ?? r.rawStatus, 200)!,
        }));
    },
    cleanupSpecs() {
      return [];
    },
  };
}
