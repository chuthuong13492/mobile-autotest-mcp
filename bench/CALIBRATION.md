# Risk and gate calibration review v1 (OPS-005)

**Decision: keep risk policy v1 and gate policy v1 unchanged.** No `riskPolicyVersion` or `gatePolicyVersion` bump.

## Evidence available

There is no pilot usage yet (no team has used AutoTest on real PRs), so this review rests on:

- **Fixture runs.** The E2E suites (`test/e2e/*.test.ts`) and the resilience and drill suites produce the gate
  decisions their scenarios expect: a weak expected result gives `needs_review` (GR-02), a missing test gives
  `fail`, a covered change gives `pass`.
- **Skill evaluations** (`evals/skill/RESULTS.md`, 2026-10-25, 3 runs per scenario). Plans drafted by the agent
  for a security-relevant change (secure token storage) were scored R3 and failed GB-03/GB-04 when they held only
  positive cases; the agent then explained the missing techniques and did not run. For an ordinary change (a
  calculator) plans scored R0–R1 and passed or needed review only for vague expected results.
- **Real Flutter.** Flutter 3.38.4, 3.38.10, 3.41.9 and 3.47.1 on macOS and 3.44.0 on Linux run the same fixture
  with identical outcomes.

## Observations

- R3 is reached only with several high dimensions, as designed (test-planning-and-coverage §Risk model); the token
  storage PR did reach it, and its consequences (technique diversity, regression case) were what a reviewer would ask
  for.
- No scenario produced a tier a reviewer would call too high or too low. The sample is small and synthetic.

## Next review

Repeat this review once real PR reports exist (at least 30), comparing the computed tier with the reviewer's
judgment per PR. Any change ships as a new policy version, which changes plan hashes (by design).
