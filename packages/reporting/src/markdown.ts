/**
 * Markdown rendering (RPT-002; FR-035; SR-006). Every repository- or runner-derived string (test names, messages,
 * titles, the agent narrative) is escaped: Markdown punctuation is backslash-escaped, `<`/`>`/`&` become entities
 * (no raw HTML), control characters are removed and line breaks are flattened inside table cells. Analyses are
 * worded as "likely"/"possible", never as facts. The comment variant is capped (GitHub allows 65,536 characters).
 */
import type { ReportModel } from './model.ts';

export const COMMENT_MAX_CHARS = 60_000;

/** C0 controls except tab, line feed and carriage return, plus DEL. */
function isControl(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f;
}

/** Escapes untrusted text for inline Markdown (and table cells when `cell`). */
export function md(text: string, cell = false): string {
  let t = [...text].filter((ch) => !isControl(ch)).join('');
  t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  t = t.replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1');
  if (cell) t = t.replace(/\r?\n/g, ' ');
  return t;
}

const VERDICT_LABEL: Record<ReportModel['verdict'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  inconclusive: 'INCONCLUSIVE',
  blocked: 'BLOCKED',
};

const pct = (m: { numerator: number; denominator: number } | null) =>
  m === null
    ? 'n/a'
    : m.denominator === 0
      ? 'n/a'
      : `${Math.round((m.numerator / m.denominator) * 1000) / 10}% (${m.numerator}/${m.denominator})`;

export function renderMarkdown(m: ReportModel, opts: { readonly maxChars?: number } = {}): string {
  const out: string[] = [];
  out.push(`# AutoTest report: ${VERDICT_LABEL[m.verdict]}`, '');
  out.push(
    `Verdict rule ${m.verdictRule}. Plan \`${m.summary.planId}\` v${m.summary.planVersion} (\`${m.summary.planHash}\`). Coverage gate: **${m.summary.gateDecision}** (\`${m.summary.coverageDecisionId}\`).`,
    '',
  );
  out.push(
    `Planned ${m.plannedVsExecuted.planned}, executed ${m.plannedVsExecuted.executed}, not run ${m.plannedVsExecuted.notRun}, blocked ${m.plannedVsExecuted.blocked}.`,
    '',
  );
  if (m.summary.runs.length)
    out.push(
      `Runs: ${m.summary.runs.map((r) => `\`${r.id}\` ${r.state}${r.partial ? ' (partial)' : ''}`).join(', ')}.`,
      '',
    );

  out.push('## Traceability', '', '| Requirement | Risk | Test case | Outcome |', '|---|---|---|---|');
  for (const req of m.traceability) {
    const rows = req.cases.length ? req.cases : [{ testCaseId: '—', outcome: 'not_run' as const }];
    for (const c of rows)
      out.push(`| ${req.requirementId} ${md(req.title, true)} | ${req.riskTier} | ${c.testCaseId} | ${c.outcome} |`);
  }
  out.push('');

  out.push('## Test cases', '', '| Case | Title | Mandatory | Outcome |', '|---|---|---|---|');
  for (const c of m.cases)
    out.push(
      `| ${c.testCaseId} | ${md(c.title, true)} | ${c.mandatory ? 'yes' : 'no'} | ${c.outcome}${c.flaky ? ' (flaky)' : ''} |`,
    );
  out.push('');

  if (m.failures.length) {
    out.push('## Failures', '');
    for (const f of m.failures) {
      out.push(`### ${md(f.name)} (${f.outcome})`, '');
      out.push(`Cases: ${f.testCaseIds.join(', ') || 'none'}. Result \`${f.resultId}\`.`, '');
      if (f.analysis)
        out.push(
          `Analysis (${f.analysis.strength}, confidence ${f.analysis.confidence}): ${f.analysis.strength === 'supported' ? 'likely' : 'possibly'} **${f.analysis.class}/${f.analysis.subtype}**. ${md(f.analysis.inference)}`,
          '',
        );
      if (f.messageExcerpt)
        out.push(
          'Runner output (untrusted, redacted):',
          '',
          '```text',
          f.messageExcerpt.replace(/```/g, "'''").slice(0, 1500),
          '```',
          '',
        );
    }
  }

  out.push('## Coverage metrics', '');
  for (const [k, v] of Object.entries(m.metrics)) out.push(`- ${k}: ${pct(v)}`);
  out.push('');
  if (m.attention.length) {
    out.push('## Attention', '');
    for (const a of m.attention) out.push(`- ${md(a)}`);
    out.push('');
  }
  if (m.limitations.length) {
    out.push('## Limitations', '');
    for (const l of m.limitations) out.push(`- \`${l.code}\`: ${md(l.message)}`);
    out.push('');
  }
  if (m.narrative) {
    out.push('## Agent narrative (untrusted)', '');
    for (const line of m.narrative.split(/\r?\n/)) out.push(`> ${md(line)}`);
    out.push('');
  }
  const text = out.join('\n');
  const max = opts.maxChars ?? Number.POSITIVE_INFINITY;
  if (text.length <= max) return text;
  const note = '\n\n_Report truncated; the full report is in the report artifacts._\n';
  return text.slice(0, Math.max(0, max - note.length)) + note;
}
