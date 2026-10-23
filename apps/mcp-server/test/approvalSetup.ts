/** Shared setup: a workspace, user config and a validated plan (pass or needs_review) on a fresh data root. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExampleAdapter } from '@autotest/adapter-sdk/testing';
import { composeServer } from '@autotest/mcp-server';

export const HOST_ENV = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'test-host' };
const quiet = { write: () => true };
export const sc = <T>(r: { structuredContent: Record<string, unknown> }) => r.structuredContent as T;

export function setupData(extraConfig = '') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-apr-')));
  const ws = path.join(base, 'ws');
  for (const f of ['example.json', 'test/widgets/badge_test.dart', 'test/widgets/hidden_test.dart']) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), '');
  }
  fs.writeFileSync(path.join(base, 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(
    path.join(data, 'config.yaml'),
    `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${path.join(base, 'flutter')} } }\n${extraConfig}`,
  );
  return { base, ws, data };
}

export const composeAt = (data: string) =>
  composeServer({ dataRoot: data, env: HOST_ENV, stderr: quiet, adapters: [createExampleAdapter()] });

const BODY = '## Acceptance criteria\n- [ ] Badge shows count of new listings\n- [ ] Badge hidden when count is 0\n';
const kase = (key: string, ac: string, over: Record<string, unknown> = {}) => ({
  clientKey: key,
  title: `Case ${key}`,
  requirementRefs: ['REQ-001'],
  acRefs: [ac],
  level: 'unit',
  technique: 'positive',
  priority: 'must',
  platforms: ['host'],
  steps: [`Pump ${key}`],
  expectedResults: [`Text '${key}' is visible`],
  targetPath: 'test/widgets/badge_test.dart',
  automation: 'existing_test',
  ...over,
});

/** Creates and validates a plan. `kind`: `pass`, `needs_review` (a weak assertion) or `fail` (missing regression). */
export async function validatedPlan(
  c: Awaited<ReturnType<typeof composeAt>>,
  kind: 'pass' | 'needs_review' | 'fail' | 'unvalidated',
) {
  const prc = sc<{ prContextId: string }>(
    await c.call('get_pr_context', { workspace: 'ws_app', source: 'manual', manual: { title: 'Badge', body: BODY } }),
  ).prContextId;
  const profile = sc<{ projectProfileId: string }>(
    await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
  ).projectProfileId;
  const inv = sc<{ inventoryId: string }>(
    await c.call('inspect_test_inventory', { projectProfileId: profile }),
  ).inventoryId;
  const rqs = sc<{ requirementSetId: string }>(
    await c.call('extract_requirements', { prContextId: prc }),
  ).requirementSetId;
  const cases =
    kind === 'fail'
      ? [kase('count', 'REQ-001.AC-01')]
      : [
          kase('count', 'REQ-001.AC-01', kind === 'needs_review' ? { expectedResults: ['Search works properly'] } : {}),
          kase('hidden', 'REQ-001.AC-02', { technique: 'regression', targetPath: 'test/widgets/hidden_test.dart' }),
        ];
  const plan = sc<{ planId: string; planHash: string }>(
    await c.call('generate_test_plan', {
      requirementSetId: rqs,
      inventoryId: inv,
      platformsInScope: ['host'],
      draft: { testCases: cases },
    }),
  );
  if (kind !== 'unvalidated') {
    const d = sc<{ decision: string }>(
      await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }),
    );
    if (d.decision !== kind) throw new Error(`expected ${kind}, got ${d.decision}`);
  }
  return plan;
}
