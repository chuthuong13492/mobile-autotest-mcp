/**
 * Opt-in (minutes; real simulators): AUTOTEST_E2E_DEVICES=1.
 * B3 (1.4.0) `manage_simulator acquire` with **real simulators**: created when nothing fits, reused next time, and a
 * simulator that is not AutoTest's (made here by the test, never one of the user's) adopted only after a CLI `y`
 * approval; a Flutter integration_test runs on it, its lease ends with the run, and it is left booted with the same
 * UDID. The simulators already on the machine are compared before and after: AutoTest must not touch them.
 * Device types no existing simulator uses keep the user's devices out of every match.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run as cli, type Io } from '@autotest/cli';
import { composeServer } from '@autotest/mcp-server';
import { allResults, sc, waitTerminal } from '../../apps/mcp-server/test/runSetup.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const which = (n: string) => spawnSync('/bin/sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).stdout.trim();
const XCRUN = process.platform === 'darwin' ? which('xcrun') : '';
const FLUTTER = process.env['AUTOTEST_E2E_FLUTTER'] ?? which('flutter');
const OK = process.env['AUTOTEST_E2E_DEVICES'] === '1' && !!XCRUN && !!FLUTTER;
const HOST = { AUTOTEST_LOG_LEVEL: 'error', AUTOTEST_HOST_ID: 'e2e-acquire-host' };
const OWN_TYPE = 'iPhone 17 Pro';
const FOREIGN_TYPE = 'iPhone 17 Pro Max';
const RUNTIME = 'iOS 26.4';

const simctl = (...args: string[]) => execFileSync(XCRUN, ['simctl', ...args], { encoding: 'utf8' });
const devicesNow = () =>
  Object.values(
    JSON.parse(simctl('list', 'devices', '--json')).devices as Record<
      string,
      { udid: string; state: string; name: string }[]
    >,
  )
    .flat()
    .map((d) => ({ udid: d.udid, state: d.state, name: d.name }));

const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse())
    try {
      await c();
    } catch {
      // best effort
    }
});

describe.skipIf(!OK)('B3 acquire on real simulators', () => {
  it(
    'creates, reuses, adopts with approval, runs, and leaves the adopted simulator intact',
    { timeout: 1_800_000 },
    async () => {
      const before = devicesNow();
      const base = fs.realpathSync(
        fs.mkdtempSync(path.join(process.env['AUTOTEST_E2E_KEEP'] || os.tmpdir(), 'autotest-acquire-')),
      );
      const ws = path.join(base, 'ws');
      fs.cpSync(path.join(ROOT, 'fixtures/fixture-flutter'), ws, { recursive: true });
      execFileSync(fs.realpathSync(FLUTTER), ['pub', 'get', '--offline'], {
        cwd: ws,
        stdio: 'ignore',
        timeout: 240_000,
      });
      const data = path.join(base, 'data');
      fs.mkdirSync(data, { mode: 0o700 });
      fs.writeFileSync(
        path.join(data, 'config.yaml'),
        `version: 1\nworkspaces: [{ id: ws_app, path: ${ws} }]\nexecutables: { flutter: { path: ${fs.realpathSync(FLUTTER)} }, xcrun: { path: ${fs.realpathSync(XCRUN)} } }\nexecution: { defaultTimeoutMs: 1800000 }\n`,
      );
      const c = await composeServer({
        dataRoot: data,
        env: { ...process.env, ...HOST },
        stderr: { write: () => true },
      });
      cleanups.push(() => c.close());
      type Acq = {
        deviceId: string;
        result: string;
        owned: boolean;
        state: string;
        error?: { code: string; details?: { deviceId?: string; scopeDigest?: string } };
      };
      const acquire = async (acq: Record<string, unknown>) =>
        sc<Acq>(
          await c.call('manage_simulator', {
            action: 'acquire',
            acquire: { platform: 'ios', runtime: RUNTIME, ...acq },
          }),
        );

      // Nothing of this type exists: created (and booted).
      const created = await acquire({ deviceType: OWN_TYPE, allowAdopt: false });
      expect(created).toMatchObject({ result: 'created', owned: true, state: 'Booted' });
      cleanups.push(() => c.call('manage_simulator', { action: 'delete', deviceId: created.deviceId }));
      // Next time it is reused: no new device.
      expect(await acquire({ deviceType: OWN_TYPE })).toMatchObject({ result: 'reused', deviceId: created.deviceId });

      // A simulator that is not AutoTest's (created here by the test, standing in for a user's device).
      const foreign = simctl(
        'create',
        `e2e-foreign-${process.pid}`,
        FOREIGN_TYPE,
        'com.apple.CoreSimulator.SimRuntime.iOS-26-4',
      ).trim();
      cleanups.push(() => simctl('delete', foreign));
      simctl('boot', foreign);
      // As a user's simulator would be: fully booted, not just accepted by `simctl boot`.
      simctl('bootstatus', foreign, '-b');
      const asked = await acquire({ deviceType: FOREIGN_TYPE });
      expect(asked.error).toMatchObject({ code: 'E_APPROVAL_REQUIRED', details: { deviceId: foreign } });
      const req = sc<{ approvalRequestId: string }>(
        await c.call('request_approval', {
          scope: { kind: 'device_action', deviceAction: { action: 'use_non_owned', deviceId: foreign } },
          justification: 'e2e acquire',
          offerElicitation: false,
        }),
      );
      const io: Io = {
        stdinIsTTY: true,
        stdoutIsTTY: true,
        out: () => undefined,
        err: () => undefined,
        ask: async (p) => (/\[y\/N\] $/.test(p) ? 'y' : ''),
      };
      expect(await cli(['approve', req.approvalRequestId], io, { env: { ...HOST, AUTOTEST_HOME: data } })).toBe(0);
      expect(await acquire({ deviceType: FOREIGN_TYPE })).toMatchObject({
        result: 'adopted',
        deviceId: foreign,
        owned: false,
      });

      // A Flutter integration_test run on the adopted simulator.
      const prc = sc<{ prContextId: string }>(
        await c.call('get_pr_context', {
          workspace: 'ws_app',
          source: 'manual',
          manual: {
            title: 'Counter',
            body: '## Acceptance criteria\n- [ ] Tapping increment shows "Count: 1" on the device\n',
          },
        }),
      );
      const prj = sc<{ projectProfileId: string }>(
        await c.call('inspect_project', { workspace: 'ws_app', probeToolchains: false }),
      );
      const inv = sc<{ inventoryId: string }>(
        await c.call('inspect_test_inventory', { projectProfileId: prj.projectProfileId }),
      );
      const rqs = sc<{ requirementSetId: string }>(
        await c.call('extract_requirements', { prContextId: prc.prContextId }),
      );
      const plan = sc<{ planId: string; planHash: string }>(
        await c.call('generate_test_plan', {
          requirementSetId: rqs.requirementSetId,
          inventoryId: inv.inventoryId,
          platformsInScope: ['ios'],
          draft: {
            testCases: [
              {
                clientKey: 'k1',
                title: 'Counter on iOS',
                requirementRefs: ['REQ-001'],
                acRefs: ['REQ-001.AC-01'],
                level: 'integration',
                technique: 'regression',
                priority: 'must',
                platforms: ['ios'],
                steps: ['Tap increment'],
                expectedResults: [`Text 'Count: 1' is visible`],
                targetPath: 'integration_test/app_test.dart',
                automation: 'existing_test',
              },
            ],
          },
        }),
      );
      const gate = sc<{ decision: string }>(
        await c.call('validate_test_coverage', { planId: plan.planId, planHash: plan.planHash }),
      );
      expect(gate.decision).not.toBe('fail');
      if (gate.decision === 'needs_review') {
        const r = sc<{ approvalRequestId: string }>(
          await c.call('request_approval', {
            scope: { kind: 'plan_execution', planId: plan.planId, planHash: plan.planHash },
            justification: 'e2e',
            offerElicitation: false,
          }),
        );
        expect(await cli(['approve', r.approvalRequestId], io, { env: { ...HOST, AUTOTEST_HOME: data } })).toBe(0);
      }
      const run = sc<{ runId: string; error?: unknown }>(
        await c.call('run_tests', { planId: plan.planId, planHash: plan.planHash, devices: [foreign] }),
      );
      expect(run.error).toBeUndefined();
      expect(await waitTerminal(c, run.runId, 1_500_000)).toMatchObject({ state: 'completed' });
      const by = Object.fromEntries((await allResults(c, run.runId)).map((r) => [r.name, r.outcome]));
      expect(by['tapping increment shows Count: 1 on the device']).toBe('passed');
      // The adoption ended with the run; the simulator is still there, booted, same UDID.
      expect(await c.ports.deviceLeases.findByDevice(foreign)).toBeUndefined();
      expect(devicesNow().find((d) => d.udid === foreign)).toMatchObject({ state: 'Booted' });
      // The simulators that existed before are exactly as they were.
      const after = devicesNow();
      for (const d of before)
        expect(
          after.find((x) => x.udid === d.udid),
          d.name,
        ).toEqual(d);
    },
  );
});
