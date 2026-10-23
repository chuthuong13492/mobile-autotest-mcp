# Changelog

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
