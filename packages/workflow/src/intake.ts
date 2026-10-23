/**
 * PR intake normalization (PLN-001; TL-01; FR-001, FR-003; SR-006; T-01).
 *
 * Manual PR input is untrusted text. Before it is persisted: control characters other than newline and tab are
 * removed and counted, line endings are normalized, secrets are redacted with the policy ruleset (counts by class are
 * recorded as a limitation, never values), and changed-file paths are canonicalized as workspace-relative paths
 * (escaping or absolute paths are dropped and counted). The body is served in pages of {@link BODY_PAGE_CHARS}.
 */
import { normalizeRelPath, type ChangedFile, type Limitation } from '@autotest/core';
import { createRedactor } from '@autotest/policy';

export const BODY_PAGE_CHARS = 16_000;

export interface ManualPrInput {
  readonly title?: string | undefined;
  readonly body: string;
  readonly labels?: readonly string[] | undefined;
  readonly changedFiles?: readonly string[] | undefined;
}

export interface NormalizedPr {
  readonly title?: string;
  readonly body: string;
  readonly labels: string[];
  readonly changedFiles: ChangedFile[];
  readonly limitations: Limitation[];
}

/** Removes C0/C1 controls except `\n` and `\t`, normalizing CRLF/CR to LF. Returns the text and the removed count. */
export function stripControlCharacters(text: string): { text: string; removed: number } {
  const unified = text.replace(/\r\n?/g, '\n');
  let removed = 0;
  let out = '';
  for (const ch of unified) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f)) removed++;
    else out += ch;
  }
  return { text: out, removed };
}

export function normalizeManualPr(input: ManualPrInput, knownSecrets: readonly string[] = []): NormalizedPr {
  const limitations: Limitation[] = [];
  const redactor = createRedactor({ knownValues: knownSecrets });
  let controls = 0;
  const findings: Record<string, number> = {};
  const clean = (s: string) => {
    const stripped = stripControlCharacters(s);
    controls += stripped.removed;
    const r = redactor.redact(stripped.text);
    for (const [k, v] of Object.entries(r.findings)) findings[k] = (findings[k] ?? 0) + (v ?? 0);
    return r.text;
  };
  const title = input.title === undefined ? undefined : clean(input.title).trim();
  const body = clean(input.body);
  const labels = (input.labels ?? []).map((l) => clean(l).trim()).filter(Boolean);
  const changedFiles: ChangedFile[] = [];
  let rejected = 0;
  for (const p of input.changedFiles ?? []) {
    try {
      const path = normalizeRelPath(stripControlCharacters(p).text);
      if (!changedFiles.some((f) => f.path === path)) changedFiles.push({ path, status: 'changed' });
    } catch {
      rejected++;
    }
  }
  if (controls)
    limitations.push({ code: 'control_characters_removed', message: `${controls} control characters were removed` });
  const redacted = Object.entries(findings).sort(([a], [b]) => (a < b ? -1 : 1));
  if (redacted.length)
    limitations.push({ code: 'redacted', message: `redacted: ${redacted.map(([k, v]) => `${k}=${v}`).join(', ')}` });
  if (rejected)
    limitations.push({
      code: 'changed_files_rejected',
      message: `${rejected} changed-file paths were not workspace-relative and were dropped`,
    });
  if (!input.changedFiles)
    limitations.push({ code: 'diff_unavailable', message: 'Manual input without changed files' });
  return { ...(title ? { title } : {}), body, labels, changedFiles, limitations };
}

/** One page of the body starting at `offset`; `nextOffset` is null on the last page. */
export function pageBody(
  body: string,
  offset: number,
  size: number = BODY_PAGE_CHARS,
): { chunk: string; nextOffset: number | null } {
  const start = Math.min(Math.max(0, offset), body.length);
  const end = Math.min(body.length, start + size);
  return { chunk: body.slice(start, end), nextOffset: end < body.length ? end : null };
}
