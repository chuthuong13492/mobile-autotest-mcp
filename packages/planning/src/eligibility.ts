/**
 * Per-case eligibility (PLN-005; FR-014; ADR-0009). A case is eligible only when it is automated, resolves to an
 * inventory target, the workspace may be executed in, the target's adapter supports its level, the host and device
 * requirements are met, the target covers one of the case's platforms in scope, and the executable is allowlisted.
 * The first failing condition decides the reason; parity between platforms is never assumed.
 *
 * `planning` may not import `adapter-sdk` (boundaries.json), so capabilities arrive as the structural
 * {@link CapabilityView} subset.
 */
import type { Automation, Eligibility, Platform, TestLevel, TestTarget } from '@autotest/core';

export interface CapabilityView {
  readonly levels: readonly TestLevel[];
  readonly host: { readonly available: boolean };
  readonly devices: { readonly available: boolean };
}

export interface EligibilityContext {
  /** Capabilities of the target's adapter, or undefined when that adapter is not available. */
  readonly capabilities: CapabilityView | undefined;
  readonly hostOs: 'macos' | 'linux' | 'windows';
  readonly executableAvailable: boolean;
  readonly deviceAvailable: boolean;
  /** `readOnlyReference` workspaces are inspection-only: nothing in them is eligible. */
  readonly readOnlyReference: boolean;
  readonly platformsInScope: readonly Platform[];
}

export interface EligibilityCase {
  readonly automation: Automation;
  readonly platforms: readonly Platform[];
}

export function eligibility(c: EligibilityCase, target: TestTarget | undefined, ctx: EligibilityContext): Eligibility {
  if (c.automation === 'manual') return 'ineligible:manual';
  if (c.automation === 'new_test_required' || !target) return 'ineligible:no_target';
  if (ctx.readOnlyReference) return 'ineligible:policy_denied';
  if (!ctx.capabilities || !ctx.capabilities.levels.includes(target.level)) return 'ineligible:capability_missing';
  if (!ctx.capabilities.host.available) return 'ineligible:platform_unavailable';
  if (target.requires.host !== 'any' && target.requires.host !== ctx.hostOs) return 'ineligible:platform_unavailable';
  if (target.requires.device !== 'none' && !(ctx.capabilities.devices.available && ctx.deviceAvailable))
    return 'ineligible:platform_unavailable';
  const wanted = c.platforms.filter((p) => ctx.platformsInScope.includes(p));
  if (!target.platforms.some((p) => wanted.includes(p))) return 'ineligible:platform_unavailable';
  if (!ctx.executableAvailable) return 'ineligible:policy_denied';
  return 'eligible';
}
