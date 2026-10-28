/**
 * Capability schema and eligibility (ADP-001; FR-014; platform-adapters §Capability model). A target is eligible
 * only when its level is supported, its host requirement is met, its device need is available and its executable
 * is allowlisted and present. Eligibility never assumes parity between platforms.
 */
import { z } from 'zod';
import {
  DeviceNeed,
  HostRequirement,
  SelectorKind,
  TestLevel,
  type Eligibility,
  type TestTarget,
} from '@autotest/core';
import type { CapabilitySet } from './types.ts';

export const CapabilitySetSchema = z.strictObject({
  levels: z.array(TestLevel).min(1),
  host: z.strictObject({ requires: HostRequirement, available: z.boolean(), reason: z.string().max(300).optional() }),
  devices: z.strictObject({ needs: DeviceNeed, available: z.boolean() }),
  selection: z.array(SelectorKind).min(1),
  resultFormats: z.array(z.string().min(1).max(64)).min(1),
  // 'scenario' (APM-001): one result per Appium scenario, from its exit code.
  resultGranularity: z.enum(['test', 'file', 'scenario']),
  cancellation: z.enum(['process_group', 'graceful_then_group']),
  coverage: z.boolean(),
  limitations: z.array(z.string().max(300)).max(50),
});

export interface EligibilityInputs {
  readonly capabilities: CapabilitySet;
  /** The OS this server runs on. */
  readonly hostOs: 'macos' | 'linux' | 'windows';
  /** Whether the target's logical executable is allowlisted and resolved by policy. */
  readonly executableAvailable: boolean;
  /** Whether a device of the needed kind is available to the run (ignored for `device: none`). */
  readonly deviceAvailable?: boolean;
}

/** FR-014 eligibility; the first failing condition decides the reason. */
export function eligibilityOf(target: TestTarget, inputs: EligibilityInputs): Eligibility {
  const c = inputs.capabilities;
  if (!c.levels.includes(target.level)) return 'ineligible:capability_missing';
  if (!c.host.available) return 'ineligible:platform_unavailable';
  if (target.requires.host !== 'any' && target.requires.host !== inputs.hostOs)
    return 'ineligible:platform_unavailable';
  if (target.requires.device !== 'none' && !(c.devices.available && (inputs.deviceAvailable ?? false)))
    return 'ineligible:platform_unavailable';
  if (!inputs.executableAvailable) return 'ineligible:policy_denied';
  return 'eligible';
}
