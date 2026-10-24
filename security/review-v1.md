# Threat-model verification review v1 (SEC-004)

Every threat in [docs/security-threat-model.md](../docs/security-threat-model.md) checked against the implementation
of v0.3.0, with the test that proves the mitigation or the reason it is accepted or not applicable. Prepared
2026-10-25 by the implementing agent. **Confirmation:** Confirmed 2026-10-25 by the repository owner (GitHub `chuthuong13492`) in the Claude Code session: "đã đọc security/review-v1.md và release/v1.0-readiness.md, đồng ý các residual risk và waiver provenance" (read both documents; accepts the residual risks and the provenance waiver). There is no independent security reviewer for this project; that is recorded as a limitation
of the review, not hidden.

Status values: **verified** (an automated test exercises the mitigation), **accepted residual** (a known gap,
documented with its mitigation), **not applicable** (the surface does not exist in v1.0).

| Threat | Status | Evidence |
|---|---|---|
| T-01 Prompt injection | verified | SEC-002 `security/sec-002/injection.test.ts` (crafted PR text, test names and logs change no gate decision, classification or authorization); Skill evaluation `injection` 3/3 (`evals/skill/RESULTS.md`) |
| T-02 Malicious test or build scripts | accepted residual | Running tests runs PR code: only authorized plans run (SEC-003), with an isolated environment, HOME and TMPDIR per run (SEC-001 `[T-02,T-05]`). There is no OS sandbox in v1.0 (residual risk in the threat model; RK-01, RK-02) |
| T-03 Arbitrary command execution | verified | SEC-001: no tool input has a command field; shell metacharacters stay one literal argument; `git` can only check out a worktree (`[T-03,T-08]`); argument-schema tests in `packages/policy/test/` |
| T-04 Path traversal and symlink escape | verified | SEC-001 `[T-04]`; evidence ingestion refuses symlinks and paths outside the run (`packages/evidence/test/evidence.test.ts`) |
| T-05 Secret leakage | verified | SEC-001 redaction canaries; the GitHub token never reaches the data root (`apps/mcp-server/test/github.test.ts`, and the live check of 2026-10-24). Note: during that live check the *verification script* (not the product) printed the token into the session; the token was rotated |
| T-06 Unauthorized GitHub writes | verified | SEC-003 `[T-06]` (wider mechanism set, reuse, AL1, publication disabled); `apps/mcp-server/test/github.test.ts`; live draft-PR check (one comment after two publications, approval reuse refused) |
| T-07 Malicious or oversized artifacts | verified | SEC-001 `[T-07]`; `packages/evidence/test/evidence.test.ts` (binary as text, oversize, unknown binaries quarantined) |
| T-08 Untrusted dependency installation | verified | SEC-001 `[T-08]` (`--no-pub` always, resolution off by default); baseline runs reuse resolved dependencies only with identical lock files and git never fetches (`test/e2e/baseline.test.ts`) |
| T-09 Resource exhaustion | verified | `packages/execution/test/supervisor.test.ts` (SIGTERM-ignoring runner timed out, disk quota → `resource_quota`); resilience: 60 MiB flood on a full disk |
| T-10 Device state corruption | not applicable | No device actions before v1.1 (DEV-002 will add lease ownership and its tests) |
| T-11 Cross-run data leakage | verified | SEC-001 `[T-11]` (separate private run directories and scratch HOME/TMPDIR) |
| T-12 CI credential exposure | not applicable | AutoTest does not run in CI (removed from scope 2026-10-24). This repository's own release workflow gives write access only to the release job |
| T-13 Insecure remote transport | not applicable | stdio only; no HTTP transport exists |
| T-14 Supply-chain compromise | accepted residual | SEC-005: `pnpm audit` gate, frozen lockfile, no dependency install scripts, license allowlist, SBOM and SHA256SUMS on every release, actions pinned by SHA, Dependabot. Build provenance depends on GitHub support for private repositories (recorded in each release's notes) |
| T-15 Stale, forged or self-granted approvals | verified, with accepted residual | SEC-003 `[T-15]` × 6; tampered approvals revocable and quarantined (`ops/drills.test.ts`). Residual RK-01: an agent with an unrestricted shell can run `autotest approve`; `autotest setup` prints deny rules and `doctor` checks them; AL3 is not available (DISC-003) |
| T-16 Process ownership confusion | verified | `apps/mcp-server/test/runs.test.ts` (an unverifiable identity is never signalled: `orphan_unverified`); resilience: an unrelated process survives every scenario |
| T-17 Data-root tampering | verified, with accepted residual | SEC-001 `[T-17]` (0700/0600, symlinked or open roots refused); integrity checks on approvals and plans (SEC-003); audit chain verification (`packages/storage/test/audit.test.ts`). Residual: test code runs as the same user and can read the data root |
| T-18 Plan tampering after the gate | verified | SEC-003 `[T-18]` |
| T-19 Repudiation | verified | Hash-chained audit with actor and assurance (`packages/storage/test/audit.test.ts`); a broken chain is reported by `doctor --audit` and in every later report (`ops/drills.test.ts`) |
| T-20 Repo-local config widening policy | verified | SEC-002 `[T-20]` (only the data-root policy is read) |
| T-21 Handle or cursor forgery | verified | `apps/mcp-server/test/middleware.test.ts` (forged, expired and mismatched cursors → `E_CURSOR_INVALID`); `packages/core/test/cursor.test.ts` |

## Findings during the review cycle (fixed)

Found by the resilience suite (OPS-006) and the operations drills (OPS-007), all fixed with regression tests:

1. A failed `BEGIN` left the database connection unusable until restart (availability).
2. A `ROLLBACK` after SQLite's own rollback masked the original error.
3. An uncommitted audit append could leave a line that made the next event reuse its sequence number (T-19 integrity).
4. A full disk returned `E_INTERNAL` instead of the recoverable `E_STORAGE_UNAVAILABLE`.
5. A tampered approval could not be revoked and blocked every approval of its scope (T-15 recovery).
6. A run could end without `endedAt`, so retention never removed it (T-09 disk exhaustion over time).

## Limitations of this review

- No independent reviewer and no external penetration test (an organization decision in the threat model).
- Threats for devices (T-10), React Native and Appium surfaces are reviewed again with v1.1 and v1.2.
