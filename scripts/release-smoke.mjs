#!/usr/bin/env node
/* global process, console, setTimeout */
// Release smoke test (M8): drives an installed `autotest-mcp` over stdio JSON-RPC through inspect → plan → gate →
// run → results → evidence → report on the fixture app (workspace `ws_app` must be configured, with flutter).
// Usage: node release-smoke.mjs <path to dist/autotest-mcp.mjs>. Exits 1 on any unexpected result.
import { spawn } from 'node:child_process';

const [entry] = process.argv.slice(2);
if (!entry) {
  console.error('usage: release-smoke.mjs <dist/autotest-mcp.mjs>');
  process.exit(2);
}
const p = spawn(process.execPath, [entry], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { ...process.env, AUTOTEST_LOG_LEVEL: 'error' },
});
const waiting = new Map();
let buf = '';
let id = 0;
p.stdout.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id) waiting.get(m.id)?.(m.result ?? m.error);
  }
});
const send = (method, params) =>
  new Promise((r) => {
    const n = ++id;
    waiting.set(n, r);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.structuredContent)}`);
  return r.structuredContent;
};
const expect = (ok, what) => {
  if (!ok) throw new Error(`unexpected: ${what}`);
  console.log(`ok  ${what}`);
};

try {
  await send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'release-smoke', version: '0' },
  });
  p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const prj = await call('inspect_project', { workspace: 'ws_app' });
  expect(
    prj.frameworks.some((f) => f.adapterId === 'flutter'),
    'Flutter detected',
  );
  const flutter = prj.toolchains.find((t) => t.tool === 'flutter');
  console.log(
    `    flutter ${flutter?.resolved ?? 'unresolved'} (${(flutter?.versionsBySource ?? []).map((s) => s.source).join(', ')})`,
  );
  const inv = await call('inspect_test_inventory', { projectProfileId: prj.projectProfileId });
  const paths = inv.targets.map((t) => t.path);
  expect(
    paths.includes('test/calculator_test.dart') && paths.includes('test/flaky_test.dart'),
    'fixture tests inventoried',
  );
  const body =
    'Calculator and counter.\n\n## Acceptance criteria\n- [ ] Given 40 and 2, add returns 42\n- [ ] Tapping increment shows "Count: 1"\n- [ ] The flaky check eventually shows "ok"\n';
  const prc = await call('get_pr_context', {
    workspace: 'ws_app',
    source: 'manual',
    manual: { title: 'Calculator', body },
  });
  const rqs = await call('extract_requirements', { prContextId: prc.prContextId });
  const k = (key, ac, p, technique, level) => ({
    clientKey: key,
    title: `Case ${key}`,
    requirementRefs: ['REQ-001'],
    acRefs: [ac],
    level,
    technique,
    priority: 'must',
    platforms: ['host'],
    steps: ['run'],
    expectedResults: ["Text 'ok' is visible"],
    targetPath: p,
    automation: 'existing_test',
  });
  const plan = await call('generate_test_plan', {
    requirementSetId: rqs.requirementSetId,
    inventoryId: inv.inventoryId,
    platformsInScope: ['host'],
    draft: {
      testCases: [
        k('a', 'REQ-001.AC-01', 'test/calculator_test.dart', 'regression', 'unit'),
        k('b', 'REQ-001.AC-02', 'test/counter_widget_test.dart', 'positive', 'widget'),
        k('c', 'REQ-001.AC-03', 'test/flaky_test.dart', 'positive', 'unit'),
      ],
    },
  });
  expect(
    (await call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash })).decision === 'pass',
    'gate pass',
  );
  const run = await call('run_tests', { planId: plan.planId, planHash: plan.planHash, evidence: { coverage: true } });
  let s;
  const t0 = Date.now();
  do {
    await new Promise((r) => setTimeout(r, 1000));
    s = await call('get_run_status', { runId: run.runId });
  } while (!['completed', 'cancelled', 'timed_out', 'infra_error'].includes(s.state) && Date.now() - t0 < 600_000);
  expect(s.state === 'completed', `run completed in ${Math.round((Date.now() - t0) / 1000)} s`);
  const res = await call('get_run_results', { runId: run.runId });
  expect(res.results.length === 5 && res.results.every((r) => r.outcome === 'passed'), '5 results passed');
  expect(
    res.results.some((r) => r.flaky && r.attemptNo === 2),
    'flaky test passed on attempt 2 and is labelled',
  );
  const ev = await call('collect_test_evidence', { runId: run.runId });
  expect(
    ['stdout', 'runner_json', 'junit', 'coverage'].every((k) => ev.artifacts.some((a) => a.kind === k)) &&
      ev.quarantinedCount === 0,
    'evidence collected',
  );
  const rep = await call('generate_pr_test_report', {
    planId: plan.planId,
    planHash: plan.planHash,
    runIds: [run.runId],
  });
  expect(rep.verdict === 'pass' && rep.artifacts.length === 3, 'report pass with Markdown, JSON and JUnit');
  console.log('release smoke: PASS');
  p.stdin.end();
} catch (e) {
  console.error(`release smoke: FAIL: ${e.message}`);
  p.kill();
  process.exit(1);
}
