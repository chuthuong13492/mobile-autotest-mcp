/**
 * 1.3.0 workspace run options with **real Flutter**: `workspaces[].run.flutter` in the user config reaches
 * `flutter test` as `--flavor` and `--dart-define`, through the whole MCP workflow. The fixture copy gets a test
 * that passes only when the define arrives; without the run options the same plan fails. Skips without Flutter.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeServer } from '@autotest/mcp-server';
import { allResults, runnablePlan, sc, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FLUTTER =
  process.env['AUTOTEST_E2E_FLUTTER'] ??
  spawnSync('/bin/sh', ['-c', 'command -v flutter'], { encoding: 'utf8' }).stdout.trim();
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-host' };
const DEFINE_TEST = `import 'package:flutter_test/flutter_test.dart';

void main() {
  test('AUTOTEST_ENV reaches the test', () {
    expect(const String.fromEnvironment('AUTOTEST_ENV'), 'staging');
  });
}
`;

function fixture(run: string) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-runopt-')));
  const ws = path.join(base, 'ws');
  fs.cpSync(path.join(ROOT, 'fixtures/fixture-flutter'), ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'test/define_test.dart'), DEFINE_TEST);
  execFileSync(fs.realpathSync(FLUTTER), ['pub', 'get', '--offline'], { cwd: ws, stdio: 'ignore', timeout: 240_000 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws}${run} }]\nexecutables: { flutter: { path: ${fs.realpathSync(FLUTTER)} } }\n`,
  );
  return data;
}

async function outcome(data: string) {
  const c = await composeServer({ dataRoot: data, env: HOST, stderr: { write: () => true } });
  try {
    const plan = await runnablePlan(c, ['test/define_test.dart']);
    const runId = sc<{ runId: string }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    ).runId;
    expect(await waitTerminal(c, runId, 240_000)).toMatchObject({ state: 'completed' });
    return (await allResults(c, runId)).map((r) => r.outcome);
  } finally {
    await c.close();
  }
}

const suite = FLUTTER ? describe : describe.skip;
suite('1.3.0 Flutter run options from the user config (real Flutter)', () => {
  it('passes --flavor and --dart-define to flutter test', { timeout: 600_000 }, async () => {
    const withOptions = fixture(', run: { flutter: { flavor: staging, dartDefines: { AUTOTEST_ENV: staging } } }');
    expect(await outcome(withOptions)).toEqual(['passed']);
    const runDir = fs.readdirSync(path.join(withOptions, 'runs'))[0]!;
    const spec = fs.readFileSync(path.join(withOptions, 'runs', runDir, 'run.json'), 'utf8');
    expect(spec).toContain('"name":"--flavor","value":"staging"');
    expect(spec).toContain('"value":"AUTOTEST_ENV=staging"');
    // The same plan without the run options fails: the define is what makes it pass.
    expect(await outcome(fixture(''))).toEqual(['failed']);
  });
});
