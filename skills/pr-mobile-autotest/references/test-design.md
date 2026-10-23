# Test design guide (for drafting requirements and plans)

This guide is operational. The canonical rules live in `docs/test-planning-and-coverage.md` in the Mobile AutoTest MCP repository. If anything here conflicts with that document or with a tool response, the document or the tool response wins.

## Requirements and acceptance criteria

- **Start from the PR's own structure.** The server already parses checklists, "Acceptance criteria" sections, Given/When/Then blocks and `AC:` lines. When you add a requirement, copy the PR's wording exactly, so the server can merge your entry with the parsed one instead of creating a duplicate.
- **One requirement, one behavior.** Use `kind`:
  - `functional` for new behavior
  - `behavior_change` for altered behavior
  - `bug_fix` for corrected behavior
  - `non_functional` for performance, accessibility and similar qualities
  - `regression_scope` for areas that must not change
- **Acceptance criteria must be observable.** Name the exact UI text, state, value or navigation. Avoid "works", "correctly" and "as expected".
- **Untestable requirements.** If you cannot test a requirement, set `testable: false` and give the reason. Do not hide it.
- **Ambiguities.** Record them honestly, using these types: `missing_ac`, `vague_term`, `conflicting_statements`, `undefined_platform_scope`, `unspecified_error_behavior`, `unspecified_data`, `unknown_baseline`. An open high-severity ambiguity sends the plan to `needs_review`. That is intended: it brings a human in.

## Risk factors

Give your honest estimates. The server computes the tier. If you omit a factor, a conservative default is used, which usually raises the tier.

| Factor | Scale | Note |
|---|---|---|
| `functionalImpact` | 1–4 | 4 = critical or blocking |
| `securityPrivacyImpact` | 1–4 | 3 = touches PII or auth; 4 = can expose credentials or payments |
| `dataIntegrityImpact` | 1–4 | Includes financial impact |
| `criticalJourney` | true / false | e.g. login, search, contact dealer, checkout |
| `regressionLikelihood` | 1–4 | |
| `changeSurface` | 1–3 | Local, module, or shared component |
| `uncertainty` | 1–3 | |
| `platformSpecificity` | 1–2 | |

Tiers run from R0 to R3. Any R3 requirement always needs human review of the plan.

## Choosing test cases

1. **Reuse existing tests first.** Take `targetPath` values from `inspect_test_inventory`. Never invent paths. If no suitable test exists, use `automation: "new_test_required"`. This makes the case ineligible to run now, and the report lists it as a gap.
2. **Required techniques per tier.** These are enforced by the gate.

   | Tier | Required |
   |---|---|
   | All | A `positive` case for each acceptance criterion |
   | R1 | `negative`/`boundary` cases when the criterion involves validation, ranges or an empty/zero state |
   | R2+ | Every criterion covered; at least one `regression` case; at least one `negative` or `error_handling` case; every in-scope platform covered |
   | R3 | Also `error_handling`; `security` when security/privacy impact ≥ 3; data-integrity boundary or error cases when data-integrity impact ≥ 3 |

3. **Add other techniques only when they apply.** These are `state_transition`, `accessibility` (UI changes), and `platform_specific` (behavior differs by platform). Do not pad the plan.
4. **Priority.**
   - `must`: needed to verify a criterion. Must cases of R2 and R3 are mandatory for the verdict.
   - `should`: valuable coverage beyond that.
   - `could`: optional extras.
5. **Steps and expected results.**
   - Keep steps concrete.
   - Give each expected result one observable outcome.
   - Use the PR's terms.
6. **Platforms.** List only the platforms where the case runs. Host-only Flutter unit and widget tests use `host`.
7. **Exceptions.** You may propose exceptions (`not_testable`, `covered_elsewhere`, `deferred`, `out_of_scope`), but a human must approve them.
   - `covered_elsewhere` must point to an existing test target, not to a TODO.
   - `deferred` is not allowed for R3.

## Revising plans

- Every edit creates a new plan version and a new hash. Keep each case's `clientKey` stable across versions so its ID stays the same.
- After every edit, run `validate_test_coverage` again. Approvals given for the old hash no longer apply.
