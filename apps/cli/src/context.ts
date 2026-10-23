/** Opens the data root, the stores and the policy for one CLI invocation. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCursorCodec, createIdGenerator } from '@autotest/core';
import { loadPolicyConfig, type PolicyLoadResult } from '@autotest/policy';
import { loadOrCreateKey, openDataRoot, type SqlPort } from '@autotest/storage';
import { serverEnvironmentOf, type WorkflowPorts } from '@autotest/workflow';

export interface CliEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to crypto-secure randomness. */
  readonly randomInt?: (maxExclusive: number) => number;
  readonly now?: () => Date;
}

export interface CliContext {
  readonly dataRoot: string;
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly environment: { readonly id: string; readonly kind: 'local' };
  readonly osUser: string;
  close(): void;
}

export function dataRootOf(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env['AUTOTEST_HOME'];
  return configured && path.isAbsolute(configured) ? configured : path.join(env['HOME'] ?? os.homedir(), '.autotest');
}

export function openCli(e: CliEnv): CliContext {
  const dataRoot = dataRootOf(e.env);
  const { sql, stores } = openDataRoot(dataRoot);
  let text: string | undefined;
  try {
    text = fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8');
  } catch {
    text = undefined;
  }
  const clock = { now: e.now ?? (() => new Date()) };
  const { idempotency: _unused, ...domain } = stores;
  void _unused;
  const ports: WorkflowPorts = {
    ...domain,
    clock,
    ids: createIdGenerator(),
    cursors: createCursorCodec(loadOrCreateKey(dataRoot, 'cursor'), clock),
    execution: {
      startSupervisor: () => Promise.reject(new Error('the CLI does not start runs')),
    },
  };
  return {
    dataRoot,
    ports,
    policy: loadPolicyConfig(text),
    environment: serverEnvironmentOf(e.env),
    osUser: os.userInfo().username,
    close: () => (sql as SqlPort).close(),
  };
}
