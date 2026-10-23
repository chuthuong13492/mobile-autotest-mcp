/**
 * Untrusted-field labelling (MCP-002; mcp-tool-contracts §2.2; SR-006, T-01). Every output field that carries
 * repository, PR or runner text is listed in `untrustedFields` as a JSON pointer (`*` matches any array index).
 * The registry is the minimum per tool (docs-sync tested against the contract examples); use cases may add more.
 */
import type { ToolName } from '@autotest/core';

export const UNTRUSTED_POINTERS: Partial<Readonly<Record<ToolName, readonly string[]>>> = {
  get_pr_context: ['/title', '/body'],
  inspect_test_inventory: ['/targets/*/path'],
  extract_requirements: ['/requirements/*/title'],
  generate_test_plan: ['/testCases/*/title'],
  get_run_results: ['/results/*/name', '/results/*/messageExcerpt'],
  collect_test_evidence: ['/artifacts/*/excerpt'],
};

/** Merges the registry pointers into `untrustedFields` when the output has that field. */
export function labelUntrusted(tool: ToolName, output: Record<string, unknown>): Record<string, unknown> {
  const required = UNTRUSTED_POINTERS[tool];
  if (!required || !Array.isArray(output['untrustedFields'])) return output;
  const merged = [...new Set([...(output['untrustedFields'] as string[]), ...required])];
  return { ...output, untrustedFields: merged };
}

/** True when `pointer` (concrete, e.g. `/results/3/name`) is covered by any pattern. */
export function isUntrusted(pointer: string, patterns: readonly string[]): boolean {
  const segs = pointer.split('/');
  return patterns.some((p) => {
    const ps = p.split('/');
    return ps.length <= segs.length && ps.every((s, i) => s === '*' || s === segs[i]);
  });
}
