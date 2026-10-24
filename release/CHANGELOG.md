# Changelog

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
