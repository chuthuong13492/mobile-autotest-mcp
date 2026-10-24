# Security policy

Mobile AutoTest MCP runs test code from pull requests on your machine and can write to GitHub on your behalf after a
human approval. The threat model, its residual risks and the controls that address them are in
[docs/security-threat-model.md](docs/security-threat-model.md).

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting for this repository
(**Security → Report a vulnerability**), or contact the repository owner directly. Include the version
(`autotest doctor` prints it), the steps to reproduce, and what an attacker gains. Expect an acknowledgement within
five working days.

Supported versions: the latest release only.

## Supply-chain controls (SEC-005, T-14)

- **Dependencies need a decision.** A new runtime or development dependency is added only after an explicit review of
  its maintenance, license and install scripts. The released package bundles its runtime dependencies with esbuild
  and installs no dependencies of its own.
- **Pinned versions.** `pnpm-lock.yaml` is committed and CI installs with `--frozen-lockfile`. Dependency lifecycle
  scripts never run: `pnpm-workspace.yaml` allows none (`onlyBuiltDependencies: []`, `strictDepBuilds: true`).
- **Audit gate.** Every release runs `pnpm audit --audit-level high --prod`; a high or critical advisory fails the
  release.
- **License allowlist.** The release build fails on a bundled package whose license is outside MIT, ISC, BSD,
  Apache-2.0 and 0BSD, and ships `THIRD_PARTY_LICENSES.md`.
- **SBOM and checksums.** Each GitHub Release carries a CycloneDX SBOM and `SHA256SUMS`; verify the tarball with
  `shasum -a 256 -c SHA256SUMS --ignore-missing` before installing.
- **Pinned CI.** Every GitHub Action is pinned to a commit SHA, and only the release job has write access.
- **Update proposals.** Dependabot proposes dependency and action updates as pull requests; they are reviewed like any
  other change and released only through a version tag.
- **Provenance.** The release workflow tries to attach a build-provenance attestation. GitHub offers artifact
  attestations for private repositories only on GitHub Enterprise Cloud; where it is not available the step is
  skipped and the release notes say so.
