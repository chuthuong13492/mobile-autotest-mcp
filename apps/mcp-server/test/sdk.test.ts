/**
 * B2 (1.4.0): several Flutter SDKs side by side. The workspace's pins select the SDK (`flutter@<label>`), the run uses
 * exactly that binary (process.start records it), an ambiguous or unmatched choice fails closed, and `flutterSdk`
 * binds one explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeRuns, runnablePlan, sc, setupRunData, waitTerminal } from './runSetup.ts';

function twoSdks(dartConstraint: string, bind?: string) {
  const f = setupRunData({ 'test/a_test.dart': 'pass' });
  const fake = fs.readFileSync(path.join(f.base, 'flutter'), 'utf8');
  const sdk = (label: string, flutter: string, dart: string) => {
    const dir = path.join(f.base, `sdk-${label}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'flutter'), fake, { mode: 0o755 });
    fs.writeFileSync(
      path.join(dir, 'version.json'),
      JSON.stringify({ frameworkVersion: flutter, dartSdkVersion: dart }),
    );
    return path.join(dir, 'flutter');
  };
  const old = sdk('old', '3.41.9', '3.11.5');
  const neu = sdk('new', '3.47.1', '3.13.1 (stable)');
  fs.writeFileSync(
    path.join(f.ws, 'pubspec.yaml'),
    `name: app\nenvironment:\n  sdk: "${dartConstraint}"\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n`,
  );
  fs.writeFileSync(
    path.join(f.data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${f.ws}${bind ? `, flutterSdk: "${bind}"` : ''} }]\nexecutables:\n  "flutter@3.41.9": { path: ${old} }\n  "flutter@3.47.1": { path: ${neu} }\nexecution: { cancelGraceMs: 1000 }\n`,
  );
  return { f, old, neu };
}

async function runWith(data: string) {
  const c = await composeRuns(data);
  try {
    const plan = await runnablePlan(c, ['test/a_test.dart']);
    const r = sc<{ runId?: string; error?: { code: string; message: string } }>(
      await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash }),
    );
    if (!r.runId) return { error: r.error };
    expect(await waitTerminal(c, r.runId, 60_000)).toMatchObject({ state: 'completed' });
    const events = fs.readFileSync(path.join(data, 'runs', r.runId, 'events.ndjson'), 'utf8');
    const header = JSON.parse(fs.readFileSync(path.join(data, 'runs', r.runId, 'run.json'), 'utf8'));
    return {
      executable: header.execution.executable as string,
      ran: [...events.matchAll(/"executable":"([^"]+)"/g)].map((m) => m[1]),
    };
  } finally {
    await c.close();
  }
}

describe('B2 Flutter SDK selection', () => {
  it(
    'selects the SDK whose Dart satisfies the pubspec constraint and runs that binary',
    { timeout: 120_000 },
    async () => {
      const { f, neu } = twoSdks('>=3.12.0 <4.0.0');
      const r = await runWith(f.data);
      expect(r).toMatchObject({ executable: 'flutter@3.47.1' });
      expect(r.ran).toEqual([fs.realpathSync(neu)]);
    },
  );

  it('fails closed when several or no SDKs match, and honours an explicit binding', { timeout: 120_000 }, async () => {
    const ambiguous = await runWith(twoSdks('>=3.5.0 <4.0.0').f.data);
    expect(ambiguous.error).toMatchObject({ code: 'E_PREREQUISITE_MISSING' });
    expect(ambiguous.error!.message).toMatch(/several configured Flutter SDKs match .*flutterSdk/);
    const none = await runWith(twoSdks('^3.20.0').f.data);
    expect(none.error!.message).toMatch(/no configured Flutter SDK matches Dart \^3\.20\.0/);
    const bound = twoSdks('>=3.5.0 <4.0.0', 'flutter@3.41.9');
    const r = await runWith(bound.f.data);
    expect(r).toMatchObject({ executable: 'flutter@3.41.9', ran: [fs.realpathSync(bound.old)] });
  });
});
