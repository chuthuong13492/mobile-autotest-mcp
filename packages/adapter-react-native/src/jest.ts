/**
 * Jest execution and parsing (RN-002). The configured Node runs the workspace's own Jest
 * (`node_modules/jest/bin/jest.js`, never `npx`) with `--ci --json --outputFile <runDir>/…/jest.json
 * --testLocationInResults --runTestsByPath --no-watchman <files>`; flags verified with Jest 29.7. The JSON report has
 * one entry per test file and one assertion result per test.
 */
import {
  buildSpec,
  flag,
  flagRunPath,
  runnerOutput,
  workspacePath,
  type ExecutionSpec,
  type NormalizedResult,
  type TestTarget,
} from '@autotest/adapter-sdk';

export const JEST_SCRIPT = 'node_modules/jest/bin/jest.js';
export const jestReport = (attemptNo: number) => runnerOutput(attemptNo, 'jest.json');

export function jestSpec(attemptNo: number, targets: readonly TestTarget[], timeoutMs: number): ExecutionSpec {
  return buildSpec({
    executable: 'node',
    args: [
      workspacePath(JEST_SCRIPT),
      flag('--ci'),
      flag('--json'),
      flagRunPath('--outputFile', jestReport(attemptNo)),
      flag('--testLocationInResults'),
      flag('--no-watchman'),
      flag('--runTestsByPath'),
      ...[...new Set(targets.map((t) => t.path))].sort().map((p) => workspacePath(p)),
    ],
    cwd: '.',
    envNeeds: [],
    expectedOutputs: [{ kind: 'runner_json', rel: jestReport(attemptNo) }],
    timeoutMs,
    cancellation: 'graceful_then_group',
    requires: { host: 'any', device: 'none' },
  });
}

interface JestAssertion {
  readonly fullName?: string;
  readonly title?: string;
  readonly status?: string;
  readonly duration?: number | null;
  readonly failureMessages?: readonly string[];
}

interface JestFile {
  readonly name?: string;
  readonly status?: string;
  readonly message?: string;
  readonly assertionResults?: readonly JestAssertion[];
}

const OUTCOME: Readonly<Record<string, NormalizedResult['outcome']>> = {
  passed: 'passed',
  failed: 'failed',
  pending: 'skipped',
  skipped: 'skipped',
  todo: 'skipped',
  disabled: 'skipped',
};

// ANSI colour codes in Jest's failure messages.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (s: string) => s.replace(ANSI, '');

/**
 * Maps a Jest JSON report to results. The report names files by absolute path; each is matched to the target whose
 * workspace-relative path it ends with (the longest, if several do). A file that failed without any assertion result
 * (a syntax or import error) yields one `load_error` result for its target.
 */
export function parseJestReport(
  text: string | undefined,
  targets: readonly TestTarget[],
): { results: NormalizedResult[]; ok: boolean } {
  let report: { testResults?: readonly JestFile[] };
  try {
    report = JSON.parse(text ?? '') as typeof report;
  } catch {
    return { results: [], ok: false };
  }
  const byPath = new Map(targets.map((t) => [t.path, t]));
  const relOf = (abs: string) =>
    [...byPath.keys()].filter((p) => abs === p || abs.endsWith(`/${p}`)).sort((a, b) => b.length - a.length)[0] ?? abs;
  const results: NormalizedResult[] = [];
  for (const file of report.testResults ?? []) {
    const t = byPath.get(relOf(file.name ?? ''));
    if (!t) continue;
    const assertions = file.assertionResults ?? [];
    if (assertions.length === 0 && file.status === 'failed') {
      results.push({
        targetId: t.id,
        name: `load ${t.path}`,
        suitePath: t.path,
        outcome: 'failed',
        failureKind: 'load_error',
        messageExcerpt: plain(file.message ?? '')
          .trim()
          .slice(0, 2000),
        rawStatus: 'suite_failed',
      });
      continue;
    }
    for (const a of assertions) {
      const outcome = OUTCOME[a.status ?? ''] ?? 'infra_error';
      const message = plain((a.failureMessages ?? []).join('\n')).trim();
      results.push({
        targetId: t.id,
        name: a.fullName ?? a.title ?? 'test',
        suitePath: t.path,
        outcome,
        ...(outcome === 'failed'
          ? { failureKind: /expect\(|Expected|Received/.test(message) ? 'assertion' : 'exception' }
          : {}),
        ...(typeof a.duration === 'number' ? { durationMs: Math.round(a.duration) } : {}),
        ...(message ? { messageExcerpt: message.slice(0, 2000) } : {}),
        rawStatus: a.status ?? 'unknown',
      });
    }
  }
  return { results, ok: true };
}
