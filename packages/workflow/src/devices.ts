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
  iosWaitBooted,
  defaultDeviceSpec,
  installApp,
  listDevices,
  matchesRequest,
  platformOf,
  type ListedDevice,
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

/** Usable simulators and emulators (never physical) matching a request and held by no unfinished run; Booted first. */
async function freeDevices(
  deps: DeviceDeps,
  ctx: DeviceContext,
  platform: 'ios' | 'android',
  q: { readonly deviceType?: string; readonly runtime?: string },
): Promise<{ device: ListedDevice; lease: DeviceLease | undefined }[]> {
  const listing = await listDevices(ctx, platform, deps.hostOs);
  const leases = await deps.ports.deviceLeases.list();
  const out: { device: ListedDevice; lease: DeviceLease | undefined }[] = [];
  for (const device of listing.devices) {
    if (device.kind === 'physical' || !device.usable || !matchesRequest(device, q)) continue;
    const lease = leases.find((l) => l.deviceId === device.deviceId);
    if (await busy(deps, lease)) continue;
    out.push({ device, lease });
  }
  const rank = (x: { device: ListedDevice }) => (x.device.state === 'Booted' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.device.deviceId < b.device.deviceId ? -1 : 1));
}

/** Creates an AutoTest device (P1) within `devices.maxOwned` per platform, and records its lease. */
async function createOwned(
  deps: DeviceDeps,
  ctx: DeviceContext,
  platform: 'ios' | 'android',
  spec: { readonly deviceType: string; readonly runtime: string },
  runId: string | undefined,
): Promise<{ ok: true; lease: DeviceLease; state: string } | { ok: false; error: ToolError }> {
  const { ports } = deps;
  const max = deps.policy.ok ? deps.policy.policy.config.devices.maxOwned : 2;
  const owned = (await ports.deviceLeases.list()).filter(
    (l) => l.createdByAutotest && platformOf(l.deviceId) === platform,
  );
  if (owned.length >= max)
    return {
      ok: false,
      error: toolError(
        'E_DEVICE_UNAVAILABLE',
        `AutoTest already owns ${owned.length} ${platform} device(s), the configured maximum (devices.maxOwned)`,
        ['Free one (manage_simulator delete, or `autotest cleanup`), or wait for a run to release one'],
      ),
    };
  const name = `autotest-${ports.ids.newId('dev').slice(4).toLowerCase()}`;
  const out =
    platform === 'ios'
      ? await iosCreate(ctx, name, spec.deviceType, spec.runtime)
      : await androidCreate(ctx, name, spec.deviceType, spec.runtime);
  if (!out.ok) return { ok: false, error: outcomeError(out) };
  const lease: DeviceLease = {
    id: ports.ids.newId('lease'),
    deviceId: out.deviceId,
    runId: runId ?? null,
    owned: true,
    createdByAutotest: true,
    expiresAt: iso(new Date(ports.clock.now().getTime() + LEASE_TTL_MS)),
  };
  await ports.deviceLeases.put(lease);
  return { ok: true, lease, state: out.state };
}

/**
 * `acquire` (B3, 1.4.0): a booted device for a run, creating one only as the last resort.
 * 1. A free AutoTest device matching the request (Booted first, else booted now, P1) → `reused`.
 * 2. A device of the user's that this host already approved for use and whose lease is still valid → `adopted`.
 * 3. A free simulator or AVD of the user's (never a physical device), when `allowAdopt` is not false: it needs a
 *    single-use `use_non_owned` approval; AutoTest then holds a lease on it (not ownership), may boot it and install and
 *    run the app under test, and never erases, deletes or shuts it down on its own → `adopted`.
 * 4. Otherwise a new AutoTest device (the request's type and runtime, or the newest installed defaults), booted,
 *    within `devices.maxOwned` → `created`.
 */
async function acquire(
  deps: DeviceDeps,
  ctx: DeviceContext,
  input: ToolInput<'manage_simulator'>,
  audit: (deviceId: string, tier: 'P1' | 'P2', approvalId?: string) => Promise<unknown>,
): Promise<UseCaseResult<ToolOutput<'manage_simulator'>>> {
  const q = input.acquire!;
  const { ports } = deps;
  if (q.platform === 'ios' && deps.hostOs !== 'macos')
    return fail(toolError('E_CAPABILITY_UNAVAILABLE', 'iOS simulators need macOS', []));
  const now = ports.clock.now();
  const finish = async (
    device: { deviceId: string; state: string },
    lease: DeviceLease,
    result: 'reused' | 'adopted' | 'created',
    approvalId?: string,
  ): Promise<UseCaseResult<ToolOutput<'manage_simulator'>>> => {
    let state = device.state;
    if (state !== 'Booted') {
      const b = await perform(ctx, 'boot', device.deviceId);
      if (!b.ok) return fail(outcomeError(b));
      state = b.state;
    } else if (q.platform === 'ios') {
      // Listed as Booted is not yet ready to run apps when someone just booted it.
      const w = await iosWaitBooted(ctx, device.deviceId);
      if (!w.ok) return fail(outcomeError(w));
    }
    const kept = {
      ...lease,
      runId: input.runId ?? lease.runId,
      expiresAt: iso(new Date(now.getTime() + LEASE_TTL_MS)),
    };
    await ports.deviceLeases.put(kept);
    await audit(device.deviceId, lease.createdByAutotest ? 'P1' : 'P2', approvalId);
    return ok({
      action: 'acquire',
      deviceId: device.deviceId,
      owned: lease.createdByAutotest,
      tierApplied: lease.createdByAutotest ? 'P1' : 'P2',
      result,
      leaseId: kept.id,
      state,
    });
  };

  const free = await freeDevices(deps, ctx, q.platform, q);
  const owned = free.find((x) => x.lease?.createdByAutotest);
  if (owned) return finish(owned.device, owned.lease!, 'reused');
  const approved = free.find(
    (x) => x.lease && !x.lease.createdByAutotest && Date.parse(x.lease.expiresAt) > now.getTime(),
  );
  if (approved) return finish(approved.device, approved.lease!, 'adopted');

  const candidate = q.allowAdopt === false ? undefined : free.find((x) => !x.lease);
  if (candidate) {
    const deviceId = candidate.device.deviceId;
    const scope = deviceActionScope({ action: 'use_non_owned', deviceId, hostId: deps.serverEnvironment.id });
    const sel = selectApproval(
      await ports.approvals.listByScopeDigest(scope.digest),
      {
        scope,
        environment: deps.serverEnvironment.id,
        policyVersion: deps.policy.ok ? deps.policy.policy.policyVersion : '',
      },
      {
        now,
        environmentKind: deps.serverEnvironment.kind,
        overrides: deps.policy.ok ? deps.policy.policy.config.approvals.minAssurance : {},
        al3: NO_AL3,
      },
    );
    if (!sel.approval)
      return fail(
        toolError(
          'E_APPROVAL_REQUIRED',
          `${deviceId} (${candidate.device.name}) is the user's device: using it for runs needs a human approval`,
          [
            `Call request_approval with scope {kind: "device_action", deviceAction: {action: "use_non_owned", deviceId: "${deviceId}"}}, then a human runs autotest approve`,
            'If the user declines, call acquire again with allowAdopt: false to create an AutoTest device instead',
          ],
          { scopeDigest: scope.digest, deviceId, reasons: [...sel.reasons] },
        ),
      );
    let consumed: { id: string; uses: number };
    try {
      consumed = await ports.approvals.consume(sel.approval.id, now);
    } catch (e) {
      if (e instanceof PortError && e.code === 'not_usable')
        return fail(toolError('E_APPROVAL_EXHAUSTED', 'the approval was already used', ['Request a new approval']));
      throw e;
    }
    await ports.audit.append({
      ts: iso(now),
      actor: 'server',
      kind: 'approval.consumed',
      subjectRefs: [consumed.id, deviceId],
      data: { approvalId: consumed.id, uses: consumed.uses },
    });
    const approvalId = consumed.id;
    const lease: DeviceLease = {
      id: ports.ids.newId('lease'),
      deviceId,
      runId: input.runId ?? null,
      owned: false,
      createdByAutotest: false,
      expiresAt: iso(new Date(now.getTime() + LEASE_TTL_MS)),
    };
    return finish(candidate.device, lease, 'adopted', approvalId);
  }

  const defaults = q.deviceType && q.runtime ? undefined : await defaultDeviceSpec(ctx, q.platform);
  const deviceType = q.deviceType ?? defaults?.deviceType;
  const runtime = q.runtime ?? defaults?.runtime;
  if (!deviceType || !runtime)
    return fail(
      toolError('E_DEVICE_UNAVAILABLE', `no free ${q.platform} device, and no installed runtime to create one from`, [
        q.platform === 'ios' ? 'Install an iOS simulator runtime in Xcode' : 'Install a system image with sdkmanager',
      ]),
    );
  const made = await createOwned(deps, ctx, q.platform, { deviceType, runtime }, input.runId);
  if (!made.ok) return fail(made.error);
  return finish({ deviceId: made.lease.deviceId, state: made.state }, made.lease, 'created');
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
  // AutoTest devices, and user devices approved for use (`acquire` → adopted, B3).
  if (!d.owned && !d.lease)
    return fail(
      toolError('E_DEVICE_NOT_OWNED', `${d.deviceId} is neither an AutoTest device nor approved for use`, [
        'Use manage_simulator {action: "acquire"} to get a device',
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

  if (input.action === 'acquire') return acquire(deps, ctx, input, audit);
  if (input.action === 'create') {
    const c = input.create!;
    if (c.platform === 'ios' && deps.hostOs !== 'macos')
      return fail(toolError('E_CAPABILITY_UNAVAILABLE', 'iOS simulators need macOS', []));
    // B3: idempotent — a free AutoTest device of this type and runtime is returned instead of a new one.
    const reuse = (await freeDevices(deps, ctx, c.platform, c)).find((x) => x.lease?.createdByAutotest);
    if (reuse)
      return ok({
        action: 'create',
        deviceId: reuse.device.deviceId,
        owned: true,
        tierApplied: 'P1',
        result: 'reused',
        leaseId: reuse.lease!.id,
        state: reuse.device.state,
      });
    const made = await createOwned(deps, ctx, c.platform, c, input.runId);
    if (!made.ok) return fail(made.error);
    await audit(made.lease.deviceId, 'P1');
    return ok({
      action: 'create',
      deviceId: made.lease.deviceId,
      owned: true,
      tierApplied: 'P1',
      result: 'done',
      leaseId: made.lease.id,
      state: made.state,
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
    if (Date.parse(lease.expiresAt) > now.getTime() || (await busy(deps, lease))) continue;
    // An expired lease on a user device (B3): only the record goes; the device is never touched.
    if (!lease.createdByAutotest) {
      if (!o.dryRun) await deps.ports.deviceLeases.remove(lease.id);
      continue;
    }
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
  // An AutoTest device, or a user device approved for use whose lease is still valid (B3).
  const adoptedValid =
    lease !== undefined && !lease.createdByAutotest && Date.parse(lease.expiresAt) > deps.ports.clock.now().getTime();
  if (!lease?.createdByAutotest && !adoptedValid)
    return {
      ok: false,
      error: toolError('E_DEVICE_NOT_OWNED', `${deviceId} is neither an AutoTest device nor approved for use`, [
        'Get one with manage_simulator {action: "acquire"}, then pass its deviceId',
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

/**
 * Releases the run binding of a device lease: an AutoTest device stays AutoTest's until its lease expires; the lease
 * on an adopted user device ends with the run (B3), so the next run asks again.
 */
export async function releaseRunDevices(
  ports: WorkflowPorts,
  runId: string,
  deviceIds: readonly string[],
): Promise<void> {
  for (const id of deviceIds) {
    const lease = await ports.deviceLeases.findByDevice(id);
    if (lease?.runId !== runId) continue;
    if (lease.createdByAutotest) await ports.deviceLeases.put({ ...lease, runId: null });
    else await ports.deviceLeases.remove(lease.id);
  }
}
