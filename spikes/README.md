# Phase 0 spikes (throwaway)

These are experiments for the Phase 0 DISC tasks. **They are not product code.** Do not import them from `packages/` or `apps/`, and do not ship them.

Their findings are recorded in [docs/research-log.md §D](../docs/research-log.md#d-phase-0-spike-findings-executed-2026-10-23-local-time-disc-tasks).

| Folder | Task | What it shows | How to re-run |
|---|---|---|---|
| `disc-001/` | DISC-001 | MCP SDK v2 stdio server (`server.mjs`), a JSON-RPC logging proxy (`proxy.mjs`), and an SDK client test (`client-test.mjs`). SDK packages are pinned exactly in `package.json`, and `node_modules/` was installed with `--ignore-scripts`. | `node client-test.mjs` (under Node 24 or 26). For Claude Code, use `claude -p "…" --mcp-config spike.mcp.json --strict-mcp-config`. Note that `spike.mcp.json` contains absolute local paths. |
| `disc-002/` | DISC-002 | An `Elicitation` hook that auto-accepts. It shows that AL1 approval can happen with no human. | `claude -p "Call spike_confirm …" --mcp-config ../disc-001/spike.mcp.json --settings settings.json` |
| `disc-003/` | DISC-003 | A Swift Secure Enclave helper. Without Developer ID signing and a provisioning profile it fails with `-34018`, by design. | `swiftc -O al3helper.swift -o al3helper && ./al3helper create test` |
| `disc-006/` | DISC-006 | A scratch Flutter app (SDK dependencies only), plus `capture.mjs`, which writes corpora to `fixtures/flutter-json/<version>/` | `node capture.mjs <flutter-bin> ../../fixtures/flutter-json/<version>` |
| `disc-008/` | DISC-008 | A `node:sqlite` feature, throughput and two-process concurrency benchmark | `node bench.mjs` (under Node 22, 24 or 26) |
