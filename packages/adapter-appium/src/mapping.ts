/**
 * Scenario discovery and the scenario-to-spec mapping (APM-001, APM-002; RL-A09 – A13). Read statically: scenario
 * names come from a JSON list (`["name", …]`) or from the `case "name":` labels of a scenario registry (Autotrader's
 * `integration_test/src/scenario.ts`); spec documents are matched to scenarios by name, ignoring case and separators,
 * so `verifyBackArrowButtonFiltertoSRP` maps to `verify-back-arrow-button-filter-to-srp.md`.
 */

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,99}$/;

/** Scenario names from a registry's `case "…":` labels, in order of appearance, without duplicates. */
export function scenariosFromRegistry(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bcase\s+(["'`])([A-Za-z][A-Za-z0-9_-]{0,99})\1\s*:/g))
    if (!out.includes(m[2]!)) out.push(m[2]!);
  return out;
}

/** Scenario names from a JSON list (strings, or objects with a `name`). Invalid entries are skipped. */
export function scenariosFromList(json: string): string[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const items = Array.isArray(v)
    ? v
    : Array.isArray((v as { scenarios?: unknown })?.scenarios)
      ? (v as { scenarios: unknown[] }).scenarios
      : [];
  const out: string[] = [];
  for (const it of items) {
    const name =
      typeof it === 'string'
        ? it
        : typeof (it as { name?: unknown })?.name === 'string'
          ? (it as { name: string }).name
          : '';
    if (NAME.test(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** `verifyVDPBackButton` → `verify-vdp-back-button`. */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface SpecMapping {
  /** Scenario → workspace-relative spec document. */
  readonly mapped: ReadonlyMap<string, string>;
  readonly unmappedScenarios: readonly string[];
  /** Spec documents no scenario maps to. */
  readonly orphanSpecs: readonly string[];
}

/** Maps scenarios to spec documents (`<dir>/**\/<kebab-name>.md`) by normalized name. */
export function mapScenariosToSpecs(scenarios: readonly string[], specFiles: readonly string[]): SpecMapping {
  const byKey = new Map<string, string>();
  for (const f of [...specFiles].sort()) {
    const base = f.slice(f.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    if (/^readme$/i.test(base)) continue;
    if (!byKey.has(key(base))) byKey.set(key(base), f);
  }
  const mapped = new Map<string, string>();
  for (const s of scenarios) {
    const f = byKey.get(key(s));
    if (f) mapped.set(s, f);
  }
  const used = new Set(mapped.values());
  return {
    mapped,
    unmappedScenarios: scenarios.filter((s) => !mapped.has(s)),
    orphanSpecs: [...byKey.values()].filter((f) => !used.has(f)),
  };
}
