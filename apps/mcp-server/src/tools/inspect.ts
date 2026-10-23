/**
 * TL-02 `inspect_project` and TL-03 `inspect_test_inventory` use cases (INS-001, INS-002).
 *
 * The workspace is resolved through policy (by id or by a path that canonicalizes to an allowlisted root) and read
 * only through the bounded workspace reader; inspection runs over the adapter registry; profiles and inventory
 * snapshots are persisted immutably and every inventory page is drawn from a stored snapshot.
 */
import type { AdapterRegistry, HostInfo, ProbePort } from '@autotest/adapter-sdk';
import { toolError, type ProjectProfile, type TestInventory } from '@autotest/core';
import { buildInventory, InspectError, inspectProject, pageInventory } from '@autotest/inspect';
import {
  findWorkspace,
  nodeFsPort,
  resolveWorkspaces,
  type PolicyLoadResult,
  type ResolvedWorkspace,
} from '@autotest/policy';
import { fail, ok, type UseCases, type WorkflowPorts } from '@autotest/workflow';
import { createWorkspaceReader } from '@autotest/workspace';

export interface InspectDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly registry: AdapterRegistry;
  readonly host: HostInfo;
  /** Builds a probe port for one workspace (absent: probes are skipped). */
  readonly probes?: (workspace: ResolvedWorkspace) => ProbePort;
  readonly budgetMs?: number;
  readonly inventoryLimits?: { readonly maxFiles: number; readonly maxBytes: number };
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const policyUnavailable = () =>
  fail(
    toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', [
      'Fix ~/.autotest/config.yaml, then run `autotest doctor`.',
    ]),
  );
const notAllowed = () =>
  fail(
    toolError('E_WORKSPACE_NOT_ALLOWED', 'the workspace is not an allowlisted root', [
      'Add it to `workspaces` in ~/.autotest/config.yaml',
    ]),
  );

function resolve(deps: InspectDeps, ref: string): ResolvedWorkspace | undefined {
  if (!deps.policy.ok) return undefined;
  const fsp = nodeFsPort();
  return findWorkspace(fsp, resolveWorkspaces(fsp, deps.policy.policy.config.workspaces), ref);
}

export function inspectUseCases(deps: InspectDeps): Pick<UseCases, 'inspect_project' | 'inspect_test_inventory'> {
  return {
    async inspect_project(input) {
      if (!deps.policy.ok) return policyUnavailable();
      const ws = resolve(deps, input.workspace);
      if (!ws) return notAllowed();
      let result;
      try {
        result = await inspectProject({
          registry: deps.registry,
          workspace: createWorkspaceReader(ws),
          host: deps.host,
          ...(input.probeToolchains && deps.probes ? { probes: deps.probes(ws) } : {}),
          ...(input.adapters ? { adapterIds: input.adapters } : {}),
          maxFiles: input.maxFiles,
          ...(deps.budgetMs ? { budgetMs: deps.budgetMs } : {}),
        });
      } catch (e) {
        if (e instanceof InspectError)
          return fail(
            toolError('E_VALIDATION', e.message, ['Use registered adapter ids'], {
              issues: [{ pointer: '/adapters', message: e.message }],
            }),
          );
        throw e;
      }
      if (deps.registry.adapters.length === 0)
        result.limitations.push({ code: 'no_adapters', message: 'no platform adapters are installed in this build' });
      const profile: ProjectProfile = {
        id: deps.ports.ids.newId('prj'),
        schemaVersion: 1,
        createdAt: iso(deps.ports.clock.now()),
        workspace: { rootRealPath: ws.realPath, allowlistEntryId: ws.id },
        frameworks: result.frameworks,
        platforms: result.platforms,
        languages: result.languages,
        toolchains: result.toolchains,
        runners: result.runners,
        limitations: result.limitations,
      };
      await deps.ports.profiles.put(profile);
      return ok({
        projectProfileId: profile.id,
        frameworks: profile.frameworks,
        platforms: profile.platforms,
        languages: profile.languages,
        toolchains: profile.toolchains,
        runners: profile.runners,
        limitations: profile.limitations,
      });
    },

    async inspect_test_inventory(input) {
      const profile = await deps.ports.profiles.get(input.projectProfileId);
      if (!profile) return fail(toolError('E_NOT_FOUND', 'project profile not found', ['Run inspect_project first']));
      let inventory: TestInventory | undefined;
      if (input.inventoryId) {
        inventory = await deps.ports.inventories.get(input.inventoryId);
        if (!inventory || inventory.profileId !== profile.id)
          return fail(
            toolError('E_NOT_FOUND', 'inventory not found for this profile', [
              'Omit inventoryId to create a new snapshot',
            ]),
          );
      } else {
        if (!deps.policy.ok) return policyUnavailable();
        const ws = resolve(deps, profile.workspace.allowlistEntryId);
        // The allowlist entry must still resolve to the same canonical root the profile was built from.
        if (!ws || ws.realPath !== profile.workspace.rootRealPath) return notAllowed();
        const limits = deps.inventoryLimits ?? { maxFiles: 50_000, maxBytes: 262_144 };
        const content = await buildInventory({
          registry: deps.registry,
          adapterIds: profile.frameworks.map((f) => f.adapterId),
          workspace: createWorkspaceReader(ws),
          host: deps.host,
          limits,
          ...(deps.budgetMs ? { budgetMs: deps.budgetMs } : {}),
        });
        inventory = {
          id: deps.ports.ids.newId('inv'),
          schemaVersion: 1,
          createdAt: iso(deps.ports.clock.now()),
          profileId: profile.id,
          ...content,
        };
        await deps.ports.inventories.put(inventory);
      }
      try {
        const page = pageInventory(inventory, {
          codec: deps.ports.cursors,
          filter: input.filter,
          cursor: input.cursor,
          limit: input.limit,
        });
        return page.ok ? ok(page.value) : fail(page.error);
      } catch (e) {
        if (e instanceof InspectError)
          return fail(toolError('E_PATH_ESCAPE', e.message, ['Use a workspace-relative pathPrefix']));
        throw e;
      }
    },
  };
}
