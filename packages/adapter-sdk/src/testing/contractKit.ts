/**
 * Adapter contract test kit (ADP-001; ADR-0009 §5; platform-adapters §Capability model). Every adapter runs these
 * cases in its own test suite. They check:
 * - identity and capability shape;
 * - determinism of detect, capabilities, inventory, buildExecution, evidence hints and parsing (same input → same
 *   output, also from a fresh adapter instance);
 * - ExecutionSpec validity against the contract and, through an injected validator, against policy argument
 *   schemas (adapters may not import policy; `packages/execution` runs the kit with the real validator);
 * - robust parsing: truncated, malformed, empty, missing and oversized outputs never throw and yield valid results;
 * - unknown runner states map to `infra_error` with a diagnostic;
 * - contained run-dir paths and idempotent cleanup.
 * Cases are framework-agnostic `{ name, run }` objects that throw on failure.
 */
import assert from 'node:assert/strict';
import { canonicalize, ExecutionSpec, TestOutcome, TestTarget } from '@autotest/core';
import { CapabilitySetSchema } from '../capabilities.ts';
import type {
  DetectContext,
  ExecutionRequest,
  InventoryContext,
  NormalizedResult,
  PlatformAdapter,
  RunnerOutputs,
} from '../types.ts';

export interface KitCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface KitFixtures {
  /** A context in which the adapter detects its project. */
  readonly detect: DetectContext;
  readonly inventory: InventoryContext;
  readonly requests: readonly ExecutionRequest[];
  /** Representative valid outputs for one attempt. */
  readonly outputs: RunnerOutputs;
  /** Outputs containing a runner state the adapter does not know (optional but recommended). */
  readonly unknownStateOutputs?: RunnerOutputs;
}

export interface KitOptions {
  /** Validates a spec against policy (argument schemas, paths). Supplied by a package allowed to import policy. */
  readonly validateSpec?: (spec: ExecutionSpec) => { readonly ok: boolean; readonly detail?: string };
}

const same = (a: unknown, b: unknown, what: string) =>
  assert.equal(canonicalize(a), canonicalize(b), `${what} is not deterministic`);
const REL = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\\]{1,1024}$/;

function checkResult(r: NormalizedResult, what: string): void {
  assert.ok(TestOutcome.safeParse(r.outcome).success, `${what}: invalid outcome`);
  assert.equal(typeof r.targetId, 'string', `${what}: targetId`);
  assert.ok(r.name.length > 0 && r.name.length <= 500, `${what}: name length`);
  assert.ok(r.rawStatus.length <= 64, `${what}: rawStatus length`);
  if (r.messageExcerpt !== undefined) assert.ok(r.messageExcerpt.length <= 2048, `${what}: messageExcerpt length`);
  if (r.outcome === 'blocked') assert.ok(r.blockedReason, `${what}: blocked needs blockedReason`);
}

function mutateFiles(o: RunnerOutputs, f: (text: string) => string | undefined): RunnerOutputs {
  return {
    ...o,
    files: Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, v === undefined ? undefined : f(v)])),
  };
}

export function adapterContractCases(
  make: () => PlatformAdapter,
  fx: KitFixtures,
  options: KitOptions = {},
): KitCase[] {
  const parseSafely = (a: PlatformAdapter, o: RunnerOutputs, what: string) => {
    let res;
    try {
      res = a.parseResults(o);
    } catch (e) {
      assert.fail(`parseResults threw on ${what}: ${(e as Error).message}`);
    }
    res.results.forEach((r, i) => checkResult(r, `${what} result ${i}`));
    return res;
  };

  return [
    {
      name: 'adapter kit: identity and capabilities are well-formed and deterministic',
      run: async () => {
        const a = make();
        assert.match(a.id, /^[a-z][a-z0-9-]{1,30}$/);
        assert.match(a.version, /^\d+\.\d+\.\d+/);
        const c1 = await a.capabilities(fx.detect);
        const parsed = CapabilitySetSchema.safeParse(c1);
        assert.ok(parsed.success, `capabilities invalid: ${parsed.success ? '' : parsed.error.message}`);
        same(c1, await make().capabilities(fx.detect), 'capabilities');
      },
    },
    {
      name: 'adapter kit: detect reports evidence and is deterministic',
      run: async () => {
        const a = make();
        const d = await a.detect(fx.detect);
        assert.equal(d.adapterId, a.id);
        assert.ok(d.confidence >= 0 && d.confidence <= 1, 'confidence in [0, 1]');
        assert.ok(d.detected, 'fixture should be detected');
        assert.ok(d.evidence.length > 0, 'detection needs evidence (FR-006)');
        for (const e of d.evidence) assert.match(e, REL, 'evidence must be workspace-relative');
        for (const p of d.platforms)
          if (p.status === 'present') assert.ok(p.evidence.length > 0, 'present platform needs evidence');
        same(d, await make().detect(fx.detect), 'detect');
      },
    },
    {
      name: 'adapter kit: inventory targets are valid, unique, owned and deterministic',
      run: async () => {
        const a = make();
        const inv = await a.inventory(fx.inventory);
        assert.equal(inv.adapterId, a.id);
        const ids = new Set<string>();
        for (const t of inv.targets) {
          const ok = TestTarget.safeParse(t);
          assert.ok(ok.success, `invalid target ${t.id}`);
          assert.equal(t.adapterId, a.id);
          assert.match(t.path, REL);
          assert.ok(!ids.has(t.id), `duplicate target id ${t.id}`);
          ids.add(t.id);
        }
        same(inv, await make().inventory(fx.inventory), 'inventory');
      },
    },
    {
      name: 'adapter kit: buildExecution is deterministic and every spec is valid',
      run: async () => {
        for (const req of fx.requests) {
          const first = make().buildExecution(req);
          same(first, make().buildExecution(req), 'buildExecution (fresh instance)');
          const a = make();
          same(a.buildExecution(req), a.buildExecution(req), 'buildExecution (same instance)');
          assert.ok(first.length > 0, 'at least one spec');
          for (const spec of first) {
            const parsed = ExecutionSpec.safeParse(spec);
            assert.ok(parsed.success, `spec violates the contract: ${parsed.success ? '' : parsed.error.message}`);
            for (const o of spec.expectedOutputs)
              assert.ok(
                o.rel.startsWith(`attempts/${req.attemptNo}/`),
                `expected output outside the attempt dir: ${o.rel}`,
              );
            if (options.validateSpec) {
              const v = options.validateSpec(spec);
              assert.ok(v.ok, `spec denied by policy: ${v.detail ?? ''}`);
            }
          }
        }
      },
    },
    {
      name: 'adapter kit: parsing is total — truncated, malformed, empty, missing and oversized outputs never throw',
      run: async () => {
        const a = make();
        const good = parseSafely(a, fx.outputs, 'valid outputs');
        same(good, make().parseResults(fx.outputs), 'parseResults');
        parseSafely(
          a,
          mutateFiles(fx.outputs, (t) => t.slice(0, Math.floor(t.length / 2))),
          'truncated outputs',
        );
        parseSafely(
          a,
          mutateFiles(fx.outputs, (t) => t.replace(/[{}":,\s]/g, '#')),
          'malformed outputs',
        );
        parseSafely(
          a,
          mutateFiles(fx.outputs, () => ''),
          'empty outputs',
        );
        parseSafely(
          a,
          mutateFiles(fx.outputs, () => undefined),
          'missing outputs',
        );
        parseSafely(
          a,
          mutateFiles(fx.outputs, () => '\u0000￿\ud800'.repeat(1000)),
          'binary-like outputs',
        );
        parseSafely(
          a,
          mutateFiles(fx.outputs, () => `${'x'.repeat(4096)}\n`.repeat(1500)),
          'oversized outputs',
        );
        parseSafely(a, { ...fx.outputs, interrupted: true, processes: [{ signal: 'SIGKILL' }] }, 'interrupted attempt');
      },
    },
    {
      name: 'adapter kit: unknown runner states become infra_error with a diagnostic',
      run: async () => {
        if (!fx.unknownStateOutputs) return;
        const res = parseSafely(make(), fx.unknownStateOutputs, 'unknown-state outputs');
        assert.ok(
          res.results.some((r) => r.outcome === 'infra_error'),
          'expected an infra_error result',
        );
        assert.ok(res.diagnostics.length > 0, 'expected a diagnostic');
      },
    },
    {
      name: 'adapter kit: evidence hints, failure signals and cleanup are contained, total and idempotent',
      run: async () => {
        const a = make();
        const hints = a.evidenceHints(fx.outputs);
        same(hints, make().evidenceHints(fx.outputs), 'evidenceHints');
        for (const h of hints)
          assert.ok(
            h.rel.startsWith(`attempts/${fx.outputs.attemptNo}/`) && REL.test(h.rel),
            `hint outside the attempt dir: ${h.rel}`,
          );
        const parsed = a.parseResults(fx.outputs);
        const signals = a.failureSignals(parsed.results, fx.outputs);
        for (const s of signals) assert.ok(s.evidence.length <= 500, 'signal evidence must be short');
        if (a.cleanupSpecs) {
          const c1 = a.cleanupSpecs({ attemptNo: 1 });
          same(c1, a.cleanupSpecs({ attemptNo: 1 }), 'cleanupSpecs');
          for (const spec of c1) assert.ok(ExecutionSpec.safeParse(spec).success, 'cleanup spec violates the contract');
        }
      },
    },
  ];
}
