/**
 * LCOV parsing and changed-file intersection (FL-005; coverage metric 3, source coverage of changed files).
 * Pure and bounded: at most 20,000 records are read and malformed lines are ignored, never thrown on.
 */

/** Line coverage of one source file. */
export interface LcovFileCoverage {
  readonly path: string;
  readonly linesFound: number;
  readonly linesHit: number;
}

/** Coverage of the changed source files that appear in an LCOV report. */
export interface ChangedFileCoverage {
  /** Lines hit across the changed files that the report covers. */
  readonly linesHit: number;
  /** Instrumented lines across those files; 0 when none of the changed files is in the report. */
  readonly linesFound: number;
  /** `linesHit / linesFound`, or `null` when `linesFound` is 0 (no denominator, never reported as 0 %). */
  readonly ratio: number | null;
  readonly files: readonly LcovFileCoverage[];
  /** Changed source files that the report does not mention (untested or not loaded by any test). */
  readonly missing: readonly string[];
}

const MAX_RECORDS = 20_000;

/** Parses LCOV text into per-file line counts. `SF:` paths are kept as written (absolute or relative). */
export function parseLcov(text: string): LcovFileCoverage[] {
  const files: LcovFileCoverage[] = [];
  let current: { path: string; found: number; hit: number; lines: Map<number, number> } | undefined;
  for (const raw of text.split('\n')) {
    if (files.length >= MAX_RECORDS) break;
    const line = raw.trim();
    if (line.startsWith('SF:')) current = { path: line.slice(3), found: -1, hit: -1, lines: new Map() };
    else if (!current) continue;
    else if (line.startsWith('DA:')) {
      const m = /^DA:(\d+),(\d+)/.exec(line);
      if (m) current.lines.set(Number(m[1]), Math.max(current.lines.get(Number(m[1])) ?? 0, Number(m[2])));
    } else if (line.startsWith('LF:')) current.found = Number(line.slice(3)) || 0;
    else if (line.startsWith('LH:')) current.hit = Number(line.slice(3)) || 0;
    else if (line === 'end_of_record') {
      const fromLines = { found: current.lines.size, hit: [...current.lines.values()].filter((n) => n > 0).length };
      files.push({
        path: current.path,
        linesFound: current.lines.size > 0 ? fromLines.found : Math.max(current.found, 0),
        linesHit: current.lines.size > 0 ? fromLines.hit : Math.max(current.hit, 0),
      });
      current = undefined;
    }
  }
  return files;
}

/**
 * Intersects a report with the workspace-relative changed files. A report path matches a changed file when it is
 * equal to it or ends with `/<changed file>` (reports may carry absolute paths).
 */
export function changedFileCoverage(
  report: readonly LcovFileCoverage[],
  changedFiles: readonly string[],
): ChangedFileCoverage {
  const files: LcovFileCoverage[] = [];
  const missing: string[] = [];
  for (const changed of [...new Set(changedFiles)].sort()) {
    const hit = report.find((f) => f.path === changed || f.path.endsWith(`/${changed}`));
    if (hit) files.push({ ...hit, path: changed });
    else missing.push(changed);
  }
  const linesFound = files.reduce((n, f) => n + f.linesFound, 0);
  const linesHit = files.reduce((n, f) => n + f.linesHit, 0);
  return { linesHit, linesFound, ratio: linesFound === 0 ? null : linesHit / linesFound, files, missing };
}
