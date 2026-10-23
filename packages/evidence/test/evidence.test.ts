import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createIdGenerator } from '@autotest/core';
import {
  applyRetention,
  ingestArtifacts,
  measureRun,
  planRetention,
  readExcerpt,
  type IngestCandidate,
} from '@autotest/evidence';
import { createRedactor } from '@autotest/policy';

const CANARY = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function runDir(files: Record<string, string | Buffer>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-evd-')));
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}
const ids = createIdGenerator();
const opts = (dir: string, maxBytes?: number) => ({
  runDir: dir,
  runId: 'run_01JC000000000000000000000A',
  newId: () => ids.newId('art'),
  redactor: createRedactor(),
  ...(maxBytes ? { maxBytes } : {}),
});
const cand = (rel: string, kind: IngestCandidate['kind'] = 'stdout', required = true): IngestCandidate => ({
  kind,
  rel,
  mimeType: 'text/plain',
  required,
  attemptNo: 1,
  producer: 'supervisor',
});

describe('EVD-001 ingestion', () => {
  it('redacts a canary secret, records sha256 and provenance, and serves excerpts of the redacted copy', () => {
    const dir = runDir({ 'attempts/1/stdout-0.log': `token=${CANARY}\nok\n` });
    const { artifacts, missing } = ingestArtifacts([cand('attempts/1/stdout-0.log')], opts(dir));
    expect(missing).toEqual([]);
    const [a] = artifacts;
    expect(a).toMatchObject({
      quarantined: false,
      truncated: false,
      redaction: { applied: true, rulesetVersion: 'redact-1' },
    });
    expect(a!.redaction.findingsCount).toBeGreaterThan(0);
    expect(a!.relativePath).toMatch(/^artifacts\/art_/);
    const stored = fs.readFileSync(path.join(dir, a!.relativePath), 'utf8');
    expect(stored).not.toContain(CANARY);
    expect(fs.statSync(path.join(dir, a!.relativePath)).mode & 0o777).toBe(0o600);
    expect(readExcerpt(dir, a!, 4096)).toBe(stored);
    expect(a!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects symlinks, paths outside attempts/, and binary disguised as text', () => {
    const dir = runDir({ 'secret.txt': CANARY, 'attempts/1/runner/x.jsonl': Buffer.from([0x7b, 0, 1, 2, 0xff]) });
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'attempts/1/stdout-0.log'));
    const { artifacts } = ingestArtifacts(
      [
        cand('attempts/1/stdout-0.log'),
        cand('../secret.txt'),
        cand('secret.txt'),
        cand('attempts/1/runner/x.jsonl', 'runner_json'),
      ],
      opts(dir),
    );
    expect(artifacts.map((a) => [a.quarantined, a.quarantineReason])).toEqual([
      [true, 'symlink'],
      [true, 'path_outside_run'],
      [true, 'path_outside_run'],
      [true, 'binary_as_text'],
    ]);
    expect(fs.existsSync(path.join(dir, `quarantine/${artifacts[0]!.id}`))).toBe(false);
    expect(readExcerpt(dir, artifacts[3]!, 100)).toBeUndefined();
  });

  it('truncates oversized text, quarantines oversized and unknown binaries, accepts real PNGs, reports missing required files', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const dir = runDir({
      'attempts/1/stdout-0.log': 'x'.repeat(5000),
      'attempts/1/runner/shot.png': png,
      'attempts/1/runner/fake.png': Buffer.from('not an image'),
      'attempts/1/runner/big.png': Buffer.concat([png, Buffer.alloc(5000)]),
    });
    const { artifacts, missing } = ingestArtifacts(
      [
        cand('attempts/1/stdout-0.log'),
        cand('attempts/1/runner/shot.png', 'screenshot'),
        cand('attempts/1/runner/fake.png', 'screenshot'),
        cand('attempts/1/runner/big.png', 'screenshot'),
        cand('attempts/1/runner/flutter.jsonl', 'runner_json'),
        cand('attempts/1/runner/lcov.info', 'coverage', false),
      ],
      opts(dir, 1024),
    );
    expect(artifacts.map((a) => [a.kind, a.quarantined, a.quarantineReason ?? null, a.truncated])).toEqual([
      ['stdout', false, null, true],
      ['screenshot', false, null, false],
      ['screenshot', true, 'unsupported_type', false],
      ['screenshot', true, 'too_large', false],
    ]);
    expect(artifacts[0]!.sizeBytes).toBe(1024);
    expect(artifacts[1]).toMatchObject({ mimeType: 'image/png', redaction: { applied: false } });
    expect(missing).toEqual(['attempts/1/runner/flutter.jsonl']);
  });
});

describe('EVD-003 retention', () => {
  const s = { runArtifactsDays: 14, quarantineDays: 7, totalCapBytes: 1000 };
  const now = new Date('2026-10-23T00:00:00Z');
  const run = (runId: string, endedDaysAgo: number | undefined, bytes: number, quarantineBytes = 0) => ({
    runId,
    terminal: endedDaysAgo !== undefined,
    ...(endedDaysAgo === undefined
      ? {}
      : { endedAt: new Date(now.getTime() - endedDaysAgo * 86_400_000).toISOString() }),
    bytes,
    quarantineBytes,
  });

  it('never touches non-terminal runs; removes by age, then oldest first down to the cap', () => {
    const plan = planRetention(
      [
        run('r-active', undefined, 5000),
        run('r-old', 20, 100),
        run('r-q', 8, 300, 50),
        run('r-a', 3, 400),
        run('r-b', 1, 400),
      ],
      now,
      s,
    );
    expect(plan).toEqual([
      { runId: 'r-old', scope: 'run_artifacts', reason: 'age', bytes: 100 },
      { runId: 'r-q', scope: 'quarantine', reason: 'age', bytes: 50 },
      { runId: 'r-q', scope: 'run_artifacts', reason: 'cap', bytes: 250 },
      { runId: 'r-a', scope: 'run_artifacts', reason: 'cap', bytes: 400 },
      { runId: 'r-b', scope: 'run_artifacts', reason: 'cap', bytes: 400 },
    ]);
    expect(plan.some((a) => a.runId === 'r-active')).toBe(false);
  });

  it('applying the plan deletes exactly what the dry run listed, and keeps run records', () => {
    const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-ret-')));
    const id = 'run_01JC000000000000000000000A';
    const dir = path.join(data, 'runs', id);
    for (const f of ['attempts/1/stdout-0.log', 'artifacts/art_x', 'quarantine/q', 'run.json', 'events.ndjson']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'data');
    }
    const m = measureRun(dir);
    expect(m).toEqual({ bytes: 12, quarantineBytes: 4 });
    const plan = planRetention([{ runId: id, terminal: true, endedAt: '2026-01-01T00:00:00Z', ...m }], now, s);
    expect(applyRetention(data, plan)).toEqual(plan);
    expect(fs.readdirSync(dir).sort()).toEqual(['events.ndjson', 'run.json']);
  });
});
