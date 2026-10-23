# Coverage gate: how to read and respond

The gate rules are defined in `docs/test-planning-and-coverage.md` in the Mobile AutoTest MCP repository, which is the canonical source. This page explains how to *respond* to each result. It does not redefine the rules.

## What the decision means

| Decision | Meaning | What you do |
|---|---|---|
| `pass` | The plan meets the coverage criteria for this exact plan hash. | Continue to `run_tests`. A `pass` does **not** authorize execution. `run_tests` still checks policy and approvals. |
| `needs_review` | No blockers, but a human must review the plan before it can execute. | Explain the review findings, then call `request_approval` (kind `plan_execution`). Wait for the human. |
| `fail` | At least one blocker. | Do not run. Explain the blockers and propose fixes. A `fail` cannot be approved. Only a revised plan can pass. |

A decision is valid only for the exact `planHash`, requirement set and gate policy version it was made for. If the response says `current: false`, or a later call returns `E_COVERAGE_STALE`, validate again.

## Responding to blockers (GB)

| Rule | Typical fix |
|---|---|
| GB-01 uncovered requirement | Add a case for it, or propose a justified exception for a human to approve. |
| GB-02 invalid exception | Add a rationale or evidence link, get it approved, or remove the exception. An exception marked `covered_elsewhere` must link to a real test target. |
| GB-03 R3 missing error-handling, security or data-integrity cases | Add those cases. |
| GB-04 R2/R3 missing a regression case | Add a regression case that covers the existing behavior next to the change. |
| GB-05 an acceptance criterion of an R2/R3 requirement has no case | Map a case to that criterion. |
| GB-06 R2/R3 has no eligible case | Find an existing test that can run, or tell the human that the change cannot be verified automatically yet. Do not reduce the risk factors just to get past the gate. |
| GB-07 platform gap on R2/R3 | Add cases for each platform in scope, or narrow `platformsInScope` only if the PR really is limited to fewer platforms. |
| GB-08 structural | Fix dangling references or dependency cycles. |

## Responding to review triggers (GR)

| Rule | What to tell the human |
|---|---|
| GR-01 | An open high-severity ambiguity. Ask for clarification. |
| GR-02 | Weak assertions. Rewrite the expected results so each one names something observable. |
| GR-03 | Duplicate cases. Merge them. |
| GR-04 | A threshold was missed. Name the metric and its value. |
| GR-05 | An R0/R1 requirement has no eligible test. |
| GR-06 | A mandatory case needs a new or manual test. |
| GR-07 | An R3 requirement is present. Review is always required. |
| GR-08 | An assumption affects a high-risk requirement. |
| GR-09 | The regression scope may miss changed areas. |

## Metrics

The gate reports six separate metrics: requirement, test-case, source-code, platform, regression and execution coverage.

- Never present one metric in place of another. For example, do not present source-code coverage as requirement coverage.
- `null` means "not applicable" or "not available". It does not mean 100%.
