/**
 * B2 (1.4.0) with **real Flutter SDKs**: two SDKs registered as `flutter@<version>` (from ~/fvm/versions), and the
 * fixture's pubspec Dart constraint selects which one runs; the run's process.start event records that binary.
 * Skips unless both SDKs are installed (FVM 3.41.9 with Dart 3.11.5, and 3.47.1 with Dart 3.13.1).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServer } from '@autotest/mcp-server';
import { allResults, runnablePlan, sc, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SDK = (v: string) => path.join(os.homedir(), 'fvm', 'versions', v, 'bin', 'flutter');
const OLD = SDK('3.41.9');
const NEW = SDK('3.47.1');
const OK = fs.existsSync(OLD) && fs.existsSync(NEW);
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-host' };

/** The fixture with a Dart constraint, dependencies resolved by the SDK that should be selected. */
function fixture(constraint: string, resolveWith: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-sdks-')));
  const ws = path.join(base, 'ws');
  fs.cpSync(path.join(ROOT, 'fixtures/fixture-flutter'), ws, { recursive: true });
  fs.rmSync(path.join(ws, '.dart_tool'), { recursive: true, force: true });
  const pubspec = path.join(ws, 'pubspec.yaml');
  fs.writeFileSync(pubspec, fs.readFileSync(pubspec, 'utf8').replace('sdk: ">=3.5.0 <4.0.0"', `sdk: "${constraint}"`));
  execFileSync(resolveWith, ['pub', 'get', '--offline'], { cwd: ws, stdio: 'ignore', timeout: 240_000 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables:\n  "flutter@3.41.9": { path: ${fs.realpathSync(OLD)} }\n  "flutter@3.47.1": { path: ${fs.realpathSync(NEW)} }\n`,
  );
  return data;
}

async function run(data: string) {
  const c = await composeServer({ dataRoot: data, env: HOST, stderr: { write: () => true } });
  try {
    const plan = await runnablePlan(c, ['test/calculator_test.dart']);
    const runId = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    ).runId;
    expect(await waitTerminal(c, runId, 240_000)).toMatchObject({ state: 'completed' });
    const events = fs.readFileSync(path.join(data, 'runs', runId, 'events.ndjson'), 'utf8');
    return {
      outcomes: [...new Set((await allResults(c, runId)).map((r) => r.outcome))],
      ran: [...events.matchAll(/"executable":"([^"]+)"/g)].map((m) => m[1]),
    };
  } finally {
    await c.close();
  }
}

describe.skipIf(!OK)('B2 two real Flutter SDKs selected by the pubspec Dart constraint', () => {
  it('runs the SDK whose Dart satisfies the constraint', { timeout: 900_000 }, async () => {
    expect(await run(fixture('>=3.11.0 <3.12.0', OLD))).toEqual({ outcomes: ['passed'], ran: [fs.realpathSync(OLD)] });
    expect(await run(fixture('^3.13.0', NEW))).toEqual({ outcomes: ['passed'], ran: [fs.realpathSync(NEW)] });
  });
});
