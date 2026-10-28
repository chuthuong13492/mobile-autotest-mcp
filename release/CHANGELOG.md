# Changelog

## 1.2.0

React Native and Appium (Phase 5).

- React Native: Jest files on the host (the project's own Jest, run directly, never through `npx`); Maestro flows and
  Detox tests on an AutoTest-owned simulator or emulator. Detox is pinned to the run's device with a generated config
  that extends the project's own, because Detox's `--device-name` could select another simulator.
- `manage_simulator {action: "install"}` installs an app built beforehand (`.app` or `.apk` from an allowlisted
  workspace) on a booted device AutoTest owns. AutoTest does not build apps; `detox build` is not allowed.
- Appium (optional): suites run only when `.autotest/appium.json` pins the Appium server and driver versions, and the
  installed ones match (checked when the run is created and again at dispatch). The server listens on 127.0.0.1 only
  and stops with the run; results are per scenario. Scenarios are linked to spec documents by name.
- `autotest setup` registers `node`, `maestro` and `appium`, and allowlists `APPIUM_HOME`.
- Verified on one Mac with Jest 29.7, Maestro 2.11.0, Detox 20.51.4 (Android), Appium 3.4.2 with UiAutomator2 8.7.0.
- Not done: Detox on iOS (needs `applesimutils`); the Appium XCUITest and Flutter integration drivers were not run;
  of Autotrader's 27 scenarios, the 17 with spec documents are mapped.

## 1.1.1

- Fix: `autotest setup` failed to register the server with Claude Code when it passed environment variables
  (`AUTOTEST_HOME`, or the Android variables new in 1.1.0): the server name came after `claude mcp add -e`, which
  swallowed it. Upgrade from 1.1.0 and rerun `autotest setup`.
- `autotest setup` explains what `xcodebuild` and `java` are registered for.
- The repository is public again, so releases now carry a build-provenance attestation
  (`gh attestation verify <tarball> -R chuthuong13492/mobile-autotest-mcp`; needs a recent `gh`).

## 1.1.0

Simulators, emulators and native platforms (Phase 4).

- Devices: `list_devices` and `manage_simulator` create, boot, erase and delete iOS simulators and Android emulators
  that AutoTest owns (a lease per device); devices you own need a single-use approval, physical devices are never
  touched. `autotest cleanup` removes expired AutoTest devices.
- `run_tests { devices: [id] }` runs on one AutoTest-owned, booted device; the run holds it until its results are
  imported.
- Flutter `integration_test` on a simulator or an emulator.
- Native iOS: XCTest and XCUITest classes from shared schemes, run with `xcodebuild test` and read from the result
  bundle (macOS, Xcode 26.4.1 verified).
- Native Android: JUnit classes from Gradle modules; unit tests on the host JVM, instrumented tests on the run's
  emulator. Your JDK runs the project's Gradle wrapper offline and without a daemon; the `gradlew` script is never
  executed. Build the project once yourself so the Gradle cache is filled.
- `autotest setup` registers `xcodebuild`, the device tools and `java`, and passes `ANDROID_HOME`, `JAVA_HOME` and
  `GRADLE_USER_HOME` to runs.
- Fixes: runs now receive the policy's `env.allow` variables; the run disk quota counts allocated space (Xcode's sparse
  caches no longer cancel runs).
- Limits: one device per run; only the debug variant on Android; no failure screenshots yet; device tests are verified
  on one Mac and do not run in CI. The release workflow skips build-provenance attestation on private repositories.

## 1.0.0

Release 1: the first production release, after the hardening of Phase 3.

- Scope: Flutter unit and widget tests on macOS and Linux; PR input pasted or fetched from github.com through `gh`;
  approved publication to the PR; baseline runs and known failures.
- Release gates passed with evidence (`release/v1.0-readiness.md`); threat-model review confirmed by the repository
  owner (`security/review-v1.md`).
- Waiver: no build-provenance attestation, because GitHub does not offer it for user-owned private repositories. Each
  release still carries an SBOM and SHA256SUMS, and the audit gate blocks high and critical advisories.
- Known residual risks: running tests runs PR code without an OS sandbox; an agent with an unrestricted shell can run
  `autotest approve` (use the deny rules `autotest setup` prints).
- Next: v1.1 adds simulators and emulators, Flutter `integration_test`, and native iOS and Android tests.

## 0.3.0

Baseline runs, the known-failure registry and operational hardening.

- Baseline runs: `run_tests` with `baseline: {ref?}` runs the plan at the PR's base commit in a git worktree inside the
  run directory (`git` is allowlisted with hooks off and no network; AutoTest never fetches). Failures that also fail
  at the base commit are analyzed as `pre_existing` and do not fail the verdict.
- `autotest known-failures add|list|remove`: an audited registry of known failures, each with a reason, a link and an
  expiry of at most one year.
- `autotest doctor` reports unsupported `keychain:` secrets, unset `env:` secrets, run data above the retention cap
  and leftover baseline worktrees; `doctor --stats` and `approvals --all` are new.
- Reliability fixes found by the new resilience suite and operations drills: a busy database no longer leaves the
  server unable to write until restart; a full disk returns `E_STORAGE_UNAVAILABLE` and never breaks the audit chain;
  a tampered approval can be revoked (it moves to `quarantine/approvals/`); runs always record when they ended; the
  log file is best-effort.
- PR reports carry `audit_chain_broken` when the local audit log fails verification.
- Agent Skill `pr-mobile-autotest` 0.3.0: optional baseline runs. Evaluated with 3 runs per scenario.
- Releases are installed and smoke-tested on Ubuntu and macOS before publication; `SECURITY.md` and Dependabot added.
- Verified on Linux (Docker, Flutter 3.44.0) and macOS (Flutter 3.38.4 – 3.47.1).

## 0.2.0

GitHub on github.com through the GitHub CLI (Phase 2, rescoped).

- `get_pr_context` with `source: "github"`: fetches the PR, labels, head and base, and up to 3,000 changed files
  through your `gh` login, and checks the repository against the workspace.
- `publish_github_report`: upserts one PR comment, creates a check run, or sets a commit status `autotest`. Each
  publication needs a single-use human approval (`autotest approve`, AL2) of the exact report, PR head and mechanisms;
  `dryRun` previews without writing. A `gh` user login cannot create check runs, so the check run reports
  `E_GITHUB_FEATURE_UNAVAILABLE` and a commit status is written instead. GitHub stays read-only unless
  publication is enabled.
- CLI: `autotest setup` allowlists `gh` and takes `--enable-publication`; `autotest doctor` checks the `gh` login.
- Agent Skill `pr-mobile-autotest` 0.2.0: GitHub mode and a Publish step.
- Releases are built by GitHub Actions from a `vX.Y.Z` tag and published as GitHub Releases (tarball, SHA256SUMS,
  CycloneDX SBOM).
- Removed from scope: GitHub Enterprise Server, and running AutoTest inside CI.
- Not yet: devices and `integration_test`, native iOS and Android, React Native, Appium, Windows.

## 0.1.0

First installable release (Phase 1).

- MCP server with 18 tools; implemented: PR context (manual), project and test inventory inspection, requirements,
  test plans, the coverage gate, approvals, test runs (detached supervisor, dispatch-time re-authorization, bounded
  retries with flaky labelling, cancellation, restart reconciliation), evidence with redaction and quarantine,
  failure analysis (ruleset anl-1) and PR reports (Markdown, JSON, JUnit).
- Platform: Flutter unit and widget tests on macOS and Linux (Flutter 3.38 – 3.47 verified).
- CLI: `setup`, `doctor`, `init`, `approve`, `revoke`, `approvals`, `cleanup`, `uninstall-claude`.
- Agent Skill `pr-mobile-autotest` 0.1.0, also packaged as a Claude Code plugin.
- Not yet: GitHub/GHE PR fetching and publication, CI integration, devices and `integration_test`, native iOS and
  Android, React Native, Appium, Windows.
