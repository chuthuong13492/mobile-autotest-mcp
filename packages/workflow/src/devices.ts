/**
 * TL-13 `list_devices` and TL-14 `manage_simulator` (DEV-001, DEV-002; FR-035, FR-036; SR-011; T-10).
 *
 * Ownership is the lease store, never a device name: a device is AutoTest's when a lease created by AutoTest names
 * its id. The tier matrix:
 * - owned devices: create, boot, shutdown, erase, delete at P1 (no approval);
 * - devices the user owns: boot and shutdown, erase and delete at P2, each with a single-use `device_action`
 *   approval (AL2 via `autotest approve`) for exactly `(action, deviceId, host)`;
 * - physical devices: never (`E_POLICY_DENIED`).
 * Every action is audited (`device.action`, with the tier and the approval id).
 */
import os from 'node:os';
import path from 'node:path';
import {
  androidBoot,
  androidCreate,
  androidDelete,
  androidErase,
  androidSerial,
  androidShutdown,
  iosBoot,
  iosCreate,
  iosDelete,
  iosErase,
  iosShutdown,
  installApp,
  listDevices,
  platformOf,
  type DeviceContext,
  type Outcome,
} from '@autotest/devices';
import {
  isTerminal,
  PortError,
  toolError,
  type DeviceLease,
  type ToolError,
  type ToolInput,
  type ToolOutput,
} from '@autotest/core';
import {
  buildRegistry,
  deviceActionScope,
  NO_AL3,
  nodeFsPort,
  resolveWorkspaces,
  selectApproval,
  type PolicyEnvironment,
  type PolicyLoadResult,
} from '@autotest/policy';
import type { ExecPort } from '@autotest/execution';
import type { CallContext, WorkflowPorts } from './ports.ts';
import { fail, ok, type UseCaseResult } from './result.ts';

export interface DeviceDeps {
  readonly ports: WorkflowPorts;
  readonly policy: PolicyLoadResult;
  readonly dataRoot: string;
  readonly hostOs: 'macos' | 'linux' | 'windows';
  readonly serverEnvironment: { readonly id: string; readonly kind: PolicyEnvironment };
  /** The server's environment (HOME and the SDK variables the device tools need). */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly execPort?: ExecPort;
}

/** Leases created by AutoTest last a day unless a run extends them. */
export const LEASE_TTL_MS = 24 * 3600_000;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function deviceContext(deps: DeviceDeps): DeviceContext | undefined {
  if (!deps.policy.ok) return undefined;
  const fsp = nodeFsPort();
  return {
    fs: fsp,
    registry: buildRegistry(fsp, deps.policy.policy.config.executables),
    workDir: path.join(deps.dataRoot, 'devices'),
    parentEnv: { HOME: os.homedir(), ...deps.parentEnv },
    ...(deps.execPort ? { port: deps.execPort } : {}),
  };
}

const policyUnavailable = () =>
  toolError('E_POLICY_UNAVAILABLE', 'the user policy is missing or invalid', ['Run `autotest doctor`']);

async function busy(deps: DeviceDeps, lease: DeviceLease | undefined): Promise<boolean> {
  if (!lease?.runId) return false;
  const run = await deps.ports.runs.get(lease.runId);
  return run !== undefined && !isTerminal(run.state);
}

export async function listDevicesUseCase(
  deps: DeviceDeps,
  input: ToolInput<'list_devices'>,
): Promise<UseCaseResult<ToolOutput<'list_devices'>>> {
  const ctx = deviceContext(deps);
  if (!ctx) return fail(policyUnavailable());
  const listing = await listDevices(ctx, input.platform, deps.hostOs);
  const leases = await deps.ports.deviceLeases.list();
  const devices = [];
  for (const d of listing.devices) {
    const lease = leases.find((l) => l.deviceId === d.deviceId);
    const availability = !d.usable ? 'unavailable' : (await busy(deps, lease)) ? 'busy' : 'available';
    if (availability === 'unavailable' && !input.includeUnavailable) continue;
    devices.push({
      deviceId: d.deviceId,
      platform: d.platform,
      kind: d.kind,
      name: d.name,
      osVersion: d.osVersion,
      state: d.state,
      availability,
      owned: lease?.createdByAutotest === true,
      leaseId: lease?.id ?? null,
    } as const);
  }
  return ok({ host: listing.host, devices: devices.slice(0, 100), unsupported: [...listing.unsupported] });
}

/**
 * `install` (RN-003): an app built beforehand, from an allowlisted workspace, onto a booted device AutoTest owns
 * (P1). Devices AutoTest does not own are refused rather than approved: installing changes them for good.
 */
async function install(
  deps: DeviceDeps,
  ctx: DeviceContext,
  d: { deviceId: string; owned: boolean; state: string; lease: DeviceLease | undefined },
  input: ToolInput<'manage_simulator'>,
  audit: (deviceId: string, tier: 'P1' | 'P2') => Promise<unknown>,
): Promise<UseCaseResult<ToolOutput<'manage_simulator'>>> {
  if (!d.owned)
    return fail(
      toolError('E_DEVICE_NOT_OWNED', `${d.deviceId} is not an AutoTest device: apps are installed only on those`, [
        'Create one with manage_simulator {action: "create"} and boot it',
      ]),
    );
  if (d.state !== 'Booted')
    return fail(
      toolError('E_DEVICE_UNAVAILABLE', `${d.deviceId} is ${d.state}`, [
        'Boot it with manage_simulator {action: "boot"}',
      ]),
    );
  const ws = deps.policy.ok
    ? resolveWorkspaces(nodeFsPort(), deps.policy.policy.config.workspaces).workspaces.find(
        (w) => w.id === input.install!.workspace,
      )
    : undefined;
  if (!ws)
    return fail(
      toolError('E_WORKSPACE_NOT_ALLOWED', `workspace ${input.install!.workspace} is not allowlisted`, [
        'Use a workspace id from config.yaml (`autotest setup --workspace <repo>`)',
      ]),
    );
  const out = await installApp(ctx, d.deviceId, ws.realPath, input.install!.appPath);
  if (!out.ok) return fail(outcomeError(out));
  await audit(d.deviceId, 'P1');
  return ok({
    action: 'install',
    deviceId: d.deviceId,
    owned: true,
    tierApplied: 'P1',
    result: 'done',
    leaseId: d.lease?.id ?? null,
    state: out.state,
  });
}

const APPROVAL_ACTION = {
  boot: 'boot_non_owned',
  shutdown: 'shutdown_non_owned',
  erase: 'erase',
  delete: 'delete',
} as const;

function outcomeError(o: Extract<Outcome, { ok: false }>): ToolError {
  if (o.reason === 'tool_missing' || o.reason === 'denied')
    return toolError('E_CAPABILITY_UNAVAILABLE', o.message, [
      'Run `autotest setup` (it allowlists the device tools), then `autotest doctor`',
    ]);
  if (o.reason === 'timeout') return toolError('E_TIMEOUT', o.message, ['Retry; check the device with list_devices']);
  if (o.reason === 'not_found')
    return toolError('E_DEVICE_UNAVAILABLE', o.message, ['Call list_devices for valid ids']);
  return toolError('E_DEVICE_UNAVAILABLE', o.message, ['Check the device with list_devices and `autotest doctor`']);
}

async function perform(
  ctx: DeviceContext,
  action: 'boot' | 'shutdown' | 'erase' | 'delete',
  deviceId: string,
): Promise<Outcome> {
  const ios = platformOf(deviceId) === 'ios';
  if (action === 'boot') return ios ? iosBoot(ctx, deviceId) : androidBoot(ctx, deviceId);
  if (action === 'shutdown') return ios ? iosShutdown(ctx, deviceId) : androidShutdown(ctx, deviceId);
  if (action === 'erase') return ios ? iosErase(ctx, deviceId) : androidErase(ctx, deviceId);
  return ios ? iosDelete(ctx, deviceId) : androidDelete(ctx, deviceId);
}

export async function manageSimulator(
  deps: DeviceDeps,
  input: ToolInput<'manage_simulator'>,
  callCtx: CallContext,
): Promise<UseCaseResult<ToolOutput<'manage_simulator'>>> {
  const ctx = deviceContext(deps);
  if (!ctx || !deps.policy.ok) return fail(policyUnavailable());
  const { ports } = deps;
  const now = ports.clock.now();
  const audit = (deviceId: string, tier: 'P1' | 'P2', approvalId?: string) =>
    ports.audit.append({
      ts: iso(ports.clock.now()),
      actor: 'agent',
      kind: 'device.action',
      subjectRefs: [deviceId, ...(input.runId ? [input.runId] : []), callCtx.toolCallId].slice(0, 3),
      data: { action: input.action, deviceId, tier, ...(approvalId ? { approvalId } : {}) },
    });

  if (input.action === 'create') {
    const c = input.create!;
    if (c.platform === 'ios' && deps.hostOs !== 'macos')
      return fail(toolError('E_CAPABILITY_UNAVAILABLE', 'iOS simulators need macOS', []));
    const name = `autotest-${ports.ids.newId('dev').slice(4).toLowerCase()}`;
    const out =
      c.platform === 'ios'
        ? await iosCreate(ctx, name, c.deviceType, c.runtime)
        : await androidCreate(ctx, name, c.deviceType, c.runtime);
    if (!out.ok) return fail(outcomeError(out));
    const lease: DeviceLease = {
      id: ports.ids.newId('lease'),
      deviceId: out.deviceId,
      runId: input.runId ?? null,
      owned: true,
      createdByAutotest: true,
      expiresAt: iso(new Date(now.getTime() + LEASE_TTL_MS)),
    };
    await ports.deviceLeases.put(lease);
    await audit(out.deviceId, 'P1');
    return ok({
      action: 'create',
      deviceId: out.deviceId,
      owned: true,
      tierApplied: 'P1',
      result: 'done',
      leaseId: lease.id,
      state: out.state,
    });
  }

  const deviceId = input.deviceId!;
  const listing = await listDevices(ctx, platformOf(deviceId), deps.hostOs);
  const device = listing.devices.find((d) => d.deviceId === deviceId);
  if (!device)
    return fail(
      listing.unsupported.length && listing.devices.length === 0
        ? toolError('E_CAPABILITY_UNAVAILABLE', listing.unsupported.map((u) => u.reason).join('; '), [
            'Run `autotest doctor`',
          ])
        : toolError('E_DEVICE_UNAVAILABLE', `no simulator or emulator ${deviceId}`, [
            'Call list_devices for valid ids',
          ]),
    );
  if (device.kind === 'physical')
    return fail(toolError('E_POLICY_DENIED', 'physical devices are never managed by AutoTest', []));
  const lease = await ports.deviceLeases.findByDevice(deviceId);
  const owned = lease?.createdByAutotest === true;
  if (owned && (await busy(deps, lease)) && lease?.runId !== input.runId && input.action !== 'boot')
    return fail(
      toolError('E_DEVICE_UNAVAILABLE', `${deviceId} is in use by run ${lease!.runId}`, ['Wait for the run to end']),
    );

  if (input.action === 'install')
    return install(deps, ctx, { deviceId, owned, state: device.state, lease }, input, audit);

  let approvalId: string | undefined;
  if (!owned) {
    const scope = deviceActionScope({
      action: APPROVAL_ACTION[input.action],
      deviceId,
      hostId: deps.serverEnvironment.id,
    });
    let candidates = await ports.approvals.listByScopeDigest(scope.digest);
    if (input.approvalId) candidates = candidates.filter((a) => a.id === input.approvalId);
    const sel = selectApproval(
      candidates,
      { scope, environment: deps.serverEnvironment.id, policyVersion: deps.policy.policy.policyVersion },
      {
        now,
        environmentKind: deps.serverEnvironment.kind,
        overrides: deps.policy.policy.config.approvals.minAssurance,
        al3: NO_AL3,
      },
    );
    if (!sel.approval)
      return fail(
        toolError(
          'E_APPROVAL_REQUIRED',
          `${deviceId} is not owned by AutoTest: ${input.action} needs a human approval`,
          [
            `Call request_approval with scope {kind: "device_action", deviceAction: {action: "${APPROVAL_ACTION[input.action]}", deviceId: "${deviceId}"}}, then a human runs autotest approve`,
          ],
          { scopeDigest: scope.digest, reasons: [...sel.reasons] },
        ),
      );
    try {
      const consumed = await ports.approvals.consume(sel.approval.id, now);
      approvalId = consumed.id;
      await ports.audit.append({
        ts: iso(now),
        actor: 'server',
        kind: 'approval.consumed',
        subjectRefs: [consumed.id, deviceId],
        data: { approvalId: consumed.id, uses: consumed.uses },
      });
    } catch (e) {
      if (e instanceof PortError && e.code === 'not_usable')
        return fail(toolError('E_APPROVAL_EXHAUSTED', 'the approval was already used', ['Request a new approval']));
      throw e;
    }
  }

  const out = await perform(ctx, input.action, deviceId);
  if (!out.ok) return fail(outcomeError(out));
  if (owned && input.action === 'delete') await ports.deviceLeases.remove(lease!.id);
  else if (owned && input.action === 'boot')
    await ports.deviceLeases.put({
      ...lease!,
      runId: input.runId ?? lease!.runId,
      expiresAt: iso(new Date(now.getTime() + LEASE_TTL_MS)),
    });
  await audit(deviceId, owned ? 'P1' : 'P2', approvalId);
  return ok({
    action: input.action,
    deviceId,
    owned,
    tierApplied: owned ? 'P1' : 'P2',
    result: out.changed ? 'done' : 'already_in_state',
    leaseId: owned && input.action !== 'delete' ? lease!.id : null,
    state: out.state,
  });
}

/**
 * `autotest cleanup` (DEV-002; operations §5): deletes devices AutoTest created whose lease has expired and that no
 * running run uses, then drops the lease. Devices AutoTest does not own are never touched. `dryRun` only lists them.
 */
export async function cleanupExpiredDevices(
  deps: DeviceDeps,
  o: { readonly dryRun: boolean },
): Promise<{ readonly deviceId: string; readonly result: 'deleted' | 'would_delete' | 'gone' | 'failed' }[]> {
  const ctx = deviceContext(deps);
  if (!ctx) return [];
  const now = deps.ports.clock.now();
  const out: { deviceId: string; result: 'deleted' | 'would_delete' | 'gone' | 'failed' }[] = [];
  for (const lease of await deps.ports.deviceLeases.list()) {
    if (!lease.createdByAutotest || Date.parse(lease.expiresAt) > now.getTime() || (await busy(deps, lease))) continue;
    if (o.dryRun) {
      out.push({ deviceId: lease.deviceId, result: 'would_delete' });
      continue;
    }
    const r = await perform(ctx, 'delete', lease.deviceId);
    const result = r.ok ? 'deleted' : r.reason === 'not_found' ? 'gone' : 'failed';
    if (result !== 'failed') {
      await deps.ports.deviceLeases.remove(lease.id);
      await deps.ports.audit.append({
        ts: iso(deps.ports.clock.now()),
        actor: 'cli',
        kind: 'device.action',
        subjectRefs: [lease.deviceId],
        data: { action: 'delete', deviceId: lease.deviceId, tier: 'P1' },
      });
    }
    out.push({ deviceId: lease.deviceId, result });
  }
  return out;
}

/** The device of a run (FL-006): its lease and the id the runner addresses it by. */
export interface RunDevice {
  readonly deviceId: string;
  readonly platform: 'ios' | 'android';
  /** Simulator UDID, or the emulator serial (`emulator-<port>`). */
  readonly address: string;
  readonly lease: DeviceLease;
}

/**
 * Checks that a run may use `deviceId`: AutoTest owns it (lease), no other unfinished run holds it, and it is
 * booted. Devices the user owns are not used for runs in this version (create and boot an AutoTest device instead).
 */
export async function prepareRunDevice(
  deps: DeviceDeps,
  deviceId: string,
): Promise<{ ok: true; device: RunDevice } | { ok: false; error: ToolError }> {
  const ctx = deviceContext(deps);
  if (!ctx) return { ok: false, error: policyUnavailable() };
  const lease = await deps.ports.deviceLeases.findByDevice(deviceId);
  if (!lease?.createdByAutotest)
    return {
      ok: false,
      error: toolError('E_DEVICE_NOT_OWNED', `${deviceId} is not an AutoTest device`, [
        'Create one with manage_simulator {action: "create"}, boot it, then pass its deviceId',
      ]),
    };
  if (await busy(deps, lease))
    return {
      ok: false,
      error: toolError('E_DEVICE_UNAVAILABLE', `${deviceId} is in use by run ${lease.runId}`, [
        'Wait for that run to end',
      ]),
    };
  const platform = platformOf(deviceId);
  const listing = await listDevices(ctx, platform, deps.hostOs);
  const d = listing.devices.find((x) => x.deviceId === deviceId);
  if (!d || d.state !== 'Booted')
    return {
      ok: false,
      error: toolError('E_DEVICE_UNAVAILABLE', `${deviceId} is ${d ? d.state : 'not found'}`, [
        'Boot it with manage_simulator {action: "boot"}',
      ]),
    };
  const address = platform === 'ios' ? deviceId : await androidSerial(ctx, deviceId);
  if (!address)
    return {
      ok: false,
      error: toolError('E_DEVICE_UNAVAILABLE', `${deviceId} has no running emulator`, ['Boot it again']),
    };
  return { ok: true, device: { deviceId, platform, address, lease } };
}

/** Releases the run binding of a device lease (the device stays AutoTest's until its lease expires). */
export async function releaseRunDevices(
  ports: WorkflowPorts,
  runId: string,
  deviceIds: readonly string[],
): Promise<void> {
  for (const id of deviceIds) {
    const lease = await ports.deviceLeases.findByDevice(id);
    if (lease?.runId === runId) await ports.deviceLeases.put({ ...lease, runId: null });
  }
}
