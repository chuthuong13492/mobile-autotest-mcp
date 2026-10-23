/**
 * `autotest init` (CLI-001): creates the data root (0700) and a commented `config.yaml` (0600). An existing
 * config is never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDataRoot } from '@autotest/storage';
import { dataRootOf, type CliEnv } from '../context.ts';
import type { Io } from '../io.ts';

export const CONFIG_TEMPLATE = `# AutoTest user policy. Changing any section changes the policy version, which makes
# earlier coverage decisions and approvals stale (that is intended).
version: 1

# Repositories AutoTest may inspect. readOnlyReference: true allows inspection only.
workspaces: []
#  - id: ws_myapp
#    path: /Users/you/src/myapp

# Logical executable -> absolute path (+ optional sha256 pin). PATH is never searched.
executables: {}
#  flutter: { path: /Users/you/fvm/default/bin/flutter }

# Child-process environment: allowlisted variables and secret references.
# env:
#   allow: [JAVA_HOME]

# Minimum approval assurance may be raised here; lowering needs allowWeakApprovals: true.
# approvals:
#   minAssurance: { plan_execution: { local: AL2 } }
`;

export async function init(e: CliEnv, io: Io): Promise<number> {
  const root = dataRootOf(e.env);
  ensureDataRoot(root);
  const file = path.join(root, 'config.yaml');
  if (fs.existsSync(file)) {
    io.out(`Data root ready at ${root}; ${file} already exists and was left unchanged.`);
    return 0;
  }
  fs.writeFileSync(file, CONFIG_TEMPLATE, { mode: 0o600, flag: 'wx' });
  io.out(`Created ${root} and ${file}. Add your workspaces and executables, then run \`autotest doctor\`.`);
  return 0;
}
