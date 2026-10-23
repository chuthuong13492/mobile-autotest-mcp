import { describe, expect, it } from 'vitest';
import type { TestTarget } from '@autotest/core';
import { eligibility, type EligibilityContext } from '@autotest/planning';

const target: TestTarget = {
  id: 'TT-flutter-1a2b3c4d5e6f',
  adapterId: 'flutter',
  level: 'widget',
  path: 'test/a_test.dart',
  platforms: ['host'],
  requires: { host: 'any', device: 'none' },
  tags: [],
};
const ctx: EligibilityContext = {
  capabilities: { levels: ['unit', 'widget'], host: { available: true }, devices: { available: false } },
  hostOs: 'linux',
  executableAvailable: true,
  deviceAvailable: false,
  readOnlyReference: false,
  platformsInScope: ['host'],
};
const auto = { automation: 'existing_test' as const, platforms: ['host' as const] };

describe('PLN-005 eligibility', () => {
  const fixtures: [string, Parameters<typeof eligibility>][] = [
    ['eligible', [auto, target, ctx]],
    ['ineligible:manual', [{ ...auto, automation: 'manual' }, target, ctx]],
    ['ineligible:no_target', [{ ...auto, automation: 'new_test_required' }, target, ctx]],
    ['ineligible:no_target', [auto, undefined, ctx]],
    ['ineligible:policy_denied', [auto, target, { ...ctx, readOnlyReference: true }]],
    ['ineligible:capability_missing', [auto, target, { ...ctx, capabilities: undefined }]],
    ['ineligible:capability_missing', [auto, { ...target, level: 'e2e' }, ctx]],
    [
      'ineligible:platform_unavailable',
      [auto, target, { ...ctx, capabilities: { ...ctx.capabilities!, host: { available: false } } }],
    ],
    ['ineligible:platform_unavailable', [auto, { ...target, requires: { host: 'macos', device: 'none' } }, ctx]],
    ['ineligible:platform_unavailable', [auto, { ...target, requires: { host: 'any', device: 'simulator' } }, ctx]],
    [
      'ineligible:platform_unavailable',
      [{ ...auto, platforms: ['ios'] }, target, { ...ctx, platformsInScope: ['ios'] }],
    ],
    ['ineligible:policy_denied', [auto, target, { ...ctx, executableAvailable: false }]],
  ];
  for (const [expected, args] of fixtures)
    it(`${expected} (${fixtures.findIndex((f) => f[1] === args)})`, () => expect(eligibility(...args)).toBe(expected));

  it('has a fixture for every eligibility reason', () => {
    const reasons = new Set(fixtures.map(([e]) => e));
    for (const r of ['manual', 'no_target', 'policy_denied', 'capability_missing', 'platform_unavailable'])
      expect(reasons.has(`ineligible:${r}`)).toBe(true);
  });
});
