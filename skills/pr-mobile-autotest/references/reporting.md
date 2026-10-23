# Reporting guide

The report and the verdict are produced by `generate_pr_test_report`. The verdict rules are canonical in `docs/data-model-and-artifacts.md`, under "PR verdict rules". You add only a short narrative, and it is labelled as your interpretation.

## Report structure (rendered by the server)

1. **Header.** PR, plan ID and version, plan hash, verdict and the rule that matched.
2. **Scope and limitations.** Covers what was not inspected, unresolved ambiguities, SDK conflicts, granularity limits, and quarantined evidence.
3. **Requirements and traceability.** A REQ → AC → TC → outcome → evidence table.
4. **Coverage decision.** The decision, its findings, the six metrics, and approvals with their assurance level.
5. **Execution.** Runs, attempts, outcome counts, and planned versus executed. Not-run and blocked cases are listed with their reasons.
6. **Failures.** Each failure is shown with its classification strength and confidence, its observations and alternatives, and the next steps.
7. **Attention.** Flaky tests, non-mandatory failures and expiring exceptions.
8. **Evidence.** Artifact references with hashes. Screenshots and raw logs are local only.
9. **Narrative.** Your summary, marked "agent-written, not verified".

## Wording rules for your narrative and chat summary

| Situation | Say | Never say |
|---|---|---|
| A test with outcome `passed` | "passed" | — |
| `not_run`, `blocked`, `skipped` | "not run (reason)", "blocked (reason)", "skipped" | "passed", "OK" |
| `timed_out`, `infra_error`, `cancelled` | "did not complete (reason)"; the result is inconclusive | "failed because of the product" |
| `product_defect` with strength `supported` | "likely product defect" | "confirmed bug" |
| `product_defect` with strength `hypothesis` | "possible product defect" | "bug" |
| Verdict `inconclusive` | "inconclusive", plus what would resolve it | "pass" |
| Verdict `blocked` | "blocked", plus the human action needed | — |
| Requirement coverage 100% | "all testable requirements have planned tests" | "the PR is fully tested" |

Keep the narrative short. A few sentences:

- what changed
- what was verified
- what failed or was not verified
- the recommended disposition, consistent with the verdict

## Publication (Phase 2)

`publish_github_report` is not available in v0.1 (`E_CAPABILITY_UNAVAILABLE`). When it arrives:

- Publish only when the user asked and the publication is authorized.
- Use `dryRun` to preview.
- The comment is upserted, so republishing updates the same comment.
- The PR receives only the redacted summary and links. Screenshots and logs are never published.
