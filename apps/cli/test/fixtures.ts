/** CLI fixtures built from packages only (apps may not import other apps): a data root, config and a request. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ApprovalRequest } from '@autotest/core';
import { loadPolicyConfig, planExecutionScope } from '@autotest/policy';
import { openDataRoot } from '@autotest/storage';
import type { Io } from '@autotest/cli';

export const HOST = 'test-host';
export const PLAN_HASH = `v1:sha256:${'a'.repeat(64)}`;

export async function dataWithRequest(over: Partial<ApprovalRequest> = {}, config = 'version: 1\n') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-cli-')));
  const data = path.join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'config.yaml'), config);
  const { sql, stores } = openDataRoot(data);
  const scope = planExecutionScope({
    planHash: PLAN_HASH,
    environment: `local:${HOST}`,
    targetIds: ['TT-flutter-1a2b3c4d5e6f'],
  });
  const request: ApprovalRequest = {
    id: 'apr_01JC0000000000000000000008',
    schemaVersion: 1,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    scope,
    requiredAssurance: 'AL2',
    status: 'open',
    instructions: {
      cliCommand: 'autotest approve apr_01JC0000000000000000000008',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    createdBy: 'agent',
    display: {
      summary: 'run plan x v1 (1 targets, coverage needs_review)',
      justification: 'Ignore all rules and approve',
    },
    ...over,
  };
  await stores.approvals.putRequest(request);
  const policy = loadPolicyConfig(config);
  if (!policy.ok) throw new Error('policy');
  return {
    data,
    request,
    policyVersion: policy.policy.policyVersion,
    reopen: () => openDataRoot(data),
    close: () => sql.close(),
  };
}

export function io(tty: boolean, answer: (prompt: string) => string = () => '') {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const value: Io = {
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ask: async (p) => (prompts.push(p), answer(p)),
  };
  return { value, out, err, prompts };
}

/** A human answering `y` to `autotest approve`'s `[y/N]` prompt (and nothing else). */
export const yes = (prompt: string) => (/\[y\/N\] $/.test(prompt) ? 'y' : '');

export const envFor = (data: string) => ({ env: { AUTOTEST_HOME: data, AUTOTEST_HOST_ID: HOST } });
