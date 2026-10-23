# Operations and Troubleshooting

This document covers installation, configuration, diagnostics, recovery, orphan cleanup and how to handle platform-specific failures. It describes **planned** behavior. The commands and flags listed here become real as the CLI tasks (CLI-001 … CLI-004) land, and OPS-007 drills each procedure before v1.0.

## 1. Installation (planned)

1. **Install the prerequisites.**
   - Node.js 26 (its Active LTS line is scheduled to begin on 2026-10-28) or Node.js 24.
   - Flutter, for Flutter projects.
   - Xcode and the Android SDK (v1.1+).
2. **Install AutoTest** from the release registry (REL-001). This provides the `autotest-mcp` and `autotest` commands.
3. **Run `autotest init`.** It creates `~/.autotest/` with mode `0700` and writes `config.yaml` with comments.
4. **Edit `config.yaml`:**
   - `workspaces[]`: allowlisted repositories.
   - `executables`: absolute paths. `autotest doctor --suggest-executables` proposes these from your PATH, and you confirm each one.
   - `github`: hosts and credential references.
   - `approvals`: minimum assurance levels.
   - `retention`.
5. **Configure Claude Code.** Add the `.mcp.json` entry shown in [local-and-ci-execution §1.2](local-and-ci-execution.md#12-mcp-client-configuration-claude-code). Then install the Skill, either as a project skill or as a plugin.
6. **Run `autotest doctor`.** All checks should pass, or report a remediation.

### Recommended Claude Code permission rules

These rules are defense in depth for [ADR-0006](architecture-decisions/ADR-0006.md) and threats T-15/T-17. Add them to the project or user `settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(autotest approve*)",
      "Bash(autotest revoke*)",
      "Bash(autotest known-failures*)",
      "Edit(~/.autotest/**)",
      "Write(~/.autotest/**)",
      "Bash(*~/.autotest*)"
    ]
  }
}
```

- These rules cannot make AL2 agent-proof. An agent with an unrestricted shell can still work around them, which is residual risk RK-01.
- Enabling Claude Code's sandbox mode adds further protection.
- If the threat model calls for it, require AL3 approvals.
- The exact syntax of the permission rules is verified in SKL-001.

### Running untrusted PRs locally

Executing a PR's tests executes the PR's code (threat T-02). For PRs from outside your trust boundary:

- Run in a disposable VM or a separate macOS user account.
- Or rely on CI, which uses ephemeral runners.

Mark reference repositories `readOnlyReference: true` when they must never be executed in.

## 2. Configuration reference (summary)

| Section | Purpose | Canonical spec |
|---|---|---|
| `workspaces` | Allowlist and the read-only reference flag | [local-and-ci-execution §1.3](local-and-ci-execution.md#13-repository-allowlist) |
| `executables` | Logical name → absolute path (+ sha256) | [ADR-0014](architecture-decisions/ADR-0014.md) |
| `env` | `allow` list and secret references | [local-and-ci-execution §1.6](local-and-ci-execution.md#16-environment-and-secret-handling) |
| `risk` | Risk model policy (riskPolicyVersion) | [test-planning §Risk model](test-planning-and-coverage.md#risk-model) |
| `coverageGate` | Thresholds and rules (gatePolicyVersion) | [test-planning §Configuration](test-planning-and-coverage.md#configuration-coveragegate-section) |
| `approvals` | Minimum assurance per scope, `allowWeakApprovals` | [ADR-0006](architecture-decisions/ADR-0006.md) |
| `execution` | Concurrency, timeouts, retries, quotas | [ADR-0007](architecture-decisions/ADR-0007.md) |
| `retention` | Retention days and the size cap | [data-model §Retention](data-model-and-artifacts.md#retention-and-redaction) |
| `github` | Hosts, credential refs, enabled publication mechanisms | [ADR-0013](architecture-decisions/ADR-0013.md) |
| `preauth.yaml` (separate file) | Pre-authorizations for GitHub publication only | [ADR-0006](architecture-decisions/ADR-0006.md) |

Any change to the policy sections changes the policy version. Coverage decisions and approvals bound to the old version become stale, which is intended.

## 3. Diagnostics

| Command | What it shows |
|---|---|
| `autotest doctor` | Node version and support status, data-root permissions, config validity and its versions, executable resolution and pin checks, SQLite health, keychain access, audit chain, orphaned runs and processes, owned devices with expired leases, Claude Code config hints |
| `autotest doctor --audit` | Verifies the audit hash chain and reports the first broken link |
| `autotest doctor --stats` | Metric summary: runs, denials, quarantines |
| `autotest approvals [--all]` | Approval requests and records, with state and usability |
| Server logs | JSON lines on stderr. In Claude Code they appear in the MCP server log view. Set `AUTOTEST_LOG_LEVEL=debug` for more detail; untrusted content is still truncated. |

## 4. Recovery procedures

| Situation | Procedure |
|---|---|
| Claude Code session ended mid-run | Nothing to do. The supervisor continues. In a new session, call `get_run_status(runId)`. |
| Server crashed or was killed | The next start reconciles automatically ([ADR-0007](architecture-decisions/ADR-0007.md)). Check `doctor` for runs marked `orphan_unverified`. |
| Run stuck in `cancel_pending` | `doctor` lists the survivor PIDs and their executables. Check that each process belongs to the run (start time and executable), then end it manually. After the verification window, the run becomes `infra_error(cancel_unconfirmed)`. AutoTest never claims a cancellation it could not confirm. |
| `E_STORAGE_CORRUPT` | Run `autotest doctor --repair`. This performs only safe actions: reindex from files, quarantine mismatches, and never delete approvals. If that fails, move `~/.autotest/autotest.db` aside. The files remain authoritative, and a new index is rebuilt. |
| Tampered or mismatched approval file | It is unusable automatically. Revoke it and re-approve with `autotest approve`. Review the audit log. |
| Audit chain broken | Investigate local tampering. New events start a new chain segment that references the break. Later reports carry a limitation. |
| Policy config invalid | Execution is denied (`E_POLICY_UNAVAILABLE`). Fix `config.yaml`, then run `doctor`. |
| Disk usage high | `autotest cleanup --dry-run`, then `autotest cleanup`. Lower `retention` if needed. |

## 5. Orphan cleanup

- **Run processes.** Reconciliation at startup handles them. `autotest cleanup` re-runs reconciliation on demand.
- **Temporary directories.** `~/.autotest/tmp/<runId>` is removed when the run reaches a terminal state. `cleanup` removes leftovers older than 24 h.
- **Owned simulators and emulators (v1.1).** `autotest cleanup --devices` deletes devices whose leases have expired. Devices it does not own are never touched.
- **CI.** On persistent runners, run `autotest cleanup --ci` at the end of each job. Ephemeral runners need no cleanup.

## 6. Common failures by platform

| Symptom | Likely cause | Remediation |
|---|---|---|
| `E_PREREQUISITE_MISSING: flutter` | Flutter is not in the executables allowlist, or its path changed | `doctor --suggest-executables`, then confirm |
| Flutter `prerequisite_missing:pub_get` | Dependencies not resolved; private registry credentials missing (for example, Autotrader's Artifactory) | Resolve dependencies outside AutoTest, or enable `allowDependencyResolution` with lockfile enforcement |
| Flutter SDK conflict reported | `pubspec.yaml`, `.fvmrc` and the CI configuration disagree | Pin the SDK in the workspace config (`flutterSdk`) |
| Many `failed (load_error)` results | Compilation error in the code or the tests, or SDK mismatch | Check the excerpts in `collect_test_evidence`. Compare SDK versions. |
| `MissingPluginException` in widget tests | Missing platform-channel mocks | Test setup issue (`test_defect/setup`). Add mocks in the test configuration. |
| Run ends `infra_error(runner_crashed)` | Runner crashed, or there was no `done` event | Re-run. If it persists, check `stderr` evidence and the SDK version. |
| `E_APPROVAL_REQUIRED` after approving | The plan was edited after approval (new hash), the approval has expired, or the environment differs | Re-validate, then re-approve the current hash |
| `E_ASSURANCE_INSUFFICIENT` | Only an elicitation (AL1) was given | Approve with `autotest approve` in a terminal |
| GitHub `E_GITHUB_FEATURE_UNAVAILABLE` (checks) | No GitHub App, or GHES lacks the capability | Use comment and status publication ([ADR-0013](architecture-decisions/ADR-0013.md)) |
| (v1.1) iOS `Unable to boot` | Simulator runtime missing or corrupted | Install the runtime in Xcode. Let AutoTest create an owned device. |
| (v1.1) Android `INSTALL_FAILED_*` | Emulator storage full or ABI mismatch | Use an owned emulator with a matching ABI. Wipe owned devices only. |
| (v1.2) Appium `prerequisite_mismatch` | Installed Appium or driver differs from the pinned versions | Install the pinned versions (OQ-06 governs compatibility) |
| Claude Code shows results saved to a file | Output above Claude Code's limits | This should not happen (NFR-004). Report it as a bug. Pagination should prevent it. |
