/**
 * Retention (EVD-003; data model §Retention; ADR-0008). A plan is computed first and then applied, so a dry run
 * lists exactly what a real run deletes. Runs that are not terminal are never touched. Rules:
 * - run artifacts (attempt outputs, artifacts, quarantine, reports) of terminal runs older than
 *   `runArtifactsDays` (by end time) are removed;
 * - quarantined files older than `quarantineDays` are removed earlier;
 * - when the data root still exceeds `totalCapBytes`, the oldest terminal runs' artifacts are removed first.
 * The run header, event log and terminal record stay (they are small and back the run rows and the audit trail).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RetentionRun {
  readonly runId: string;
  readonly terminal: boolean;
  readonly endedAt?: string;
  /** Bytes in the removable parts of the run directory. */
  readonly bytes: number;
  /** Bytes in `quarantine/`. */
  readonly quarantineBytes: number;
}

export interface RetentionSettings {
  readonly runArtifactsDays: number;
  readonly quarantineDays: number;
  readonly totalCapBytes: number;
}

export interface RetentionAction {
  readonly runId: string;
  readonly scope: 'run_artifacts' | 'quarantine';
  readonly reason: 'age' | 'cap';
  readonly bytes: number;
}

const REMOVABLE = ['attempts', 'artifacts', 'quarantine', 'reports'] as const;
const DAY = 86_400_000;

export function planRetention(runs: readonly RetentionRun[], now: Date, s: RetentionSettings): RetentionAction[] {
  const actions: RetentionAction[] = [];
  const terminal = runs
    .filter((r) => r.terminal && r.endedAt)
    .sort((a, b) => (a.endedAt! < b.endedAt! ? -1 : a.endedAt! > b.endedAt! ? 1 : a.runId < b.runId ? -1 : 1));
  const removed = new Set<string>();
  for (const r of terminal) {
    const age = now.getTime() - Date.parse(r.endedAt!);
    if (age > s.runArtifactsDays * DAY && r.bytes > 0) {
      actions.push({ runId: r.runId, scope: 'run_artifacts', reason: 'age', bytes: r.bytes });
      removed.add(r.runId);
    } else if (age > s.quarantineDays * DAY && r.quarantineBytes > 0)
      actions.push({ runId: r.runId, scope: 'quarantine', reason: 'age', bytes: r.quarantineBytes });
  }
  let total = runs.reduce((n, r) => n + r.bytes, 0) - actions.reduce((n, a) => n + a.bytes, 0);
  for (const r of terminal) {
    if (total <= s.totalCapBytes) break;
    if (removed.has(r.runId) || r.bytes === 0) continue;
    const already = actions.find((a) => a.runId === r.runId && a.scope === 'quarantine');
    const bytes = r.bytes - (already ? already.bytes : 0);
    actions.push({ runId: r.runId, scope: 'run_artifacts', reason: 'cap', bytes });
    removed.add(r.runId);
    total -= bytes;
  }
  return actions;
}

function dirBytes(dir: string): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += fs.lstatSync(p).size;
  }
  return n;
}

/** Measures the removable parts of a run directory. */
export function measureRun(runDir: string): { bytes: number; quarantineBytes: number } {
  return {
    bytes: REMOVABLE.reduce((n, d) => n + dirBytes(path.join(runDir, d)), 0),
    quarantineBytes: dirBytes(path.join(runDir, 'quarantine')),
  };
}

/** Applies a retention plan under `<dataRoot>/runs`. Returns the actions applied (equal to the plan). */
export function applyRetention(dataRoot: string, actions: readonly RetentionAction[]): RetentionAction[] {
  for (const a of actions) {
    if (!/^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(a.runId)) continue;
    const dir = path.join(dataRoot, 'runs', a.runId);
    const parts = a.scope === 'quarantine' ? ['quarantine'] : REMOVABLE;
    for (const p of parts) fs.rmSync(path.join(dir, p), { recursive: true, force: true });
  }
  return [...actions];
}
