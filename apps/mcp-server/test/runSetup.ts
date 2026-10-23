/**
 * Run test harness (RUN-001 – RUN-006): a Flutter-shaped workspace, a fake `flutter` executable and plan helpers.
 *
 * The fake `flutter` is a Node script that speaks the Dart JSON reporter protocol. Each test file declares its
 * behavior in a `// fake: <mode>` line:
 * - `pass`, `fail`, `error`, `skip`: one test with that outcome;
 * - `flaky`: fails on the first attempt of a run and passes after (marker file in the run's TMPDIR);
 * - `slow`: runs for 60 s; `ignore-term`: ignores SIGTERM and runs for 60 s;
 * - `load_error`: the file fails to load; `many N`: N passing tests;
 * - `noisy`: passes and prints secret-looking values to stdout and stderr; `binary`: writes NUL bytes into the
 *   reporter file (the run's runner output must be quarantined).
 * A run with no `done` event can be forced with `// fake: crash` (the runner exits mid-stream).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeServer } from '@autotest/mcp-server';

export const HOST_ENV = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'test-host' };
const quiet = { write: () => true };
export const sc = <T>(r: { structuredContent: Record<string, unknown> }) => r.structuredContent as T;

const FAKE_FLUTTER = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const rep = args[args.indexOf('--file-reporter') + 1].slice('json:'.length);
const files = args.filter((a) => a.endsWith('_test.dart'));
const out = fs.openSync(rep, 'a');
const ev = (e) => fs.writeSync(out, JSON.stringify({ ...e, time: Date.now() % 100000 }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  ev({ protocolVersion: '0.1.1', runnerVersion: null, pid: process.pid, type: 'start' });
  let id = 0;
  let failed = false;
  for (const [s, f] of files.entries()) {
    const abs = path.resolve(f);
    const mode = (/\\/\\/ fake: (.+)/.exec(fs.readFileSync(abs, 'utf8')) || [, 'pass'])[1].trim();
    ev({ suite: { id: s, platform: 'vm', path: abs }, type: 'suite' });
    const load = ++id;
    ev({ test: { id: load, name: 'loading ' + abs, suiteID: s, groupIDs: [] }, type: 'testStart' });
    if (mode === 'load_error') {
      ev({ testID: load, error: 'Failed to load: Compilation failed: x.dart:1:1: Error: nope', stackTrace: '', isFailure: false, type: 'error' });
      ev({ testID: load, result: 'error', skipped: false, hidden: false, type: 'testDone' });
      failed = true;
      continue;
    }
    ev({ testID: load, result: 'success', skipped: false, hidden: true, type: 'testDone' });
    const count = mode.startsWith('many ') ? Number(mode.slice(5)) : 1;
    for (let i = 0; i < count; i++) {
      const t = ++id;
      ev({ test: { id: t, name: count > 1 ? 'case ' + i : mode + ' test', suiteID: s, groupIDs: [] }, type: 'testStart' });
      if (mode === 'crash') process.exit(3);
      if (mode === 'noisy') {
        console.log('stdout token=ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
        console.error('stderr password: "hunter2-very-secret"');
      }
      if (mode === 'binary') fs.writeSync(out, Buffer.from([0, 1, 2, 0xff, 0, 10]));
      if (mode === 'slow' || mode === 'ignore-term') {
        if (mode === 'ignore-term') process.on('SIGTERM', () => {});
        await sleep(60000);
      }
      let result = 'success';
      let skipped = false;
      if (mode === 'fail') result = 'failure';
      if (mode === 'error') result = 'error';
      if (mode === 'skip') skipped = true;
      if (mode === 'flaky') {
        const marker = path.join(process.env.TMPDIR || '/tmp', 'fake_flaky_marker');
        if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); result = 'failure'; }
      }
      if (result !== 'success') {
        failed = true;
        ev({ testID: t, error: result === 'failure' ? 'Expected: <3>\\n  Actual: <2>' : 'Bad state: boom', stackTrace: 'trace', isFailure: result === 'failure', type: 'error' });
      }
      ev({ testID: t, result, skipped, hidden: false, type: 'testDone' });
    }
  }
  ev({ success: !failed, type: 'done' });
  process.exit(failed ? 1 : 0);
})();
`;

export interface RunFixture {
  readonly base: string;
  readonly ws: string;
  readonly data: string;
}

/** Workspace files: path → fake mode. `.dart_tool/package_config.json` is written unless `resolved` is false. */
export function setupRunData(
  tests: Record<string, string>,
  opts: { readonly extraConfig?: string; readonly resolved?: boolean } = {},
): RunFixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-run-')));
  const ws = path.join(base, 'ws');
  const files: Record<string, string> = {
    'pubspec.yaml':
      'name: app\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
    'lib/main.dart': 'void main() {}\n',
    ...(opts.resolved === false ? {} : { '.dart_tool/package_config.json': '{}' }),
  };
  for (const [p, mode] of Object.entries(tests)) files[p] = `// fake: ${mode}\nvoid main() {}\n`;
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  fs.writeFileSync(path.join(base, 'flutter'), FAKE_FLUTTER, { mode: 0o755 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${path.join(base, 'flutter')} } }\nexecution: { cancelGraceMs: 1000 }\n${opts.extraConfig ?? ''}`,
  );
  return { base, ws, data };
}

export const composeRuns = (data: string, opts: { background?: boolean } = {}) =>
  composeServer({ dataRoot: data, env: HOST_ENV, stderr: quiet, ...opts });

type Composed = Awaited<ReturnType<typeof composeRuns>>;

/** Requirements with one AC per test file; every case is an existing, eligible test. */
export async function runnablePlan(
  c: Composed,
  testPaths: readonly string[],
  opts: { readonly weak?: boolean } = {},
): Promise<{ planId: string; planHash: string; decision: string }> {
  const body = `## Acceptance criteria\n${testPaths.map((p) => `- [ ] Behavior of ${p} shows "ok"`).join('\n')}\n`;
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', { workspace: 'ws_app', source: 'manual', manual: { title: 'Change', body } }),
  ).prContextId;
  const profile = sc<{ projectProfileId: string }>(
    await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
  ).projectProfileId;
  const inv = sc<{ inventoryId: string }>(await c.call('inspect_test_inventory', { projectProfileId: profile }));
  const rqs = sc<{ requirementSetId: string }>(await c.call('extract_requirements', { prContextId: prc }));
  const testCases = testPaths.map((p, i) => ({
    clientKey: `k${i}`,
    title: `Case ${p}`,
    requirementRefs: ['REQ-001'],
    acRefs: [`REQ-001.AC-${String(i + 1).padStart(2, '0')}`],
    level: 'unit',
    technique: i === 0 ? 'regression' : 'positive',
    priority: 'must',
    platforms: ['host'],
    steps: [`Run ${p}`],
    expectedResults: [opts.weak && i === 0 ? 'It works properly' : `Text 'ok' is visible`],
    targetPath: p,
    automation: 'existing_test',
  }));
  const plan = sc<{ planId: string; planHash: string }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs.requirementSetId,
      inventoryId: inv.inventoryId,
      platformsInScope: ['host'],
      draft: { testCases },
    }),
  );
  const d = sc<{ decision: string }>(
    await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }),
  );
  return { ...plan, decision: d.decision };
}

/** Polls `get_run_status` until the run is terminal (or `timeoutMs` passes). */
export async function waitTerminal(c: Composed, runId: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = sc<{ state: string; statusCategory: string; cancelReason: string | null; infraReason: string | null }>(
      await c.call('get_run_status', { runId }),
    );
    if (['completed', 'cancelled', 'timed_out', 'infra_error'].includes(s.state)) return s;
    if (Date.now() > end) throw new Error(`run ${runId} still ${s.state} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Waits until the run's supervisor has started a runner process. */
export async function waitRunning(c: Composed, runId: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = sc<{ state: string }>(await c.call('get_run_status', { runId }));
    if (s.state === 'running') return;
    if (Date.now() > end) throw new Error(`run ${runId} never reached running (${s.state})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function allResults(c: Composed, runId: string, limit = 200) {
  const out: {
    name: string;
    outcome: string;
    flaky: boolean;
    attemptNo: number;
    failureKind: string | null;
    resultId: string;
    testCaseIds: string[];
  }[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = sc<{ results: typeof out; nextCursor: string | null; snapshotFinal: boolean }>(
      await c.call('get_run_results', { runId, limit, ...(cursor ? { cursor } : {}) }),
    );
    out.push(...page.results);
    if (!page.nextCursor) return out;
    cursor = page.nextCursor;
  }
}
