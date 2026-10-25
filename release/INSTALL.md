# Mobile AutoTest MCP

PR-driven, policy-governed mobile test orchestration for Claude Code: an MCP server (`autotest-mcp`), a CLI
(`autotest`) and the `pr-mobile-autotest` Agent Skill. Version 1.1 runs **Flutter unit and widget tests** on
**macOS or Linux**, and on AutoTest-owned simulators and emulators: Flutter `integration_test`, native iOS
(XCTest/XCUITest, macOS) and native Android (unit tests on the host JVM, instrumented tests on an emulator).

## Requirements

- Node.js **24 or newer** (`node --version`). It does not have to be the default `node`: setup registers the Node
  you run it with.
- Claude Code (the `claude` CLI) for the MCP registration; without it, setup prints the JSON to add by hand.
- For Flutter projects: a Flutter SDK, and dependencies resolved in each repository (`flutter pub get`).
- Linux: `ps` from procps (Debian/Ubuntu `apt install procps`).

## Install (3 commands)

Download the package from the GitHub Release (or use a `.tgz` you were given), check it, and install it:

```bash
gh release download v1.1.0 -R chuthuong13492/mobile-autotest-mcp -p '*.tgz' -p SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```bash
npm install -g ./mobile-autotest-mcp-1.1.0.tgz
autotest setup --workspace /path/to/your/flutter/repo
autotest doctor
```

`npm install -g` must run with Node 24+ (for example `nvm use 24` first). If the global bin directory of that Node
is not on your `PATH`, call the bins by their full path (`$(npm prefix -g)/bin/autotest`).

`autotest setup`:

1. checks the host, creates `~/.autotest/` (0700) and `~/.autotest/config.yaml` (0600);
2. adds the repository to the allowlist and the Flutter SDK it finds (or `--flutter /abs/path/to/flutter`; with
   several SDKs it asks, or lists them for `--flutter`);
3. registers the server with Claude Code (`claude mcp add --scope user autotest -- <node> <autotest-mcp>`);
4. copies the Skill to `~/.claude/skills/pr-mobile-autotest`;
5. prints recommended deny rules for `~/.claude/settings.json` (add them yourself) and runs `doctor`.

Run `autotest setup --workspace <path>` again for each further repository. `--yes` never asks questions.

## Simulators and emulators (v1.1)

`autotest setup` also allowlists `xcrun` (macOS) and, from `ANDROID_HOME`, `adb`, `emulator` and `avdmanager`.
AutoTest creates its own devices (`autotest-…`) and may boot, erase and delete them; any other simulator or emulator
needs your approval (`autotest approve`) for each action, and physical devices are never managed. The Android emulator
needs about 8 GB of free disk space.

Runs on a device: create and boot an AutoTest device (the agent does this with `manage_simulator`), then
`run_tests` uses it for Flutter `integration_test`, native XCTest/XCUITest and Android instrumented targets. Native
Android unit tests need no device: setup registers your JDK (`java` from `JAVA_HOME`), which runs the project's Gradle
wrapper offline, so build the project once yourself first to fill the Gradle cache. For Android builds, setup adds
`ANDROID_HOME`, `JAVA_HOME` and `GRADLE_USER_HOME` to `env.allow` and registers their values with Claude Code, so
runs can use the SDK, the JDK and your Gradle cache; rerun `autotest setup` if they change.

## Baseline runs (optional)

`autotest setup` also allowlists `git` (for baseline runs: a checkout of the PR's base commit inside the run
directory, never a fetch). Failures that already exist on the base branch can be registered with
`autotest known-failures add …` so they do not fail a PR's verdict.

## GitHub (optional)

AutoTest reads PRs and publishes reports on github.com through your GitHub CLI login. It never stores the token.

1. Install the GitHub CLI and run `gh auth login`.
2. Run `autotest setup` (it adds `gh` to the executable allowlist). To allow publishing, add `--enable-publication`;
   without it GitHub stays read-only.
3. `autotest doctor` reports whether `gh` is logged in.

Then ask Claude, for example, "Test acme/app#42 in workspace ws_myapp". Publishing happens only when you ask for it,
and each publication needs `autotest approve` for that exact report and PR head. A `gh` login cannot create check runs:
AutoTest then sets a commit status `autotest` instead.

## Use

Restart Claude Code in the repository and ask, for example: "Test this PR in workspace ws_myapp" and paste the PR
description (or the task to verify). The Skill plans the tests, validates coverage, runs what is authorized and
reports. When the coverage gate says `needs_review`, Claude shows a command such as
`autotest approve apr_…`: review the scope and run it **yourself** in a terminal.

## Other commands

| Command | Purpose |
|---|---|
| `autotest doctor` | Diagnose the installation (each problem with a fix) |
| `autotest doctor --suggest-executables` | List Flutter SDKs on this machine |
| `autotest approvals` / `autotest revoke <id>` | List / revoke approvals |
| `autotest cleanup [--dry-run]` | Reconcile stopped runs and apply retention |
| `autotest uninstall-claude` | Remove the Claude Code registration and the Skill (keeps `~/.autotest`) |

## Uninstall

```bash
autotest uninstall-claude
npm uninstall -g mobile-autotest-mcp
```

Delete `~/.autotest` yourself if you no longer need its runs, reports and audit log.

## Verify the download

`sha256sum -c SHA256SUMS` (Linux) or `shasum -a 256 -c SHA256SUMS` (macOS). The SBOM of the bundled third-party
packages is `sbom.cdx.json` (CycloneDX 1.5); their licenses are in `THIRD_PARTY_LICENSES.md`.
