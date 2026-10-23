/**
 * Evidence hints and failure signals for Flutter host runs (FL-005; platform-adapters §Flutter "Evidence" and
 * "Failure normalization signals"). Signals are candidates for the analysis rules (ANL-001), which decide the class
 * and cap the confidence; an adapter never classifies a failure on its own.
 */
import {
  excerpt,
  runnerOutput,
  type EvidenceHint,
  type FailureSignal,
  type NormalizedResult,
  type RunnerOutputs,
} from '@autotest/adapter-sdk';
import { LCOV_FILE, RESULTS_FILE } from './execution.ts';
import { runnerFiles } from './parse.ts';

export function flutterEvidenceHints(outputs: RunnerOutputs): EvidenceHint[] {
  const files = runnerFiles(outputs);
  const json = files.length > 0 ? files : [runnerOutput(outputs.attemptNo, RESULTS_FILE)];
  const hints: EvidenceHint[] = json.map((rel) => ({
    kind: 'runner_json',
    rel,
    mimeType: 'application/x-ndjson',
    required: true,
  }));
  const lcov = runnerOutput(outputs.attemptNo, LCOV_FILE);
  if (Object.hasOwn(outputs.files, lcov))
    hints.push({ kind: 'coverage', rel: lcov, mimeType: 'text/plain', required: false });
  return hints;
}

const PATTERNS: readonly {
  readonly re: RegExp;
  readonly signal: string;
  readonly indicates: FailureSignal['indicates'];
}[] = [
  {
    re: /MissingPluginException/,
    signal: 'flutter.missing_plugin',
    indicates: { class: 'environment_failure', subtype: 'dependency' },
  },
  {
    re: /Bad state: No element/,
    signal: 'flutter.no_element',
    indicates: { class: 'test_defect', subtype: 'assertion' },
  },
  {
    re: /TimeoutException|Test timed out/,
    signal: 'flutter.timeout',
    indicates: { class: 'unknown', subtype: 'inconclusive' },
  },
  {
    re: /Compilation failed|\.dart:\d+:\d+: Error:/,
    signal: 'flutter.compilation_error',
    indicates: { class: 'unknown', subtype: 'inconclusive' },
  },
];

export function flutterFailureSignals(results: readonly NormalizedResult[]): FailureSignal[] {
  const signals: FailureSignal[] = [];
  for (const r of results) {
    const text = r.messageExcerpt ?? r.rawStatus;
    const base = { targetId: r.targetId, resultName: r.name, evidence: excerpt(text, 200)! };
    if (r.outcome === 'blocked' && r.blockedReason === 'prerequisite_missing:pub_get') {
      signals.push({
        ...base,
        signal: 'flutter.pub_get_required',
        indicates: { class: 'environment_failure', subtype: 'dependency' },
      });
      continue;
    }
    if (r.outcome === 'infra_error') {
      signals.push({
        ...base,
        signal: 'flutter.runner_incomplete',
        indicates: { class: 'environment_failure', subtype: 'infrastructure' },
      });
      continue;
    }
    if (r.outcome !== 'failed') continue;
    const hit = PATTERNS.find((p) => p.re.test(text));
    if (hit) signals.push({ ...base, signal: hit.signal, indicates: hit.indicates });
    else if (r.failureKind === 'assertion')
      signals.push({
        ...base,
        signal: 'flutter.assertion',
        indicates: { class: 'product_defect', subtype: 'behavior' },
      });
    else
      signals.push({ ...base, signal: 'flutter.exception', indicates: { class: 'unknown', subtype: 'inconclusive' } });
  }
  return signals;
}
