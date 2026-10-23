/**
 * Tool descriptions shown to MCP clients: the "Purpose" line of each tool in docs/mcp-tool-contracts.md, verbatim
 * (docs-sync tested). Descriptions are advisory text for the agent; enforcement never depends on them.
 */
import type { ToolName } from '@autotest/core';

export const TOOL_DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  get_pr_context: 'Produce a normalized `PRContext` from manual input or from a GitHub/GHES PR.',
  inspect_project:
    'Detect frameworks, platforms, languages, toolchains and runners, each with confidence and evidence.',
  inspect_test_inventory:
    'Discover test targets, helpers, fixtures, mocks and automation configs, reporting completeness.',
  extract_requirements:
    "Create a persisted `RequirementSet` by deterministically parsing the PR body and merging the agent's proposed requirements, ambiguities and assumptions.",
  generate_test_plan:
    'Validate, normalize and enrich the agent-drafted plan, then persist it as an immutable version with a canonical hash.',
  validate_test_coverage:
    'Evaluate the persisted plan against the persisted requirements using the independent gate. Persist a decision bound to the plan hash.',
  request_approval:
    'Open an approval request for a precise scope. Tell the human how to approve it. Optionally offer MCP elicitation.',
  get_approval_status:
    'Report the status of an approval request or approval, and whether it is usable now for a given scope.',
  run_tests: 'Authorize execution of eligible plan targets and create an asynchronous run.',
  get_run_status: 'Return the current state and progress of a run.',
  get_run_results: 'Paged per-test results of a run.',
  cancel_test_run: 'Request cancellation of a run with verified termination.',
  list_devices:
    'Enumerate simulators, emulators and connected devices, with availability and ownership. Report host capability.',
  manage_simulator: 'Perform approved lifecycle actions on simulators and emulators.',
  collect_test_evidence:
    "List a run's artifacts with integrity metadata, and optionally return bounded, redacted excerpts.",
  analyze_test_failures:
    'Classify failed and indeterminate results using rule-based signals, with evidence and conservative confidence.',
  generate_pr_test_report: 'Render the report (Markdown, JSON, JUnit) and compute the PR verdict.',
  publish_github_report:
    'Publish a generated report to GitHub, but only with P3 authorization. The publication is idempotent and least-privilege.',
};
