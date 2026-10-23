/**
 * Review triggers GR-01 – GR-10 and info findings (COV-001; test-planning §Review triggers). GR-01 and GR-07 are
 * locked; the others follow the `coverageGate` config. GR-10 is info unless `promote` is set. Info findings never
 * affect the decision.
 */
import {
  isMandatory,
  normalizeText,
  type ChangedFile,
  type CoverageMetrics,
  type RequirementSet,
  type TestPlan,
  type TestTarget,
} from '@autotest/core';
import type { Finding, GateConfig } from '../types.ts';

const R2PLUS = new Set(['R2', 'R3']);
const review = (ruleId: string, message: string, refs: readonly string[]): Finding => ({
  ruleId,
  severity: 'review',
  message: message.slice(0, 500),
  refs: [...refs].slice(0, 20),
});
const info = (ruleId: string, message: string, refs: readonly string[] = []): Finding => ({
  ruleId,
  severity: 'info',
  message: message.slice(0, 500),
  refs: [...refs].slice(0, 20),
});

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lexicon = (terms: readonly string[]) =>
  terms.length
    ? new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.map(escape).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu')
    : undefined;

/** GR-02 observable: a quoted value, a number, a named UI element (CamelCase identifier) or an observable verb. */
export function hasObservable(text: string, verbs: readonly string[]): boolean {
  if (/["'“”‘’][^"'“”‘’]+["'“”‘’]/.test(text) || /\d/.test(text) || /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/.test(text))
    return true;
  return lexicon(verbs)?.test(text) ?? false;
}

export interface ReviewContext {
  readonly plan: TestPlan;
  readonly set: RequirementSet;
  readonly config: GateConfig;
  readonly metrics: CoverageMetrics;
  readonly targets: readonly TestTarget[];
  readonly changedFiles?: readonly ChangedFile[];
  readonly excepted: (requirementId: string) => boolean;
}

export function reviewFindings(ctx: ReviewContext): Finding[] {
  const { plan, set, config } = ctx;
  const rules = config.rules;
  const out: Finding[] = [];
  const casesOf = (id: string) => plan.testCases.filter((c) => c.requirementRefs.includes(id));
  const tier = new Map(set.requirements.map((r) => [r.id, r.riskTier]));

  // GR-01 (locked): open, high-severity ambiguities.
  for (const a of set.ambiguities)
    if (a.status === 'open' && a.severity === 'high')
      out.push(review('GR-01', `${a.id} is an open high-severity ambiguity`, [a.id, ...a.relatedRefs]));

  // GR-02: weak assertions.
  if (rules['GR-02'].enabled) {
    const vague = lexicon(rules['GR-02'].vagueTerms);
    for (const c of plan.testCases) {
      const weak = c.expectedResults.some((e) => vague?.test(e) || !hasObservable(e, rules['GR-02'].observableVerbs));
      if (weak) out.push(review('GR-02', `${c.id} has an expected result that is vague or not observable`, [c.id]));
    }
  }

  // GR-03: duplicates (same target, same normalized steps and expected results).
  if (rules['GR-03'].enabled) {
    const seen = new Map<string, string>();
    for (const c of plan.testCases) {
      if (!c.targetRef) continue;
      const key = JSON.stringify([c.targetRef, c.steps.map(normalizeText), c.expectedResults.map(normalizeText)]);
      const first = seen.get(key);
      if (first) out.push(review('GR-03', `${c.id} duplicates ${first}`, [c.id, first]));
      else seen.set(key, c.id);
    }
  }

  // GR-04: thresholds (a metric with denominator 0 is not compared).
  const t = config.thresholds;
  const below = (name: string, m: CoverageMetrics[keyof CoverageMetrics], min: number) => {
    if (m && m.value !== null && m.value < min)
      out.push(review('GR-04', `${name} ${m.numerator}/${m.denominator} is below ${min}`, []));
  };
  below('requirementCoverage', ctx.metrics.requirementCoverage, t.requirementCoverageMin);
  below('testCaseCoverage', ctx.metrics.testCaseCoverage, t.testCaseCoverageMin);
  below('platformCoverage', ctx.metrics.platformCoverage, t.platformCoverageMin);
  below('regressionCoverage', ctx.metrics.regressionCoverage, t.regressionCoverageMin);

  // GR-05: R0/R1 requirements without an eligible case or exception.
  if (rules['GR-05'].enabled) {
    for (const r of set.requirements) {
      if (!r.testable || R2PLUS.has(r.riskTier)) continue;
      if (!casesOf(r.id).some((c) => c.eligibility === 'eligible') && !ctx.excepted(r.id))
        out.push(review('GR-05', `${r.id} (${r.riskTier}) has no eligible test case and no exception`, [r.id]));
    }
  }

  // GR-06: mandatory cases that are not automated yet.
  if (rules['GR-06'].enabled) {
    for (const c of plan.testCases)
      if (isMandatory(c) && c.automation !== 'existing_test')
        out.push(review('GR-06', `mandatory ${c.id} is ${c.automation}`, [c.id]));
  }

  // GR-07 (locked): any R3 requirement.
  for (const r of set.requirements)
    if (r.riskTier === 'R3') out.push(review('GR-07', `${r.id} is R3 and needs human review`, [r.id]));

  // GR-08: assumptions tied to R2/R3 requirements.
  if (rules['GR-08'].enabled) {
    for (const a of set.assumptions) {
      const highRefs = a.relatedRefs.filter((ref) => R2PLUS.has(tier.get(ref.split('.')[0]!) ?? 'R0'));
      if (highRefs.length)
        out.push(review('GR-08', `${a.id} is an assumption about R2/R3 requirements`, [a.id, ...highRefs]));
    }
  }

  // GR-09: regression scope — changed source directories with no selected test target nearby.
  const changedSources = (ctx.changedFiles ?? []).map((f) => f.path).filter((p) => /^(lib|src)\//.test(p));
  if (rules['GR-09'].enabled && ctx.changedFiles && changedSources.length) {
    const depth = rules['GR-09'].depth;
    const prefix = (p: string) =>
      p
        .split('/')
        .slice(1, 1 + depth)
        .join('/')
        .replace(/_test(\.\w+)?$|\.\w+$/, '');
    const selected = new Set(plan.testCases.flatMap((c) => (c.targetRef ? [c.targetRef] : [])));
    const targetPrefixes = new Set(ctx.targets.filter((tt) => selected.has(tt.id)).map((tt) => prefix(tt.path)));
    const uncovered = changedSources.filter((p) => !targetPrefixes.has(prefix(p)));
    if (uncovered.length === changedSources.length)
      out.push(
        review(
          'GR-09',
          `no selected test target shares a directory with the ${changedSources.length} changed source files`,
          [],
        ),
      );
  }

  // GR-10: UI change without an accessibility case.
  const uiChange =
    plan.testCases.some((c) => c.level === 'widget' || c.level === 'component' || c.level === 'e2e') ||
    (ctx.changedFiles ?? []).some((f) => /(^|\/)(widgets?|screens?|views?|ui|components?)\//.test(f.path));
  if (uiChange && !plan.testCases.some((c) => c.technique === 'accessibility')) {
    out.push(
      rules['GR-10'].promote
        ? review('GR-10', 'UI change without an accessibility test case', [])
        : info('GR-10', 'UI change without an accessibility test case'),
    );
  }

  // Info findings.
  if (!ctx.metrics.sourceCodeCoverage) out.push(info('INF-01', 'source-code coverage is unavailable'));
  if (!ctx.changedFiles) out.push(info('INF-02', 'changed files are unknown; GR-09 was not evaluated'));
  return out;
}
