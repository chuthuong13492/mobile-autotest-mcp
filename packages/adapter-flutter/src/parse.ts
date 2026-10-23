/**
 * Dart JSON reporter parser (FL-004; platform-adapters §Flutter "Result format"; RL-015, RL-034). Outcomes come only
 * from reporter events, never from the exit code (an interrupted run exits 0):
 * - `testDone` success → passed; skipped → skipped; failure → failed(assertion); error → failed(exception);
 * - an `error` event after `testDone` upgrades the test to failed;
 * - a non-hidden `loading <path>` test that errors → failed(load_error) for that file, or blocked
 *   (`prerequisite_missing:pub_get`) when the error says dependencies are not resolved;
 * - hidden tests (setUpAll/tearDownAll/loading) are ignored unless they error;
 * - tests still running when the attempt was interrupted → cancelled; when the runner stopped without a `done`
 *   event or with `done.success == null` → infra_error, with diagnostic `runner_incomplete`.
 * Suites report absolute paths; a suite maps to the inventory target whose path it ends with, and an unmatched
 * suite is reported as a diagnostic, never guessed.
 */
import {
  excerpt,
  mapRunnerState,
  type NormalizedResult,
  type OutcomeMapping,
  type ParseDiagnostic,
  type ParseResult,
  type RunnerOutputs,
  type TestTarget,
} from '@autotest/adapter-sdk';

const MAX_LINES = 200_000;
const MAX_DIAGNOSTICS = 100;
const PUB_GET =
  /(Could not find a file named "pubspec\.yaml"|package_config\.json|Couldn't resolve the package|Run ["'`]?(flutter|dart) pub get|Error: Not found: 'package:)/;

const STATES: Readonly<Record<string, OutcomeMapping>> = {
  success: { outcome: 'passed' },
  failure: { outcome: 'failed', failureKind: 'assertion' },
  error: { outcome: 'failed', failureKind: 'exception' },
};

interface TestInfo {
  readonly id: number;
  readonly name: string;
  readonly suiteId: number;
  readonly start: number;
  readonly order: number;
}
interface DoneInfo {
  readonly result: string;
  readonly skipped: boolean;
  readonly hidden: boolean;
  readonly time: number;
}
interface ErrorInfo {
  readonly text: string;
  readonly isFailure: boolean;
}

/** Runner files of one attempt, in a stable order: `flutter.jsonl` first, then `flutter-name-<i>.jsonl`. */
export function runnerFiles(outputs: RunnerOutputs): string[] {
  const prefix = `attempts/${outputs.attemptNo}/runner/`;
  const re = /^flutter(?:-name-(\d+))?\.jsonl$/;
  return Object.keys(outputs.files)
    .filter((k) => k.startsWith(prefix) && re.test(k.slice(prefix.length)))
    .sort((a, b) => {
      const na = Number(re.exec(a.slice(prefix.length))![1] ?? 0);
      const nb = Number(re.exec(b.slice(prefix.length))![1] ?? 0);
      return na - nb;
    });
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function targetFor(suitePath: string, targets: readonly TestTarget[]): TestTarget | undefined {
  const norm = suitePath.replace(/\\/g, '/').replace(/^file:\/\//, '');
  const hits = targets.filter((t) => norm === t.path || norm.endsWith(`/${t.path}`));
  // Prefer the longest (most specific) matching path.
  return hits.sort((a, b) => b.path.length - a.path.length)[0];
}

interface FileParse {
  readonly results: NormalizedResult[];
  readonly complete: boolean;
  readonly protocol?: string;
}

function parseFile(
  text: string,
  outputs: RunnerOutputs,
  diagnostics: ParseDiagnostic[],
  diag: (code: string, message: string) => void,
): FileParse {
  const suites = new Map<number, string>();
  const tests = new Map<number, TestInfo>();
  const done = new Map<number, DoneInfo>();
  const errors = new Map<number, ErrorInfo[]>();
  let protocol: string | undefined;
  let finished: boolean | null | undefined;
  let order = 0;
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) diag('runner_output_truncated', `only the first ${MAX_LINES} lines were read`);
  for (const line of lines.slice(0, MAX_LINES)) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      e = parsed as Record<string, unknown>;
    } catch {
      diag('malformed_line', 'ignored a line that is not a reporter event');
      continue;
    }
    switch (e['type']) {
      case 'start':
        protocol = str(e['protocolVersion'])?.slice(0, 32);
        break;
      case 'suite': {
        const s = e['suite'] as Record<string, unknown> | undefined;
        const id = num(s?.['id']);
        const p = str(s?.['path']);
        if (id !== undefined && p) suites.set(id, p);
        break;
      }
      case 'testStart': {
        const t = e['test'] as Record<string, unknown> | undefined;
        const id = num(t?.['id']);
        const name = str(t?.['name']);
        const suiteId = num(t?.['suiteID']);
        if (id !== undefined && name !== undefined && suiteId !== undefined)
          tests.set(id, { id, name, suiteId, start: num(e['time']) ?? 0, order: order++ });
        break;
      }
      case 'error': {
        const id = num(e['testID']);
        if (id === undefined) break;
        const msg = `${str(e['error']) ?? ''}\n${str(e['stackTrace']) ?? ''}`.trim();
        errors.set(id, [...(errors.get(id) ?? []), { text: msg, isFailure: e['isFailure'] === true }]);
        break;
      }
      case 'testDone': {
        const id = num(e['testID']);
        if (id === undefined) break;
        done.set(id, {
          result: str(e['result'])?.slice(0, 64) ?? '',
          skipped: e['skipped'] === true,
          hidden: e['hidden'] === true,
          time: num(e['time']) ?? 0,
        });
        break;
      }
      case 'done':
        finished = typeof e['success'] === 'boolean' ? e['success'] : null;
        break;
      default:
        break;
    }
  }
  const complete = finished === true || finished === false;
  if (!complete)
    diag(
      'runner_incomplete',
      finished === null ? 'the runner reported done.success == null' : 'the runner stopped without a done event',
    );

  const results: NormalizedResult[] = [];
  for (const t of [...tests.values()].sort((a, b) => a.order - b.order)) {
    const suitePath = suites.get(t.suiteId);
    const target = suitePath === undefined ? undefined : targetFor(suitePath, outputs.targets);
    if (!target) {
      diag('unmapped_suite', 'a reporter suite does not match any requested target');
      continue;
    }
    const d = done.get(t.id);
    const errs = errors.get(t.id) ?? [];
    const message = excerpt(errs.map((x) => x.text).join('\n---\n') || undefined);
    const loading = t.name.startsWith('loading ');
    const name = (loading ? `loading ${target.path}` : t.name).slice(0, 500) || '(unnamed)';
    const base = {
      targetId: target.id,
      name,
      ...(d ? { durationMs: Math.max(0, Math.round(d.time - t.start)) } : {}),
      ...(message ? { messageExcerpt: message } : {}),
    };
    if (!d) {
      results.push(
        outputs.interrupted
          ? { ...base, outcome: 'cancelled', rawStatus: 'running' }
          : { ...base, outcome: 'infra_error', rawStatus: 'no_testDone' },
      );
      continue;
    }
    if (d.hidden && d.result === 'success' && errs.length === 0) continue;
    if (loading && (d.result !== 'success' || errs.length > 0)) {
      results.push(
        PUB_GET.test(message ?? '')
          ? { ...base, outcome: 'blocked', blockedReason: 'prerequisite_missing:pub_get', rawStatus: d.result }
          : { ...base, outcome: 'failed', failureKind: 'load_error', rawStatus: d.result },
      );
      continue;
    }
    if (d.skipped) {
      results.push({ ...base, outcome: 'skipped', rawStatus: 'skipped' });
      continue;
    }
    if (d.result === 'error' && errs.length === 0 && outputs.interrupted) {
      // RL-034: SIGTERM ends the running test as `error` with no error event.
      results.push({ ...base, outcome: 'cancelled', rawStatus: 'error' });
      continue;
    }
    if (d.result === 'success' && errs.length > 0) {
      // An error after testDone upgrades the test to failed (reporter protocol).
      results.push({
        ...base,
        outcome: 'failed',
        failureKind: errs.some((x) => x.isFailure) ? 'assertion' : 'exception',
        rawStatus: 'success+error',
      });
      continue;
    }
    const mapped = mapRunnerState(d.result, STATES, diagnostics);
    results.push({
      ...base,
      outcome: mapped.outcome,
      ...(mapped.failureKind ? { failureKind: mapped.failureKind } : {}),
      rawStatus: d.result || 'unknown',
    });
  }
  return { results, complete, ...(protocol ? { protocol } : {}) };
}

export function parseFlutterResults(outputs: RunnerOutputs): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const seen = new Set<string>();
  const diag = (code: string, message: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    diagnostics.push({ code, message });
  };
  const files = runnerFiles(outputs);
  const results: NormalizedResult[] = [];
  let protocol: string | undefined;
  let incomplete = files.length === 0;
  if (files.length === 0) diag('runner_output_missing', 'no reporter output was produced');
  for (const key of files) {
    const text = outputs.files[key];
    if (text === undefined) {
      diag('runner_output_missing', 'a reporter output file is missing');
      incomplete = true;
      continue;
    }
    const parsed = parseFile(text, outputs, diagnostics, diag);
    results.push(...parsed.results);
    protocol ??= parsed.protocol;
    if (!parsed.complete) incomplete = true;
  }
  if (incomplete) {
    // Targets with no result at all did not finish: they never count as passed or not_run.
    const withResults = new Set(results.map((r) => r.targetId));
    for (const t of outputs.targets)
      if (!withResults.has(t.id) && t.requires.device === 'none')
        results.push(
          outputs.interrupted
            ? { targetId: t.id, name: '(target)', outcome: 'cancelled', rawStatus: 'interrupted' }
            : { targetId: t.id, name: '(target)', outcome: 'infra_error', rawStatus: 'runner_incomplete' },
        );
  }
  return {
    results,
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    protocol: `dart-json-reporter@${protocol ?? 'unknown'}`,
  };
}
