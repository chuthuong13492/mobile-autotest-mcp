/**
 * Default supervisor hooks for the detached entrypoint. Policy is re-loaded from the user config in the data root
 * (never from `run.json`), the workspace is re-resolved by id, and every spawn is re-validated by `exec`.
 *
 * Dispatch authorization here is the EXE-003 baseline: it denies when policy cannot be loaded, the workspace is no
 * longer allowlisted or executable, or the header carries no create-time authorization digest. The full
 * `authorizeExecution` re-evaluation with digest comparison replaces it in RUN-002.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuthorizationReason } from '@autotest/core';
import { buildRegistry, envSecretResolver, loadPolicyConfig, nodeFsPort, resolveWorkspaces } from '@autotest/policy';
import type { SupervisorHooks } from './supervisor.ts';
import { runPaths } from './files.ts';

export function defaultHooks(
  dataRoot: string,
  runId: string,
  parentEnv: Readonly<Record<string, string | undefined>>,
): SupervisorHooks {
  const fsp = nodeFsPort();
  let text: string | undefined;
  try {
    text = fs.readFileSync(path.join(dataRoot, 'config.yaml'), 'utf8');
  } catch {
    text = undefined;
  }
  const loaded = loadPolicyConfig(text);
  const config = loaded.ok ? loaded.policy.config : undefined;
  const workspaces = config ? resolveWorkspaces(fsp, config.workspaces).workspaces : [];
  const registry = config ? buildRegistry(fsp, config.executables) : undefined;
  const paths = runPaths(dataRoot, runId);

  return {
    async authorize(header) {
      const reasons: AuthorizationReason[] = [];
      if (!config) reasons.push('policy_unavailable');
      const ws = workspaces.find((w) => w.id === header.workspaceId);
      if (!ws || ws.readOnlyReference) reasons.push('workspace_not_allowed');
      return { result: reasons.length ? 'denied' : 'authorized', reasons, inputsDigest: header.authorizationDigest };
    },
    spawnContext({ header, stdoutPath, stderrPath }) {
      const ws = workspaces.find((w) => w.id === header.workspaceId);
      if (!config || !registry || !ws || ws.readOnlyReference) return undefined;
      // A baseline run executes in its worktree inside the run directory (ANL-002), never anywhere else.
      let root = ws.realPath;
      if (header.baseline) {
        try {
          root = fsp.realpath(path.join(paths.dir, header.baseline.dir));
        } catch {
          return undefined;
        }
        if (path.dirname(root) !== fsp.realpath(paths.dir)) return undefined;
      }
      return {
        fs: fsp,
        registry,
        workspaceRoot: root,
        runDir: paths.dir,
        allowDependencyResolution: config.execution.allowDependencyResolution,
        allowedClasses: ['test_runner'],
        runId: header.runId,
        workspaceId: ws.id,
        envPolicy: config.env,
        parentEnv,
        resolver: envSecretResolver(parentEnv),
        home: paths.home,
        tmpDir: paths.tmpDir,
        stdoutPath,
        stderrPath,
        outputCapBytes: header.outputCapBytes,
        ...(header.execution?.device?.platform === 'android' && /^emulator-\d{4,5}$/.test(header.execution.device.id)
          ? { androidSerial: header.execution.device.id }
          : {}),
      };
    },
  };
}
