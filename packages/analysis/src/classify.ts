/**
 * Failure classification, ruleset `anl-1` (ANL-001; observability §Failure classification; FR-032).
 *
 * Rules A1 – A10 are evaluated in order; the first match gives the primary class, the others become alternatives.
 * Patterns and confidence caps are data (`rules/anl-1.json`). Runner text can only *select* among the listed
 * signals; it never raises confidence above a rule's cap, and environment signals never override an assertion
 * failure (A3 requires "no assertion failure"), so a crafted log line cannot turn a test or product failure into
 * an environment failure (SEC-002). `product_defect` is `supported` only with every evidence criterion met, and
 * is never `confirmed` automatically.
 */
import type { FailureAnalysis, FailureClass, FailureKind, FailureSubtype, TestOutcome } from '@autotest/core';
import RULESET from '../rules/anl-1.json' with { type: 'json' };

export const RULESET_VERSION: string = RULESET.rulesetVersion;

export interface AnalysisSignal {
  /** Stable signal id from the adapter (e.g. `flutter.pub_get_required`). */
  readonly signal: string;
}

export interface AnalysisInput {
  readonly outcome: TestOutcome;
  readonly failureKind?: FailureKind;
  readonly blockedReason?: string;
  readonly flaky: boolean;
  /** This test's outcome on each attempt, in order. */
  readonly attempts: readonly TestOutcome[];
  /** Redacted, bounded runner text for the result (message excerpt; stderr excerpt). Untrusted. */
  readonly text: string;
  readonly signals: readonly AnalysisSignal[];
  /** The test case maps to an AC of a requirement in the current requirement set. */
  readonly mappedToRequirement: boolean;
  /** The test file itself changed in the PR (`changedFiles`). */
  readonly testFileChanged: boolean;
  readonly knownFailure?: { readonly id: string };
  readonly baseline: 'passed' | 'failed' | 'unknown';
  readonly artifactsQuarantined: boolean;
  /** Artifacts that back the observations (first one is cited). */
  readonly artifactIds: readonly string[];
}

export type Classification = Omit<FailureAnalysis, 'id' | 'runId' | 'resultId'>;

type Caps = typeof RULESET.caps;
const cap = (rule: keyof Caps) => RULESET.caps[rule];
const ENV_PATTERNS = RULESET.environmentPatterns.map((p) => ({ ...p, re: new RegExp(p.pattern) }));
const SETUP_PATTERNS = RULESET.setupPatterns.map((p) => ({ ...p, re: new RegExp(p.pattern) }));
const ENV_SIGNALS: Readonly<Record<string, { subtype: string; unambiguous: boolean }>> = RULESET.environmentSignals;

/** Results that get an analysis: failures, indeterminate outcomes, and passes that needed a retry. */
export function needsAnalysis(r: Pick<AnalysisInput, 'outcome' | 'flaky'>): boolean {
  return (
    r.outcome === 'failed' ||
    r.outcome === 'timed_out' ||
    r.outcome === 'infra_error' ||
    r.outcome === 'blocked' ||
    (r.outcome === 'passed' && r.flaky)
  );
}

interface Candidate {
  readonly rule: string;
  readonly class: FailureClass;
  readonly subtype: FailureSubtype;
  readonly strength: 'hypothesis' | 'supported';
  readonly confidence: number;
  readonly inference: string;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const firstLine = (s: string) =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';

export function classify(i: AnalysisInput): Classification {
  const text = i.text.slice(0, 64 * 1024);
  const envFromSignals = i.signals.flatMap((s) => {
    const e = ENV_SIGNALS[s.signal];
    return e ? [{ id: s.signal, subtype: e.subtype as FailureSubtype, unambiguous: e.unambiguous }] : [];
  });
  const envFromText = ENV_PATTERNS.filter((p) => p.re.test(text)).map((p) => ({
    id: p.id,
    subtype: p.subtype as FailureSubtype,
    unambiguous: p.unambiguous,
  }));
  const env = [...envFromSignals, ...envFromText];
  const setup = [
    ...i.signals.filter((s) => RULESET.setupSignals.includes(s.signal)).map((s) => s.signal),
    ...SETUP_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id),
  ];
  const failedAttempts = i.attempts.filter((o) => o === 'failed').length;
  const reproduced = failedAttempts >= 2;
  const assertion = i.failureKind === 'assertion';
  const testFailure =
    i.outcome === 'failed' &&
    (i.failureKind === 'assertion' || i.failureKind === 'exception' || i.failureKind === 'crash');

  const candidates: Candidate[] = [];
  const add = (c: Candidate) => {
    if (!candidates.some((x) => x.class === c.class && x.subtype === c.subtype)) candidates.push(c);
  };
  if (i.knownFailure)
    add({
      rule: 'A1',
      class: 'pre_existing',
      subtype: 'known_failure',
      strength: 'supported',
      confidence: cap('A1'),
      inference: `The failure matches known-failure entry ${i.knownFailure.id}.`,
    });
  if (i.baseline === 'failed' && i.outcome === 'failed')
    add({
      rule: 'A2',
      class: 'pre_existing',
      subtype: 'baseline_failure',
      strength: 'supported',
      confidence: cap('A2'),
      inference: 'The same test failed in a baseline run on the base ref.',
    });
  if (env.length > 0 && !assertion) {
    const subtypes = [...new Set(env.map((e) => e.subtype))];
    const unambiguous = subtypes.length === 1 && env.every((e) => e.unambiguous);
    add({
      rule: 'A3',
      class: 'environment_failure',
      subtype: subtypes[0]!,
      strength: unambiguous ? 'supported' : 'hypothesis',
      confidence: unambiguous ? cap('A3') : Math.min(cap('A3'), 0.6),
      inference: `Environment signals (${env.map((e) => e.id).join(', ')}) explain the result without an assertion failure.`,
    });
  }
  if (i.outcome === 'passed' && i.flaky)
    add({
      rule: 'A4',
      class: 'test_defect',
      subtype: 'flaky',
      strength: 'hypothesis',
      confidence: cap('A4'),
      inference: 'The test failed and then passed on a retry in the same run.',
    });
  if (i.failureKind === 'load_error' && i.testFileChanged)
    add({
      rule: 'A5',
      class: 'test_defect',
      subtype: 'setup',
      strength: 'hypothesis',
      confidence: cap('A5'),
      inference: 'The test file was changed in this PR and no longer loads.',
    });
  if (setup.length > 0 && i.outcome === 'failed')
    add({
      rule: 'A6',
      class: 'test_defect',
      subtype: 'setup',
      strength: 'hypothesis',
      confidence: cap('A6'),
      inference: `Setup-phase signals (${[...new Set(setup)].join(', ')}) point at the test's setup.`,
    });
  if (assertion && i.outcome === 'failed' && i.testFileChanged && !i.mappedToRequirement)
    add({
      rule: 'A7',
      class: 'test_defect',
      subtype: 'assertion',
      strength: 'hypothesis',
      confidence: cap('A7'),
      inference: 'The assertion failed in a test file changed by this PR that maps to no requirement of the PR.',
    });
  if (testFailure && i.mappedToRequirement && env.length === 0 && i.baseline !== 'failed') {
    const supported = reproduced && i.baseline === 'passed' && !i.artifactsQuarantined;
    add({
      rule: 'A8',
      class: 'product_defect',
      subtype: 'behavior',
      strength: supported ? 'supported' : 'hypothesis',
      confidence: supported ? cap('A8') : cap('A8h'),
      inference: `The test checks a requirement of this PR and failed${reproduced ? ` on ${failedAttempts} attempts` : ''} with no environment signal${supported ? ', while the baseline passed' : '; the baseline result is not known'}.`,
    });
  }
  if (testFailure)
    add({
      rule: 'A9',
      class: 'product_defect',
      subtype: 'behavior',
      strength: 'hypothesis',
      confidence: cap('A9'),
      inference: 'The test failed and no more specific rule explains it.',
    });
  if (
    candidates.length === 0 ||
    i.outcome === 'timed_out' ||
    i.outcome === 'infra_error' ||
    i.failureKind === 'load_error'
  )
    add({
      rule: 'A10',
      class: 'unknown',
      subtype: 'inconclusive',
      strength: 'hypothesis',
      confidence: cap('A10'),
      inference: 'The available signals do not explain the result.',
    });

  const primary = candidates[0]!;
  const alternatives = candidates
    .slice(1)
    .filter((c) => c.class !== primary.class || c.subtype !== primary.subtype)
    .map((c) => ({ class: c.class, subtype: c.subtype, confidence: Math.min(c.confidence, primary.confidence) }));
  if (primary.rule === 'A9' && !alternatives.some((a) => a.class === 'test_defect'))
    alternatives.unshift({ class: 'test_defect', subtype: 'assertion', confidence: 0.4 });
  if (primary.rule === 'A10' && i.failureKind === 'load_error')
    alternatives.push({ class: 'test_defect', subtype: 'setup', confidence: 0.3 });

  const cite = i.artifactIds[0];
  const observations = [
    {
      text: clip(
        `Outcome ${i.outcome}${i.failureKind ? ` (${i.failureKind})` : ''}${i.blockedReason ? ` (${i.blockedReason})` : ''}; attempts: ${i.attempts.join(', ') || 'none'}.`,
        500,
      ),
      ...(cite ? { artifactRef: cite } : {}),
    },
    ...(firstLine(text)
      ? [{ text: clip(`Runner output (untrusted): ${firstLine(text)}`, 500), ...(cite ? { artifactRef: cite } : {}) }]
      : []),
    ...env.slice(0, 3).map((e) => ({ text: `Environment signal ${e.id} (${e.subtype}).` })),
    ...[...new Set(setup)].slice(0, 2).map((s) => ({ text: `Setup signal ${s}.` })),
    ...(i.artifactsQuarantined ? [{ text: 'Some artifacts of this result were quarantined.' }] : []),
  ].slice(0, 10);

  return {
    class: primary.class,
    subtype: primary.subtype,
    strength: primary.strength,
    confidence: primary.confidence,
    observations,
    inference: clip(`Likely: ${primary.inference}`, 1000),
    alternatives: alternatives.slice(0, 4),
    ruleIds: [primary.rule],
    nextSteps: NEXT_STEPS[primary.class],
  };
}

const NEXT_STEPS: Readonly<Record<FailureClass, string[]>> = {
  product_defect: [
    'Reproduce locally with the failing test',
    'Check the change against the acceptance criterion the test maps to',
  ],
  test_defect: ['Review the test setup and assertions', 'Run the test file alone to confirm'],
  environment_failure: ['Fix the environment (dependencies, SDK, device), then re-run', 'Run `autotest doctor`'],
  pre_existing: ['Compare with the base branch; track the known failure separately'],
  unknown: ['Inspect the collected evidence (collect_test_evidence)', 'Re-run the target to see whether it reproduces'],
};
