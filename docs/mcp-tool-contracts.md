# MCP Tool Contracts

**Canonical home for:** tool names, the tool contract template, input and output schemas, the error code catalog, pagination, output limits and artifact-reference rules.
**Entity and enum definitions** come from [data-model-and-artifacts.md](data-model-and-artifacts.md) and are not redefined here.
**Status:** These schemas are implemented in `packages/contracts/src/tools.ts` (CON-007, 2026-10-23), and `doc-examples.test.ts` validates every example below against them. The sketches below remain the readable form. The exact SDK registration API is checked in DISC-001 ([OQ-05](risks-and-open-questions.md#oq-05)), and the contracts do not depend on it.

## 1. Catalog

There are exactly 18 tools. There is **no** generic shell or command tool (SR-001). Tool IDs use the `TL-NN` form; `T-NN` always refers to a threat in the [threat model](security-threat-model.md).

| ID | Tool | Tier | Purpose |
|---|---|---|---|
| TL-01 | `get_pr_context` | P0 | Normalize a manual PR or fetch a GitHub PR (github.com) |
| TL-02 | `inspect_project` | P0 | Detect frameworks, platforms, toolchains and runners, with evidence |
| TL-03 | `inspect_test_inventory` | P0 | Discover test targets, helpers and configs (paged) |
| TL-04 | `extract_requirements` | P0 | Deterministically parse requirements and merge the agent's requirements |
| TL-05 | `generate_test_plan` | P0 | Validate, normalize, enrich, hash and persist the agent's draft plan |
| TL-06 | `validate_test_coverage` | P0 | Run the independent coverage gate and bind the decision to the plan hash |
| TL-07 | `request_approval` | P0 | Open an approval request. It **cannot grant** approval. |
| TL-08 | `get_approval_status` | P0 | Read approval request/record status and usability |
| TL-09 | `run_tests` | P1 | Authorize and create an asynchronous run, returning `runId` |
| TL-10 | `get_run_status` | P0 | Run state, status category, progress |
| TL-11 | `get_run_results` | P0 | Paged per-test results |
| TL-12 | `cancel_test_run` | P1 | Cancel a run using termination escalation |
| TL-13 | `list_devices` | P0 | Enumerate simulators, emulators and devices, and host capability |
| TL-14 | `manage_simulator` | P1/P2 per action | Boot, shut down, create, erase or delete simulators/emulators, with ownership checks |
| TL-15 | `collect_test_evidence` | P0 | Artifact metadata and bounded redacted excerpts |
| TL-16 | `analyze_test_failures` | P0 | Rule-based failure classification |
| TL-17 | `generate_pr_test_report` | P0 | Render the Markdown/JSON/JUnit report and compute the verdict |
| TL-18 | `publish_github_report` | P3 | Authorized, idempotent GitHub publication |

**P0 definition.** No side effects outside the server's own data root, and no external writes. P0 tools may create records in the data root, for example plans, decisions and approval *requests*. Tiers are canonical in [security-threat-model §Permission tiers](security-threat-model.md#permission-tiers-and-approval-matrix).

### Why the four supporting tools exist, and why they are not merged

| Tool | Justification | Why not merged |
|---|---|---|
| `extract_requirements` | Requirement extraction must be deterministic and persisted with stable IDs before plan drafting, so that the gate can evaluate requirements independently of the plan (ADR-0005). | Merging it into `get_pr_context` would mix raw intake with interpretation. Merging it into `generate_test_plan` would let the plan author define the requirements it is graded against. |
| `request_approval` | Records exactly what is being approved (scope digest, required assurance level) and gives the human instructions. It may trigger elicitation. | Approval must not be a side effect of `run_tests` or `publish_github_report`: those calls come from the agent and must not double as the approval channel (ADR-0006). |
| `get_approval_status` | Lets the agent check, without side effects, whether a human has acted on an out-of-band (CLI) approval. | A status read must have no side effects. Folding it into `request_approval` would make polling create requests. |
| `get_run_results` | Results can be large (thousands of tests). Keeping them separate from the status keeps `get_run_status` small and cheap to poll (NFR-004). | Merging would make every poll pay the cost of large payloads. |

`run_tests` and `collect_test_evidence` are intentionally kept separate. Execution is P1 and asynchronous. Evidence retrieval is P0, repeatable, and has its own limits.

## 2. Shared conventions

### 2.1 Result shape

- Every tool declares an `outputSchema`.
- Success returns `structuredContent` conforming to that schema, plus one `text` content block with a short human summary of at most 1,000 characters. The full JSON is **not** echoed as text, so that clients that ignore structured content still see the summary ([RL-002](research-log.md#rl-002--tool-annotations-are-untrusted-hints)).
- Domain errors are **tool execution errors** (`isError: true`) whose `structuredContent` is:

```ts
const ToolError = z.object({
  error: z.object({
    code: ErrorCode,            // catalog below
    message: z.string().max(1000),
    recoverable: z.boolean(),
    nextSteps: z.array(z.string().max(300)).max(5),
    details: z.record(z.string(), z.unknown()).optional(),  // redacted
  }),
});
```

- Protocol errors (unknown tool, malformed request) are left to the SDK. Codes in the -32020…-32099 range are reserved by the specification and never used here ([RL-001](research-log.md#rl-001--current-mcp-specification-revision)).
- Error text stays well below Claude Code's 11,000-character truncation point ([RL-007](research-log.md#rl-007--claude-code-mcp-behaviour-relevant-to-this-design)).

### 2.2 Untrusted content labelling

Any output field that carries repository, PR or runner-derived text is listed in `untrustedFields` (JSON pointers). The text summary prefixes such excerpts with `[untrusted]`. The Skill must treat them as data (SR-006, SR-020).

### 2.3 Pagination

- Input: `cursor?: string`, `limit?: number` (default 50, max 200).
- Output: `nextCursor: string | null`.
- A cursor is opaque. It is server-minted as an HMAC-protected token bound to `{tool, snapshotId, filterDigest, offset}`, using a per-install key held in the data root. It expires after 1 h.
- An invalid, expired or mismatched cursor returns `E_CURSOR_INVALID`.
- **Implemented (MCP-002):** the format is `cur_<base64url(payload)>.<base64url(HMAC-SHA256)>`, with the key in `<data root>/keys/cursor.key` (32 random bytes, `0600`). Paged use cases call `paginate` (`packages/core/src/cursor.ts`), which also fits the page to the output cap. A cursor from another snapshot is rejected too.
- A page is drawn from an immutable snapshot (inventory or run results), so items never shift between pages.

### 2.4 Output-size limits

- Default cap: the serialized `structuredContent` is ≤ 20,000 characters (NFR-004).
- When a page would exceed the cap, the server reduces the page size, sets `truncated: true` and returns a `nextCursor`. Individual string fields have their own caps, given per tool.
- Tools never return raw logs. Large content is exposed as **artifact references**:

```ts
const ArtifactRef = z.object({
  artifactId: z.string(), kind: ArtifactKind, sizeBytes: z.number().int(),
  sha256: z.string(), mimeType: z.string(), quarantined: z.boolean(),
  uri: z.string(),  // "autotest://runs/<runId>/artifacts/<artifactId>" (informational handle)
});
```

### 2.5 Idempotency

- Read tools are naturally idempotent.
- Create-type tools accept `idempotencyKey?: string` (1–128 chars, `[A-Za-z0-9._:-]`). The key is remembered for 24 h together with a digest of the request.
  - Same key and same digest: the original result is returned.
  - Same key and a different digest: `E_IDEMPOTENCY_CONFLICT`.
- **Implemented (MCP-002):** records are scoped per tool and kept in `idempotency_keys`, first write wins. The middleware covers sequential retries. Two *concurrent* first calls with the same key can both execute, so `run_tests` additionally relies on the unique `runs.idempotency_key` index (RUN-001).

### 2.6 Advisory annotations

MCP tool annotations are hints for clients only ([RL-002](research-log.md#rl-002--tool-annotations-are-untrusted-hints)). Enforcement always happens in `policy`.

Two `_meta` keys apply here:

- `anthropic/requiresUserInteraction: true` is set on TL-07 and TL-18. It is defense in depth only ([ADR-0006](architecture-decisions/ADR-0006.md)).
- `anthropic/maxResultSizeChars` is not set, because outputs stay below Claude Code's default threshold.

### 2.7 Audit

Every call produces a `tool.call` and a `tool.result` audit event. Each records:

- the tool name
- the redacted input digest (not the full input)
- the result code
- latency
- the subject IDs

Policy and authorization decisions produce their own events.

## 3. Error code catalog (canonical)

| Code | Meaning | Recoverable | Typical next step |
|---|---|---|---|
| `E_VALIDATION` | Input fails the schema. `details.issues[]` carries JSON pointers. | yes | Fix the fields and retry |
| `E_INPUT_TOO_LARGE` | Input exceeds size limits | yes | Shorten it or split it |
| `E_CURSOR_INVALID` | Cursor is malformed, expired or mismatched | yes | Restart pagination |
| `E_NOT_FOUND` | Referenced entity not found (generic) | yes | Check the ID |
| `E_PLAN_NOT_FOUND` | No such plan/version | yes | Regenerate the plan |
| `E_RUN_NOT_FOUND` | No such run (or retention expired) | no | Start a new run |
| `E_WORKSPACE_NOT_ALLOWED` | Workspace not on the allowlist | yes (human) | Add it to the allowlist in the user config |
| `E_REPO_MISMATCH` | PR repo differs from the workspace's remote | yes | Use the matching workspace |
| `E_PATH_ESCAPE` | A path resolves outside its allowed root | no | — |
| `E_POLICY_DENIED` | Action denied by policy. `details.reasons[]` explains why. | depends | Change the request or the policy (human) |
| `E_POLICY_UNAVAILABLE` | Policy config missing or invalid. Fails safe. | yes (human) | Run `autotest doctor` |
| `E_PLAN_HASH_MISMATCH` | Requested or stored hash does not match the recomputed hash | no | Regenerate the plan |
| `E_COVERAGE_MISSING` | No coverage decision for the plan hash | yes | Call `validate_test_coverage` |
| `E_COVERAGE_STALE` | Decision bound to a different hash, requirement set or gate policy | yes | Re-validate |
| `E_COVERAGE_FAILED` | Gate decision is `fail` | yes | Revise the plan |
| `E_APPROVAL_REQUIRED` | A usable approval is required | yes (human) | `request_approval`, then a human approves |
| `E_APPROVAL_STALE` | Approval bound to a different hash, scope, environment or policy | yes (human) | Request again |
| `E_APPROVAL_EXPIRED` | Approval expired | yes (human) | Request again |
| `E_APPROVAL_REVOKED` | Approval revoked | yes (human) | Request again |
| `E_APPROVAL_EXHAUSTED` | Approval used up (`uses == maxUses`) | yes (human) | Request again |
| `E_ASSURANCE_INSUFFICIENT` | The source's assurance level is below the policy minimum | yes (human) | Approve via the CLI (AL2) or an AL3 source |
| `E_AUTHORIZATION_CHANGED` | Authorization inputs changed between run creation and dispatch | yes | Re-run the workflow |
| `E_PREREQUISITE_MISSING` | Toolchain or SDK missing or mismatched | yes (human) | Follow the `doctor` remediation |
| `E_CAPABILITY_UNAVAILABLE` | Adapter or host lacks the capability (e.g. device tests before v1.1) | no | Choose eligible targets |
| `E_UNSUPPORTED_PLATFORM` | No adapter for the detected framework | no | — |
| `E_DEVICE_UNAVAILABLE` | Device is busy, absent or failed to boot | yes | Pick another device or retry |
| `E_DEVICE_NOT_OWNED` | Action on a non-owned device without P2 approval | yes (human) | `request_approval` with kind `device_action` |
| `E_QUEUE_FULL` | Queue capacity exceeded (default 20 queued runs) | yes | Retry later |
| `E_RUN_TERMINAL` | Operation not valid on a terminal run | no | — |
| `E_REPORT_NOT_READY` | Report requested before the runs are terminal | yes | Poll `get_run_status` |
| `E_IDEMPOTENCY_CONFLICT` | Key reused with a different request | yes | Use a new key |
| `E_ARTIFACT_TOO_LARGE` | Artifact exceeds limits (recorded, truncated or rejected) | no | — |
| `E_ARTIFACT_QUARANTINED` | Artifact failed validation or redaction | no | Inspect it locally (human) |
| `E_REDACTION_FAILED` | The redaction engine failed. Fails closed. | no | Report a bug |
| `E_ELICITATION_DECLINED` | User declined or cancelled the elicitation | yes | Explain and stop, or use the CLI |
| `E_GITHUB_UNAVAILABLE` | Network error or 5xx after retries | yes | Retry later or use manual input |
| `E_GITHUB_AUTH` | Credential missing or invalid | yes (human) | Configure the credential |
| `E_GITHUB_PERMISSION` | Credential lacks the permission | yes (human) | Grant least-privilege permission |
| `E_GITHUB_RATE_LIMITED` | Rate limited after backoff | yes | Retry after `details.resetAt` |
| `E_GITHUB_FEATURE_UNAVAILABLE` | e.g. Checks API unavailable on this GHES | yes | Use the fallback mechanism |
| `E_GITHUB_NOT_FOUND` | PR or repo not found, or no access | yes | Check the identity |
| `E_STORAGE_UNAVAILABLE` | Data root/SQLite unavailable or locked beyond the timeout | yes | Retry; run `doctor` |
| `E_STORAGE_CORRUPT` | Integrity check failed | no (human) | `autotest doctor`, then operations §4 |
| `E_TIMEOUT` | The tool's own operation budget was exceeded (e.g. inspection > 60 s) | yes | Narrow the scope |
| `E_INTERNAL` | Unexpected server error (correlation ID in `details`) | no | Report it |

## 4. Tool contracts

Every tool uses the same template. Its sections are, in order:

1. Purpose
2. Responsibilities
3. Non-responsibilities
4. Input schema
5. Output schema
6. Validation rules
7. Preconditions
8. Postconditions
9. Authorization
10. Side effects
11. MCP annotations (advisory)
12. Idempotency and retry
13. Errors
14. Timeout and cancellation
15. Observability and audit
16. Security considerations
17. Example request
18. Example response
19. Tests
20. Dependencies
21. Traceability

---

### TL-01 get_pr_context

- **Purpose:** Produce a normalized `PRContext` from manual input or from a GitHub/GHES PR.
- **Responsibilities:** Validate the workspace allowlist and repo identity. Fetch the PR, files and diff stats (github mode). Enforce size caps. Label untrusted fields. Record limitations.
- **Non-responsibilities:** Interpreting requirements. Reading repository files. Any GitHub write.
- **Input schema:**

```ts
input = z.object({
  workspace: z.string().min(1),                       // allowlist entry id or absolute path
  source: z.enum(["manual", "github"]),
  manual: z.object({
    title: z.string().max(1024).optional(),
    body: z.string().min(1).max(65536),
    labels: z.array(z.string().max(100)).max(50).optional(),
    changedFiles: z.array(z.string().max(1024)).max(3000).optional(),
  }).strict().optional(),
  github: z.object({
    host: z.string().optional(),                       // defaults to configured host
    owner: z.string().min(1), name: z.string().min(1),
    number: z.number().int().positive(),
  }).strict().optional(),
  bodyOffset: z.number().int().min(0).default(0),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  prContextId: z.string(),
  source: z.enum(["manual", "github"]),
  repository: RepositoryIdentity,
  number: z.number().int().nullable(),
  title: z.string().nullable(),
  body: z.string().max(16000),                         // page of body text
  bodyNextOffset: z.number().int().nullable(),
  labels: z.array(z.string()),
  base: RefInfo.nullable(), head: RefInfo.nullable(),
  changedFilesCount: z.number().int(),
  changedFilesSample: z.array(ChangedFile).max(100),
  limitations: z.array(Limitation),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:** Exactly one of `manual`/`github` must be present and must match `source`. The `github.host` must be in the configured hosts. `body` ≤ 64 KiB. Control characters other than `\n` and `\t` are stripped and counted in `limitations`.
- **Preconditions:** The policy is loaded. A GitHub read credential is configured for github mode.
- **Implementation status (PLN-001):** manual mode is implemented. The workspace's canonical root is recorded as `repository.localPath`, so later steps can check workspace consistency (`E_REPO_MISMATCH`). GitHub mode returns `E_CAPABILITY_UNAVAILABLE` until GH-002.
- **Postconditions:** A `PRContext` is persisted (redacted). Repeat calls with the same `prContextId` source data create a new context (each call is a new retrieval).
- **Authorization:** P0. Read-only GitHub credential (ADR-0013).
- **Side effects:** Writes to the data root only.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.
- **Idempotency and retry:** Not idempotent (new ID per call). GitHub calls retry with backoff, up to 5 times, on 5xx and 429.
- **Errors:** `E_VALIDATION`, `E_INPUT_TOO_LARGE`, `E_WORKSPACE_NOT_ALLOWED`, `E_REPO_MISMATCH`, `E_GITHUB_AUTH`, `E_GITHUB_PERMISSION`, `E_GITHUB_NOT_FOUND`, `E_GITHUB_RATE_LIMITED`, `E_GITHUB_UNAVAILABLE` (with `nextSteps` suggesting manual mode), `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** 30 s budget, then `E_TIMEOUT`. No long-running state is kept.
- **Observability and audit:** Audit `tool.call` with the repo identity and PR number (not the body). Metrics: GitHub latency and calls.
- **Security considerations:** The PR body is untrusted (prompt injection, T-01). It is never interpreted, and it is redacted before persistence. Tokens never appear in the output.
- **Example request:**

```json
{"workspace": "ws_fixture_flutter", "source": "manual", "manual": {"title": "Add saved-search badge", "body": "## Acceptance criteria\n- [ ] Badge shows count of new listings\n- [ ] Badge hidden when count is 0"}}
```

- **Example response:**

```json
{"prContextId": "prc_01JC0000000000000000000001", "source": "manual", "repository": {"host": "local", "localPath": "/Users/dev/fixture-flutter"}, "number": null, "title": "Add saved-search badge", "body": "## Acceptance criteria\n- [ ] Badge shows count of new listings\n- [ ] Badge hidden when count is 0", "bodyNextOffset": null, "labels": [], "base": null, "head": null, "changedFilesCount": 0, "changedFilesSample": [], "limitations": [{"code": "diff_unavailable", "message": "Manual input without changed files"}], "untrustedFields": ["/title", "/body"]}
```

- **Tests:**
  - Unit: input variants and caps.
  - Contract: the example validates against the schemas.
  - Integration: recorded GHES fixtures (pagination of files, 3,000 cap).
  - Security: an injection corpus in the body must not alter behavior. Host spoofing and non-allowlisted workspace are rejected.
- **Dependencies:** `workflow` → `policy`, `github`, `storage`.
- **Traceability:** FR-001 – FR-004, SR-006, SR-009. ADR-0013.

---

### TL-02 inspect_project

- **Purpose:** Detect frameworks, platforms, languages, toolchains and runners, each with confidence and evidence.
- **Responsibilities:** Bounded workspace scan. Run every registered adapter's `detect()`. Resolve toolchain versions from all sources and report conflicts (FR-007).
- **Non-responsibilities:** Running any toolchain command that changes state. Version detection may call allowlisted read-only commands such as `flutter --version` through `exec`, under policy, with a 10 s timeout. Installing SDKs.
- **Input schema:**

```ts
input = z.object({
  workspace: z.string().min(1),
  adapters: z.array(z.string()).optional(),          // restrict detection
  maxFiles: z.number().int().min(100).max(200000).default(50000),
  probeToolchains: z.boolean().default(true),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  projectProfileId: z.string(),
  frameworks: z.array(z.object({ adapterId: z.string(), confidence: z.number().min(0).max(1), evidence: z.array(z.string()).max(20) })),
  platforms: z.array(z.object({ platform: Platform, status: z.enum(["present","absent","unknown"]), evidence: z.array(z.string()).max(10) })),
  languages: z.array(z.string()),
  toolchains: z.array(ToolchainResolution),
  runners: z.array(z.object({ adapterId: z.string(), kind: z.string(), configured: z.boolean(), evidence: z.array(z.string()).max(10) })),
  limitations: z.array(Limitation),
})
```

- **Validation rules:** The workspace canonicalizes to an allowlisted root. `adapters` IDs must be registered.
- **Preconditions:** Policy loaded.
- **Postconditions:** `ProjectProfile` persisted. Every `present` platform has evidence.
- **Authorization:** P0. Toolchain probes are allowlisted read-only commands (policy class `probe`).
- **Side effects:** Data-root writes. Probe processes (read-only).
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Deterministic for an unchanged workspace. It creates a new profile ID per call, with identical content.
- **Errors:** `E_VALIDATION`, `E_WORKSPACE_NOT_ALLOWED`, `E_PATH_ESCAPE`, `E_TIMEOUT` (60 s), `E_POLICY_UNAVAILABLE`.
- **Timeout and cancellation:** 60 s total budget. Each probe has 10 s. Exceeding the budget returns partial results with the limitation `inspection_truncated`.
- **Observability and audit:** Files scanned, truncation, probe durations.
- **Security considerations:**
  - Symlinks are not followed outside the root (T-04).
  - Repo files are never executed during inspection.
  - Version probes run with the minimal environment.
  - Build scripts (Gradle, CocoaPods) are **not** evaluated. Detection is static.
- **Example request:**

```json
{"workspace": "ws_autotrader", "probeToolchains": true}
```

- **Example response:**

```json
{"projectProfileId": "prj_01JC0000000000000000000002", "frameworks": [{"adapterId": "flutter", "confidence": 0.98, "evidence": ["pubspec.yaml", "lib/main.dart"]}], "platforms": [{"platform": "android", "status": "present", "evidence": ["android/app/build.gradle"]}, {"platform": "ios", "status": "present", "evidence": ["ios/Runner.xcodeproj"]}], "languages": ["dart", "typescript"], "toolchains": [{"tool": "flutter", "versionsBySource": [{"source": "pubspec.yaml:environment.flutter", "value": "3.38.4"}, {"source": "bitrise.yml:CURRENT_FLUTTER_VERSION", "value": "3.38.10"}], "resolved": null, "conflicts": ["pubspec.yaml vs bitrise.yml"]}], "runners": [{"adapterId": "flutter", "kind": "flutter_test", "configured": true, "evidence": ["test/flutter_test_config.dart"]}], "limitations": [{"code": "version_conflict", "message": "Flutter version sources disagree; not auto-selected"}]}
```

- **Tests:**
  - Unit: detectors per fixture.
  - Contract: schema examples.
  - Integration: synthetic fixtures for each framework, plus the Autotrader profile (read-only, credential-free).
  - Security: symlink escape, a 200k-file stress fixture, and a malicious `pubspec.yaml` (huge or YAML bomb) handled safely.
- **Dependencies:** `inspect`, `workspace`, `adapter-*` via the registry, `exec` (probes).
- **Traceability:** FR-005 – FR-007, SR-003, SR-012. ADR-0009.

---

### TL-03 inspect_test_inventory

- **Purpose:** Discover test targets, helpers, fixtures, mocks and automation configs, reporting completeness.
- **Responsibilities:** Run adapter `inventory()` within limits. Persist the full inventory snapshot. Return paged targets.
- **Non-responsibilities:** Executing tests. Judging test quality.
- **Input schema:**

```ts
input = z.object({
  projectProfileId: z.string(),
  inventoryId: z.string().optional(),                 // page an existing snapshot
  filter: z.object({ adapterId: z.string().optional(), level: TestLevel.optional(), pathPrefix: z.string().max(512).optional() }).strict().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  inventoryId: z.string(),
  counts: z.object({ total: z.number().int(), byLevel: z.record(z.string(), z.number().int()), byAdapter: z.record(z.string(), z.number().int()) }),
  completeness: z.object({ complete: z.boolean(), truncatedAt: z.number().int().nullable(), reasons: z.array(z.string()) }),
  helpers: z.array(z.object({ path: z.string(), kind: z.enum(["mock","fixture","helper","config"]) })).max(50),
  targets: z.array(TestTarget),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:** The profile exists and is not past retention. `pathPrefix` canonicalizes inside the workspace.
- **Preconditions:** `inspect_project` has completed.
- **Postconditions:** On the first call (no `inventoryId`), an immutable inventory snapshot exists, and pages derive from it.
- **Authorization:** P0.
- **Side effects:** Data-root writes.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Paging the same `inventoryId` is idempotent.
- **Errors:** `E_NOT_FOUND`, `E_CURSOR_INVALID`, `E_PATH_ESCAPE`, `E_TIMEOUT`.
- **Timeout and cancellation:** 60 s for snapshot creation. Partial snapshots are marked incomplete.
- **Observability and audit:** Counts and truncation.
- **Security considerations:** Test names are untrusted. Paths are validated. Contents are not loaded beyond the bounded parsing needed for discovery (Dart test names via a lightweight scan, ≤ 256 KiB per file).
- **Example request:**

```json
{"projectProfileId": "prj_01JC0000000000000000000002", "filter": {"level": "widget"}, "limit": 2}
```

- **Example response:**

```json
{"inventoryId": "inv_01JC0000000000000000000003", "counts": {"total": 725, "byLevel": {"unit": 474, "widget": 251}, "byAdapter": {"flutter": 725}}, "completeness": {"complete": true, "truncatedAt": null, "reasons": []}, "helpers": [{"path": "test/mocks/mock_http.dart", "kind": "mock"}, {"path": "test/flutter_test_config.dart", "kind": "config"}], "targets": [{"id": "TT-flutter-1a2b3c4d5e6f", "adapterId": "flutter", "level": "widget", "path": "test/widget/badge_test.dart", "selector": {"kind": "file", "value": "test/widget/badge_test.dart"}, "platforms": ["host"], "requires": {"host": "any", "device": "none"}, "tags": []}, {"id": "TT-flutter-2b3c4d5e6f7a", "adapterId": "flutter", "level": "widget", "path": "test/widget/search_test.dart", "selector": {"kind": "file", "value": "test/widget/search_test.dart"}, "platforms": ["host"], "requires": {"host": "any", "device": "none"}, "tags": []}], "nextCursor": "cur_eyJ...", "truncated": false, "untrustedFields": ["/targets/*/path"]}
```

- **Tests:**
  - Unit: classification of helpers versus tests.
  - Contract: pagination invariants (no duplicates or gaps).
  - Integration: the Autotrader-scale fixture (775 files) pages correctly.
  - Security: crafted filenames with shell metacharacters stay inert.
- **Dependencies:** `inspect`, `adapter-*`, `storage`.
- **Traceability:** FR-008, NFR-004. ADR-0009.

---

### TL-04 extract_requirements

- **Purpose:** Create a persisted `RequirementSet` by deterministically parsing the PR body and merging the agent's proposed requirements, ambiguities and assumptions.
- **Responsibilities:**
  - Parse checklists, `AC:`/"Acceptance criteria" sections, Given/When/Then blocks, and numbered requirement lists ([test-planning §Requirement extraction](test-planning-and-coverage.md#requirement-extraction)).
  - Merge agent items, de-duplicating by normalized text.
  - Assign `REQ`/`AC` IDs.
  - Compute risk tiers from the supplied factors (`planning` risk model).
  - Compute `requirementSetHash`.
- **Non-responsibilities:** Inventing requirements, which is the agent's job and gets `provenance=agent`. Judging coverage.
- **Input schema:**

```ts
input = z.object({
  prContextId: z.string(),
  agentRequirements: z.array(z.object({
    title: z.string().min(3).max(200),
    statement: z.string().min(10).max(2000),
    kind: RequirementKind,
    testable: z.boolean().default(true),
    nonTestableReason: z.string().max(500).optional(),
    platforms: z.array(Platform).default([]),
    riskFactors: RiskFactors.optional(),
    sourceQuote: z.string().max(500).optional(),
    acceptanceCriteria: z.array(z.object({ text: z.string().min(5).max(1000), format: AcFormat })).max(30),
  }).strict()).max(200).default([]),
  agentAmbiguities: z.array(z.object({ text: z.string().max(1000), severity: z.enum(["low","medium","high"]), relatedKeys: z.array(z.string()).default([]) })).max(100).default([]),
  agentAssumptions: z.array(z.object({ text: z.string().max(1000) })).max(100).default([]),
  mode: z.enum(["parsed_only", "parsed_and_agent"]).default("parsed_and_agent"),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  requirementSetId: z.string(),
  requirementSetHash: z.string(),
  requirements: z.array(RequirementSummary).max(200),   // id, title, kind, provenance, riskTier, testable, acIds
  ambiguities: z.array(Ambiguity),
  assumptions: z.array(Assumption),
  parseReport: z.object({ parsedCount: z.number().int(), agentCount: z.number().int(), mergedDuplicates: z.number().int(), discarded: z.array(z.object({ reason: z.string(), excerpt: z.string().max(200) })) }),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:**
  - Each requirement needs ≥1 AC when `testable` is true. Otherwise the requirement is added with an automatic ambiguity of severity `high` ("missing acceptance criteria").
  - `nonTestableReason` is required when `testable` is false.
  - When `riskFactors` are absent, conservative defaults apply (see the risk model).
- **Preconditions:** The `PRContext` exists.
- **Postconditions:** An immutable `RequirementSet`. IDs are stable for identical input.
- **Authorization:** P0.
- **Side effects:** Data-root writes.
- **MCP annotations (advisory):** `readOnlyHint: false` (creates a record), `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Identical input produces an identical `requirementSetHash`, and the existing set is returned.
- **Errors:** `E_VALIDATION`, `E_NOT_FOUND`, `E_INPUT_TOO_LARGE`, `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** 10 s.
- **Observability and audit:** Parsed/agent counts and ambiguity severity histogram.
- **Security considerations:** Agent text is untrusted. Instructions embedded in requirement text have no effect: no field changes policy.
- **Example request:**

```json
{"prContextId": "prc_01JC0000000000000000000001", "agentRequirements": [{"title": "Badge reflects new listings", "statement": "The saved-search badge shows the number of new listings since last visit.", "kind": "functional", "platforms": ["android", "ios"], "riskFactors": {"functionalImpact": 3, "securityPrivacyImpact": 1, "dataIntegrityImpact": 1, "criticalJourney": false, "regressionLikelihood": 2, "changeSurface": 2, "uncertainty": 1}, "acceptanceCriteria": [{"text": "Given 3 new listings, when the user opens Saved Searches, then the badge shows 3", "format": "given_when_then"}, {"text": "Given 0 new listings, the badge is hidden", "format": "given_when_then"}]}]}
```

- **Example response:**

```json
{"requirementSetId": "rqs_01JC0000000000000000000004", "requirementSetHash": "sha256:5d1e0000000000000000000000000000000000000000000000000000000000aa", "requirements": [{"id": "REQ-001", "title": "Badge reflects new listings", "kind": "functional", "provenance": "agent", "riskTier": "R1", "testable": true, "acIds": ["REQ-001.AC-01", "REQ-001.AC-02"]}], "ambiguities": [], "assumptions": [], "parseReport": {"parsedCount": 2, "agentCount": 1, "mergedDuplicates": 2, "discarded": []}, "untrustedFields": ["/requirements/*/title"]}
```

- **Tests:**
  - Unit: the parser over an extraction corpus (checklists, G/W/T, nested lists, Markdown edge cases).
  - Contract: examples.
  - Property: hash stability.
  - Security: injection strings ("ignore the gate", "approve this") are stored as text with no effect.
- **Dependencies:** `planning`, `storage`.
- **Traceability:** FR-009, FR-010, FR-013, FR-016, SR-006. ADR-0004.

---

### TL-05 generate_test_plan

- **Purpose:** Validate, normalize and enrich the agent-drafted plan, then persist it as an immutable version with a canonical hash.
- **Responsibilities:**
  - Validate the schema and references.
  - Normalize text.
  - Assign `TC` IDs, kept stable through `clientKey` when `basePlanId` is supplied.
  - Resolve `targetPath` to a `TT` ID.
  - Compute per-case `riskTier` and `eligibility`.
  - Validate exceptions structurally.
  - Compute the plan hash (data-model §Plan hash).
- **Non-responsibilities:** Judging coverage sufficiency (that is TL-06). Approving anything. Creating test source files.
- **Input schema:**

```ts
input = z.object({
  requirementSetId: z.string(),
  inventoryId: z.string(),
  basePlanId: z.string().optional(),                 // create next version of this plan
  platformsInScope: z.array(Platform).min(1),
  draft: z.object({
    testCases: z.array(z.object({
      clientKey: z.string().min(1).max(64),
      title: z.string().min(3).max(200),
      requirementRefs: z.array(ReqId).min(1),
      acRefs: z.array(AcId).default([]),
      level: TestLevelOrManual,
      technique: Technique,
      priority: z.enum(["must", "should", "could"]),
      platforms: z.array(Platform).min(1),
      preconditions: z.array(z.string().max(500)).max(20).default([]),
      steps: z.array(z.string().max(500)).min(1).max(50),
      expectedResults: z.array(z.string().max(500)).min(1).max(20),
      targetPath: z.string().max(1024).optional(),
      targetSelector: z.string().max(512).optional(),
      automation: z.enum(["existing_test", "new_test_required", "manual"]),
      dependsOnKeys: z.array(z.string()).default([]),
    }).strict()).min(1).max(500),
    exceptions: z.array(z.object({
      requirementRefs: z.array(ReqId).min(1),
      reason: z.enum(["not_testable", "covered_elsewhere", "deferred", "out_of_scope"]),
      rationale: z.string().min(20).max(2000),
      evidenceLink: z.string().max(1024).optional(),
      expiresAt: z.string().datetime(),
    }).strict()).max(100).default([]),
    display: z.object({ summary: z.string().max(4000).optional(), narrative: z.string().max(8000).optional() }).strict().optional(),
  }).strict(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  planId: z.string(), version: z.number().int(), planHash: z.string(), hashVersion: z.literal(1),
  testCaseCount: z.number().int(),
  testCases: z.array(z.object({ id: TcId, clientKey: z.string(), title: z.string(), riskTier: RiskTier, eligibility: z.string(), targetRef: z.string().nullable(), priority: z.enum(["must","should","could"]) })).max(200),
  riskSummary: z.record(RiskTier, z.number().int()),
  eligibilitySummary: z.object({ eligible: z.number().int(), ineligible: z.record(z.string(), z.number().int()) }),
  unresolvedTargets: z.array(z.object({ clientKey: z.string(), targetPath: z.string(), reason: z.string() })).max(100),
  warnings: z.array(z.string()).max(50),
  supersedes: z.object({ planId: z.string(), version: z.number().int(), planHash: z.string() }).nullable(),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:**
  - Every `requirementRefs`/`acRefs` entry exists in the set.
  - `existing_test` requires `targetPath` that resolves to an inventory target. Otherwise the case gets `unresolvedTargets` and eligibility `ineligible:no_target`.
  - `dependsOnKeys` must be acyclic.
  - `expiresAt` must be in the future and ≤ 30 days ahead.
  - `covered_elsewhere` requires `evidenceLink`.
  - Plans larger than 500 cases are rejected.
- **Preconditions:** The `RequirementSet` and inventory exist, and the inventory is from the same workspace as the PR context.
- **Postconditions:**
  - An immutable plan version is persisted.
  - When `basePlanId` is given, the previous version gets `superseded_by`, and approvals bound to the previous hash are marked `superseded`.
- **Authorization:** P0.
- **Side effects:** Data-root writes. It may supersede approvals: a state change in the user store, audited.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** If the normalized content produces the same `planHash` as an existing version of the same plan, that version is returned and no new version is created.
  - **Implemented (PLN-003):** any stored plan with the same `planHash` is returned, including when `basePlanId` is omitted, because the hash covers the content and not the plan ID.
  - The output's `testCases` summary is trimmed to stay under the 20,000-character cap, with a warning. The full plan is stored.
  - The previous version's `superseded_by` is derived from the next version's `supersedes`; it is not stored separately.
- **Errors:** `E_VALIDATION` (with JSON pointers), `E_NOT_FOUND`, `E_INPUT_TOO_LARGE`, `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** 15 s.
- **Observability and audit:** Plan size, tier and eligibility histograms. A `plan.versioned` audit event.
- **Security considerations:** `display.*` and all text are untrusted and excluded from hashing where they are presentational. `targetPath` is canonicalized (T-04). No field selects executables.
- **Example request:**

```json
{"requirementSetId": "rqs_01JC0000000000000000000004", "inventoryId": "inv_01JC0000000000000000000003", "platformsInScope": ["host"], "draft": {"testCases": [{"clientKey": "badge-count", "title": "Badge shows new listing count", "requirementRefs": ["REQ-001"], "acRefs": ["REQ-001.AC-01"], "level": "widget", "technique": "positive", "priority": "must", "platforms": ["host"], "preconditions": ["3 new listings stubbed"], "steps": ["Pump SavedSearchBadge with count 3"], "expectedResults": ["Text '3' is visible in badge"], "targetPath": "test/widget/badge_test.dart", "automation": "existing_test"}, {"clientKey": "badge-hidden", "title": "Badge hidden at zero", "requirementRefs": ["REQ-001"], "acRefs": ["REQ-001.AC-02"], "level": "widget", "technique": "boundary", "priority": "must", "platforms": ["host"], "steps": ["Pump SavedSearchBadge with count 0"], "expectedResults": ["Badge widget is not in the tree"], "targetPath": "test/widget/badge_test.dart", "automation": "existing_test"}]}}
```

- **Example response:**

```json
{"planId": "plan_01JC0000000000000000000005", "version": 1, "planHash": "v1:sha256:9f2c000000000000000000000000000000000000000000000000000000000001", "hashVersion": 1, "testCaseCount": 2, "testCases": [{"id": "TC-001", "clientKey": "badge-count", "title": "Badge shows new listing count", "riskTier": "R1", "eligibility": "eligible", "targetRef": "TT-flutter-1a2b3c4d5e6f", "priority": "must"}, {"id": "TC-002", "clientKey": "badge-hidden", "title": "Badge hidden at zero", "riskTier": "R1", "eligibility": "eligible", "targetRef": "TT-flutter-1a2b3c4d5e6f", "priority": "must"}], "riskSummary": {"R0": 0, "R1": 2, "R2": 0, "R3": 0}, "eligibilitySummary": {"eligible": 2, "ineligible": {}}, "unresolvedTargets": [], "warnings": [], "supersedes": null, "untrustedFields": ["/testCases/*/title"]}
```

- **Tests:**
  - Unit: normalization and ID stability across versions.
  - Property: hash determinism, and order independence for set-like fields.
  - Contract: examples.
  - Cross-runtime: the hash is identical on Node 24 and Node 26.
  - Security: `targetPath` traversal, and injection in titles.
- **Dependencies:** `planning`, `core` (hash), `storage`.
- **Traceability:** FR-011 – FR-016, NFR-002. ADR-0004, ADR-0005.

---

### TL-06 validate_test_coverage

- **Purpose:** Evaluate the persisted plan against the persisted requirements using the independent gate. Persist a decision bound to the plan hash.
- **Responsibilities:** Run the GB/GR rules, compute the six metrics and per-requirement status, persist the decision, and report whether it is current.
- **Non-responsibilities:** Authorizing execution (a `pass` is not authorization). Editing plans. Approving exceptions.
- **Input schema:**

```ts
input = z.object({
  planId: z.string(),
  planHash: z.string().regex(/^v\d+:sha256:[0-9a-f]{64}$/),
  findingsCursor: z.string().optional(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  coverageDecisionId: z.string(),
  decision: z.enum(["pass", "fail", "needs_review"]),
  planHash: z.string(), requirementSetHash: z.string(), gatePolicyVersion: z.string(),
  current: z.boolean(),
  findings: z.array(z.object({ ruleId: z.string(), severity: z.enum(["blocker","review","info"]), message: z.string().max(500), refs: z.array(z.string()).max(20) })).max(100),
  findingsNextCursor: z.string().nullable(),
  metrics: CoverageMetrics,
  requirementStatus: z.array(z.object({ requirementId: ReqId, status: RequirementVerificationStatus })).max(200),
  nextSteps: z.array(z.string()).max(5),
})
```

- **Validation rules:** `planHash` must equal the stored and recomputed hash of `planId`'s matching version. Otherwise `E_PLAN_HASH_MISMATCH`.
- **Preconditions:** The plan and its requirement set exist. Gate policy is loaded.
- **Postconditions:** A `CoverageDecision` is persisted. Earlier decisions for other hashes remain, but they are stale for this plan.
- **Authorization:** P0.
- **Side effects:** Data-root writes.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Same `(planHash, requirementSetHash, gatePolicyVersion)` returns the same decision record. **Implemented (COV-004):** the gate is re-evaluated on each call, and the same record is returned while the result is unchanged. A changed result, for example after a human approves an exception or an exception expires, is recorded as a new decision for the same bindings.
- **Errors:** `E_PLAN_NOT_FOUND`, `E_PLAN_HASH_MISMATCH`, `E_POLICY_UNAVAILABLE`, `E_CURSOR_INVALID`.
- **Timeout and cancellation:** 15 s.
- **Observability and audit:** Decision, rule-hit counts, metrics. Audit `coverage.decision`.
- **Security considerations:** The gate reads only persisted, schema-validated data. It never reads `display.*`. Exceptions need an approval at AL2+ to count.
- **Example request:**

```json
{"planId": "plan_01JC0000000000000000000005", "planHash": "v1:sha256:9f2c000000000000000000000000000000000000000000000000000000000001"}
```

- **Example response:**

```json
{"coverageDecisionId": "cov_01JC0000000000000000000006", "decision": "pass", "planHash": "v1:sha256:9f2c000000000000000000000000000000000000000000000000000000000001", "requirementSetHash": "sha256:5d1e0000000000000000000000000000000000000000000000000000000000aa", "gatePolicyVersion": "sha256:77aa000000000000000000000000000000000000000000000000000000000000", "current": true, "findings": [], "findingsNextCursor": null, "metrics": {"requirementCoverage": {"numerator": 1, "denominator": 1, "value": 1}, "testCaseCoverage": {"numerator": 2, "denominator": 2, "value": 1}, "platformCoverage": {"numerator": 1, "denominator": 1, "value": 1}, "regressionCoverage": {"numerator": 0, "denominator": 0, "value": null}, "executionCoverage": null, "sourceCodeCoverage": null}, "requirementStatus": [{"requirementId": "REQ-001", "status": "eligible"}], "nextSteps": ["Call run_tests with this planId and planHash"]}
```

- **Tests:**
  - Unit: each GB/GR rule with positive and negative fixtures.
  - Property: the decision is deterministic.
  - Contract: examples.
  - Security: staleness after plan edit and after policy change. The decision cannot be influenced through `display` text.
- **Dependencies:** `coverage-gate`, `storage` (via `core` ports). **Not** `planning`.
- **Traceability:** FR-017 – FR-020, FR-048. ADR-0005.

---

### TL-07 request_approval

- **Purpose:** Open an approval request for a precise scope. Tell the human how to approve it. Optionally offer MCP elicitation.
- **Responsibilities:**
  - Compute the scope digest and the required assurance level from policy.
  - Persist an `ApprovalRequest`.
  - When the client supports elicitation, return an `input_required` form-mode elicitation asking the human to confirm. Its message shows the scope summary and the CLI command.
  - On `accept`, create an approval at **AL1** only if policy permits AL1 for this scope. Otherwise answer with the CLI instructions.
- **Non-responsibilities:**
  - Granting approval at AL2 or AL3, which happens only through the CLI or an AL3 source.
  - Evaluating coverage.
  - Requesting secrets: form mode never asks for credentials ([RL-003](research-log.md#rl-003--elicitation-in-2026-07-28)).
- **Input schema:**

```ts
input = z.object({
  scope: z.object({
    kind: z.enum(["plan_execution", "coverage_exception", "device_action", "github_publish"]),
    planId: z.string().optional(), planHash: z.string().optional(),
    targets: z.array(z.string()).max(500).optional(),
    environment: z.string().optional(),               // default "local:<hostId>"
    exceptionIds: z.array(z.string()).max(50).optional(),
    deviceAction: z.object({ action: z.enum(["erase","delete","shutdown_non_owned","boot_non_owned"]), deviceId: z.string() }).strict().optional(),
    publish: z.object({ reportId: z.string(), mechanisms: z.array(z.enum(["comment","check_run","commit_status"])).min(1) }).strict().optional(),
  }).strict(),
  justification: z.string().max(2000),                // agent text, shown as untrusted
  offerElicitation: z.boolean().default(true),
  idempotencyKey: z.string().max(128).optional(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  approvalRequestId: z.string(),
  scopeDigest: z.string(),
  requiredAssurance: z.enum(["AL1", "AL2", "AL3"]),
  status: z.enum(["open", "fulfilled", "expired", "withdrawn"]),
  approvalId: z.string().nullable(),                  // set only if fulfilled
  instructions: z.object({ cliCommand: z.string(), expiresAt: z.string() }),
  elicitationOutcome: z.enum(["not_offered", "accepted_insufficient", "accepted", "declined", "cancelled"]),
})
```

- **Validation rules:**
  - Fields must match the kind: `plan_execution` requires `planId` + `planHash` and a current coverage decision of `needs_review` or `pass`. A `fail` decision is rejected with `E_COVERAGE_FAILED`.
  - `github_publish` requires a report whose PR context came from GitHub (with a head SHA). The scope digest covers host, repository, PR number, head SHA, report hash and the mechanism set, sorted and joined with `+`.
  - `environment` must equal this server's environment id (`local:<hostId>`, where `hostId` is the hostname or `AUTOTEST_HOST_ID`); anything else is `E_VALIDATION`.
  - `coverage_exception` takes exactly one entry in `exceptionIds`: each exception is approved on its own, so its approval can be capped at the exception's own expiry.
  - Elicitation: on the 2025-11-25 protocol era the server sends `elicitation/create` when the client advertises the capability; on the 2026 era it returns `input_required`. An `accept` grants AL1 only where policy's minimum for the scope is AL1; otherwise the outcome is `accepted_insufficient`. A decline is reported in `elicitationOutcome`, not as an error.
- **Preconditions:** Policy is loaded and the referenced entities exist.
- **Postconditions:** The request is persisted with an expiry (default 24 h). Nothing is authorized unless an approval of sufficient level exists.
- **Authorization:** P0. It creates a request and never a grant above AL1.
- **Side effects:** Data-root writes. It may display an elicitation dialog.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`. `_meta["anthropic/requiresUserInteraction"]: true`.
- **Idempotency and retry:** The same `idempotencyKey` or an identical open scope digest returns the existing open request.
- **Errors:** `E_VALIDATION`, `E_NOT_FOUND`, `E_COVERAGE_FAILED`, `E_COVERAGE_STALE`, `E_ELICITATION_DECLINED` (informational, `recoverable: true`).
- **Timeout and cancellation:** The elicitation round-trip follows the client. The request itself expires per policy.
- **Observability and audit:** `approval.requested`, plus the elicitation outcome.
- **Security considerations:**
  - `justification` is untrusted and displayed with an "agent-provided" label.
  - An AL1 grant is impossible where policy requires AL2+.
  - The CLI command shown includes the full scope digest. The human must verify it (CLI-001).
- **Example request:**

```json
{"scope": {"kind": "plan_execution", "planId": "plan_01JC0000000000000000000007", "planHash": "v1:sha256:aa11000000000000000000000000000000000000000000000000000000000002"}, "justification": "Gate flagged GR-02 weak assertion on TC-004; reviewer should confirm."}
```

- **Example response:**

```json
{"approvalRequestId": "apr_01JC0000000000000000000008", "scopeDigest": "sha256:c0de000000000000000000000000000000000000000000000000000000000003", "requiredAssurance": "AL2", "status": "open", "approvalId": null, "instructions": {"cliCommand": "autotest approve apr_01JC0000000000000000000008", "expiresAt": "2026-10-23T16:00:00Z"}, "elicitationOutcome": "accepted_insufficient"}
```

- **Tests:**
  - Unit: scope digests.
  - Contract: examples.
  - Integration: elicitation through an SDK test client.
  - Security: the agent cannot create AL2/AL3. An elicitation auto-accept via hook yields AL1 only (SEC-003).
- **Dependencies:** `policy` (verify, assurance), `storage`, `apps/mcp-server` (elicitation).
- **Traceability:** FR-020, FR-021, SR-007. ADR-0006.

---

### TL-08 get_approval_status

- **Purpose:** Report the status of an approval request or approval, and whether it is usable now for a given scope.
- **Responsibilities:** Look up the request and approvals, and evaluate usability (state, expiry, uses, staleness against current hashes and policy).
- **Non-responsibilities:** Creating or modifying approvals.
- **Input schema:**

```ts
input = z.object({
  approvalRequestId: z.string().optional(),
  approvalId: z.string().optional(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  request: z.object({ id: z.string(), status: z.string(), scopeDigest: z.string(), requiredAssurance: z.string(), expiresAt: z.string() }).nullable(),
  approvals: z.array(z.object({ approvalId: z.string(), state: ApprovalState, assuranceLevel: z.string(), source: z.string(), usable: z.boolean(), unusableReasons: z.array(z.string()), expiresAt: z.string(), uses: z.number().int(), maxUses: z.number().int() })).max(20),
})
```

- **Validation rules:** Exactly one of the two IDs must be given.
- **Preconditions:** None.
- **Postconditions:** None (read-only).
- **Authorization:** P0.
- **Side effects:** None. Lazy expiry may update the state from `approved` to `expired`, and that is audited.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Idempotent.
- **Errors:** `E_VALIDATION`, `E_NOT_FOUND`, `E_STORAGE_UNAVAILABLE`, `E_STORAGE_CORRUPT` (the approval record fails its integrity check; it is never reported as usable).
- **Timeout and cancellation:** 2 s.
- **Observability and audit:** Polling counts (a metric, not an audit event).
- **Security considerations:** Approver identity is shown as the OS username only. Approval files are verified against the index; a mismatch reports `unusable: integrity`.
- **Example request:**

```json
{"approvalRequestId": "apr_01JC0000000000000000000008"}
```

- **Example response:**

```json
{"request": {"id": "apr_01JC0000000000000000000008", "status": "fulfilled", "scopeDigest": "sha256:c0de000000000000000000000000000000000000000000000000000000000003", "requiredAssurance": "AL2", "expiresAt": "2026-10-23T16:00:00Z"}, "approvals": [{"approvalId": "appr_01JC0000000000000000000009", "state": "approved", "assuranceLevel": "AL2", "source": "cli", "usable": true, "unusableReasons": [], "expiresAt": "2026-10-23T16:05:00Z", "uses": 0, "maxUses": 3}]}
```

- **Tests:**
  - Unit: the usability matrix.
  - Contract: examples.
  - Security: a tampered approval file is detected.
- **Dependencies:** `policy`, `storage`.
- **Traceability:** FR-021, SR-007. ADR-0006.

---

### TL-09 run_tests

- **Purpose:** Authorize execution of eligible plan targets and create an asynchronous run.
- **Responsibilities:**
  - Evaluate `authorizeExecution` (phase `create`).
  - Persist the run as `queued` along with the authorization decision.
  - Enqueue the run.
  - Return `runId`.
- **Non-responsibilities:**
  - Waiting for completion.
  - Accepting commands, executables or argv.
  - Creating approvals.
  - Collecting evidence (that is TL-15).
- **Input schema:**

```ts
input = z.object({
  planId: z.string(),
  planHash: z.string().regex(/^v\d+:sha256:[0-9a-f]{64}$/),
  targets: z.array(z.string()).max(2000).optional(),  // TC-/TT- ids; default: all eligible must+should
  environment: z.string().default("local"),
  devices: z.array(z.string()).max(10).default([]),
  timeouts: z.object({ runMs: z.number().int().min(60000).max(14400000).optional(), attemptMs: z.number().int().optional(), targetMs: z.number().int().optional() }).strict().optional(),
  retry: z.object({ maxAttempts: z.number().int().min(1).max(3).optional() }).strict().optional(),
  evidence: z.object({ coverage: z.boolean().default(false), screenshots: z.boolean().default(true) }).strict().optional(),
  idempotencyKey: z.string().max(128).optional(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(),
  state: z.literal("queued"),
  authorizationId: z.string(),
  targetsCount: z.number().int(),
  queuePosition: z.number().int(),
  pollAfterMs: z.number().int(),
  limitations: z.array(Limitation),
})
```

- **Validation rules:**
  - The targets must be a subset of the plan's eligible targets. Ineligible targets are rejected with `E_POLICY_DENIED` and reason `target_not_eligible`.
  - Timeouts and `maxAttempts` must be within the policy maximum.
  - `environment` must be allowlisted.
  - Devices (v1.1+): at most one per run. It must be owned by AutoTest (a lease), booted and not held by another run; otherwise `E_DEVICE_NOT_OWNED` or `E_DEVICE_UNAVAILABLE`. Targets that need a device (Flutter `integration_test`, native iOS) require one of the matching platform, otherwise `E_VALIDATION`. The lease is bound to the run and released when results are imported.
- **Preconditions:** A current coverage decision. A usable approval if the decision is `needs_review`. Prerequisites satisfied.
- **Postconditions:** The run row and authorization decision are persisted **before** the response. A `plan_execution` approval use is consumed at dispatch, not at creation, so that a run cancelled while queued does not consume it.
- **Implementation notes (RUN-001 – RUN-006):**
  - Denials map to error codes in this order: policy unavailable, plan hash/superseded, coverage, request-shape reasons (`target_not_eligible`, `environment_not_allowed`, `workspace_not_allowed`, `device_not_allowed`, `command_denied` → `E_POLICY_DENIED`), approval, prerequisites. `details.reasons` lists every reason.
  - Unresolved dependencies (Flutter: no `.dart_tool/package_config.json`) refuse the run with `E_PREREQUISITE_MISSING` and `details.prerequisites: ["pub_get"]`.
  - `retry.maxAttempts` defaults to `1 + execution.maxRetries` and may not exceed it; `timeouts.runMs` may not exceed `execution.defaultTimeoutMs`. Both are refused with `E_POLICY_DENIED`.
  - Dispatch re-evaluates authorization and compares a binding digest (plan id, version and hash, environment, policy version, workspace, targets, spec digests) with the one recorded at creation; a difference or a denial cancels the run with `authorization_invalidated`.
  - A run uses one platform adapter; targets of different adapters are refused with `E_CAPABILITY_UNAVAILABLE`.
- **Authorization:** P1. It is unattended within policy for `pass`, and needs an AL2+ approval for `needs_review` (local).
- **Side effects:** Spawns a supervisor (asynchronously). Writes to the data root. Executes test code (TB-5).
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.
- **Idempotency and retry:** Supports `idempotencyKey`. Without a key, every call creates a new run.
- **Errors:** `E_PLAN_NOT_FOUND`, `E_PLAN_HASH_MISMATCH`, `E_COVERAGE_MISSING`, `E_COVERAGE_STALE`, `E_COVERAGE_FAILED`, `E_APPROVAL_REQUIRED`, `E_APPROVAL_STALE`, `E_APPROVAL_EXPIRED`, `E_APPROVAL_REVOKED`, `E_APPROVAL_EXHAUSTED`, `E_ASSURANCE_INSUFFICIENT`, `E_POLICY_DENIED`, `E_PREREQUISITE_MISSING`, `E_CAPABILITY_UNAVAILABLE`, `E_QUEUE_FULL`, `E_IDEMPOTENCY_CONFLICT`, `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** Returns within 2 s at p95 (NFR-003). Run-level timeouts apply asynchronously. Cancel via TL-12.
- **Observability and audit:** `authorization.decision` (create), `run.created`, queue depth.
- **Security considerations:**
  - No command input surface exists.
  - At dispatch, authorization is re-evaluated, and an `inputsDigest` change cancels the run.
  - `exec` re-validates every spawn.
  - Runs execute repo code: see T-02 and T-05 in the [threat model](security-threat-model.md).
- **Example request:**

```json
{"planId": "plan_01JC0000000000000000000005", "planHash": "v1:sha256:9f2c000000000000000000000000000000000000000000000000000000000001", "idempotencyKey": "pr-local-badge-1"}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "state": "queued", "authorizationId": "authz_01JC000000000000000000000B", "targetsCount": 1, "queuePosition": 0, "pollAfterMs": 3000, "limitations": []}
```

- **Tests:**
  - Unit: authorization reason matrix.
  - Contract: examples.
  - Integration: create → dispatch on the fixture.
  - Security (SEC-003): stale decision, edited plan, revoked approval between create and dispatch, ineligible target, idempotency conflict.
- **Dependencies:** `workflow` → `policy`, `execution`, `storage`.
- **Baseline runs (ANL-002, v0.3):** `baseline: { ref? }` runs the selected targets at the base commit instead of the workspace checkout.
  - `ref` defaults to the PR context's `base.sha` (GitHub mode); a manual context must name a branch, tag or commit. The ref is resolved with `git rev-parse` in the workspace repository; AutoTest never fetches (`E_PREREQUISITE_MISSING`, `baseline_ref_missing`).
  - The commit is checked out as a detached git worktree at `<runDir>/baseline` (hooks off, no transport, no LFS smudge; the `git` argument schema allows nothing else). It is removed when the run ends, on import, and by `autotest cleanup`.
  - Resolved dependencies are copied from the workspace only when the adapter's lock files are identical at both commits (Flutter: `pubspec.lock`); otherwise `E_PREREQUISITE_MISSING` with `baseline_dependencies_differ`.
  - Targets whose test file does not exist at the base commit are left out, with the limitation `baseline_target_missing`.
  - Authorization is the same as for any run of the plan (the approval scope covers the targets actually run). The worktree counts against the run's disk quota.
- **Traceability:** FR-022, FR-023, FR-026 – FR-028, FR-047, SR-001, SR-008. ADR-0006, ADR-0007, ADR-0014.

---

### TL-10 get_run_status

- **Purpose:** Return the current state and progress of a run.
- **Responsibilities:** Import new supervisor events, then return the state, `statusCategory`, counts, cancel/infra reasons, survivors and the next poll hint.
- **Non-responsibilities:** Per-test details (TL-11). Evidence content.
- **Input schema:**

```ts
input = z.object({ runId: z.string() }).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(),
  state: RunState,
  statusCategory: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  cancelReason: z.string().nullable(), infraReason: z.string().nullable(),
  progress: z.object({ attemptsStarted: z.number().int(), attemptsFinished: z.number().int(), testsByOutcome: z.partialRecord(TestOutcome, z.number().int()) }),
  survivors: z.array(z.object({ pid: z.number().int(), executable: z.string() })).max(20),
  partial: z.boolean(),
  limitations: z.array(Limitation),
  createdAt: z.string(), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  pollAfterMs: z.number().int().nullable(),
})
```

- **Validation rules:** `runId` format.
- **Preconditions:** None.
- **Postconditions:** SQLite reflects the latest events.
- **Authorization:** P0.
- **Side effects:** Event import (data root).
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Idempotent.
- **Errors:** `E_RUN_NOT_FOUND`, `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** 2 s.
- **Observability and audit:** Poll counts (a metric).
- **Security considerations:** No secrets. Executable names only (no argv).
- **Example request:**

```json
{"runId": "run_01JC000000000000000000000A"}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "state": "running", "statusCategory": "running", "cancelReason": null, "infraReason": null, "progress": {"attemptsStarted": 1, "attemptsFinished": 0, "testsByOutcome": {"passed": 1}}, "survivors": [], "partial": false, "limitations": [], "createdAt": "2026-10-22T16:00:00Z", "startedAt": "2026-10-22T16:00:02Z", "endedAt": null, "pollAfterMs": 5000}
```

- **Tests:**
  - Unit: state-to-category mapping.
  - Contract: examples.
  - Integration: event import after a server restart.
  - Resilience: polling during reconciliation.
- **Dependencies:** `execution`, `storage`.
- **Traceability:** FR-024, FR-029. ADR-0007.

---

### TL-11 get_run_results

- **Purpose:** Paged per-test results of a run.
- **Responsibilities:** Return normalized `TestResult`s, filtered and paged from an immutable snapshot (taken at the first call or when the run reaches a terminal state).
- **Non-responsibilities:** Classification (TL-16). Artifact contents.
- **Input schema:**

```ts
input = z.object({
  runId: z.string(),
  filter: z.object({ outcomes: z.array(TestOutcome).optional(), targetId: z.string().optional(), flakyOnly: z.boolean().optional() }).strict().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(), runState: RunState, snapshotFinal: z.boolean(),
  totals: z.partialRecord(TestOutcome, z.number().int()),
  results: z.array(z.object({ resultId: z.string(), targetId: z.string(), testCaseIds: z.array(TcId), name: z.string().max(500), outcome: TestOutcome, failureKind: z.string().nullable(), blockedReason: z.string().nullable(), flaky: z.boolean(), attemptNo: z.number().int(), durationMs: z.number().int().nullable(), messageExcerpt: z.string().max(2048).nullable(), artifactIds: z.array(z.string()).max(10) })),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:** Cursor bound to the run and the filter.
- **Preconditions:** The run exists.
- **Postconditions:** None.
- **Authorization:** P0.
- **Side effects:** None.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Idempotent per cursor.
- **Errors:** `E_RUN_NOT_FOUND`, `E_CURSOR_INVALID`.
- **Timeout and cancellation:** 3 s.
- **Observability and audit:** Page sizes (a metric).
- **Security considerations:** `messageExcerpt` is redacted and untrusted. Planned-but-not-executed cases appear as `not_run` and are never omitted.
- **Implementation note:** results are imported once the run is terminal (merged across attempts, every planned target accounted for); before that the tool returns no rows with `snapshotFinal: false`, and progress is reported by `get_run_status`.
- **Example request:**

```json
{"runId": "run_01JC000000000000000000000A", "filter": {"outcomes": ["failed", "timed_out"]}, "limit": 50}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "runState": "completed", "snapshotFinal": true, "totals": {"passed": 1, "failed": 1}, "results": [{"resultId": "res_01JC000000000000000000000C", "targetId": "TT-flutter-1a2b3c4d5e6f", "testCaseIds": ["TC-002"], "name": "badge hidden at zero", "outcome": "failed", "failureKind": "assertion", "blockedReason": null, "flaky": false, "attemptNo": 1, "durationMs": 412, "messageExcerpt": "Expected: no matching nodes\n  Actual: _WidgetTypeFinder:<exactly one widget with type \"Badge\">", "artifactIds": ["art_01JC000000000000000000000D"]}], "nextCursor": null, "truncated": false, "untrustedFields": ["/results/*/name", "/results/*/messageExcerpt"]}
```

- **Tests:**
  - Unit: filters.
  - Contract: pagination of 2,000 results.
  - Security: a redaction canary in a failure message.
- **Dependencies:** `storage`.
- **Traceability:** FR-024, FR-039, NFR-004.

---

### TL-12 cancel_test_run

- **Purpose:** Request cancellation of a run with verified termination.
- **Responsibilities:** Write the cancel control, signal the supervisor, and return `cancelling`, `cancelled`, `cancel_pending` or the existing terminal state.
- **Non-responsibilities:** Killing processes that are not managed by the run (identity checks). Deleting artifacts.
- **Input schema:**

```ts
input = z.object({ runId: z.string(), reason: z.string().max(500).optional() }).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(),
  state: RunState,
  alreadyTerminal: z.boolean(),
  survivors: z.array(z.object({ pid: z.number().int(), executable: z.string() })).max(20),
  pollAfterMs: z.number().int().nullable(),
})
```

- **Validation rules:** `runId` exists.
- **Preconditions:** None.
- **Postconditions:** A non-terminal run moves to `cancelling` (or, if `queued`, directly through to `cancelled`). `cancelled` is never reported without confirmed termination.
- **Authorization:** P1. It affects only run-owned processes.
- **Side effects:** Signals to identity-verified processes.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Repeated calls return the current state. Calling on a terminal run returns `alreadyTerminal: true` and is not an error.
- **Errors:** `E_RUN_NOT_FOUND`, `E_STORAGE_UNAVAILABLE`.
- **Timeout and cancellation:** Returns within 2 s. Escalation proceeds asynchronously (grace 10 s, verification window 10 min).
- **Observability and audit:** `run.cancel_requested`, `run.transition`, survivors.
- **Security considerations:** Never signals a process whose identity cannot be verified (PID-reuse defense, ADR-0007).
- **Example request:**

```json
{"runId": "run_01JC000000000000000000000A", "reason": "User aborted"}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "state": "cancelling", "alreadyTerminal": false, "survivors": [], "pollAfterMs": 2000}
```

- **Tests:**
  - Unit: transitions.
  - Integration: a SIGTERM-ignoring fixture, an unkillable child simulation, and cancel while queued.
  - Security: a forged PID in the records is never signalled.
- **Dependencies:** `execution`, `exec`, `storage`.
- **Traceability:** FR-025. ADR-0007.

---

### TL-13 list_devices

- **Purpose:** Enumerate simulators, emulators and connected devices, with availability and ownership. Report host capability.
- **Responsibilities:** Run allowlisted read-only listing commands (`xcrun simctl list devices --json`, `adb devices -l`, `emulator -list-avds`). Normalize the output. Mark AutoTest-owned devices. Distinguish `unsupported_on_host` from `unavailable`.
- **Non-responsibilities:** Booting or modifying devices.
- **Input schema:**

```ts
input = z.object({ platform: z.enum(["ios", "android", "all"]).default("all"), includeUnavailable: z.boolean().default(false) }).strict()
```

- **Output schema:**

```ts
output = z.object({
  host: z.object({ os: z.string(), simctl: z.boolean(), adb: z.boolean(), emulator: z.boolean() }),
  devices: z.array(z.object({ deviceId: z.string(), platform: z.enum(["ios","android"]), kind: z.enum(["simulator","emulator","physical"]), name: z.string(), osVersion: z.string().nullable(), state: z.string(), availability: z.enum(["available","busy","unavailable"]), owned: z.boolean(), leaseId: z.string().nullable() })).max(100),
  unsupported: z.array(z.object({ platform: z.string(), reason: z.string() })),
})
```

- **Validation rules:** —
- **Preconditions:** None. Missing tools are reported, not raised as errors.
- **Postconditions:** None.
- **Authorization:** P0.
- **Side effects:** Read-only probes.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Idempotent (reflects the current state).
- **Errors:** `E_TIMEOUT` (15 s), `E_POLICY_UNAVAILABLE`.
- **Timeout and cancellation:** 15 s total.
- **Observability and audit:** Device counts.
- **Security considerations:** Physical device serials are hashed in logs and shown in the output only to the local agent.
- **Example request:**

```json
{"platform": "ios"}
```

- **Example response:**

```json
{"host": {"os": "macos", "simctl": true, "adb": false, "emulator": false}, "devices": [{"deviceId": "A1B2C3D4-0000-0000-0000-000000000001", "platform": "ios", "kind": "simulator", "name": "iPhone 16", "osVersion": "18.6", "state": "Shutdown", "availability": "available", "owned": false, "leaseId": null}], "unsupported": [{"platform": "android", "reason": "adb not found on policy allowlist"}]}
```

- **Tests:**
  - Unit: parser fixtures for simctl JSON and adb output.
  - Contract: examples.
  - Integration (macOS CI): live listing.
- **Dependencies:** `devices`, `exec`, `policy`.
- **Implementation notes (v1.1, DEV-001):** device ids are the simulator UDID, the AVD name for an Android emulator (stable across boots; its serial is looked up with `adb emu avd name`), and the adb serial for a physical device. `owned` is true only for a device whose lease AutoTest created; a name like `autotest-…` alone never makes a device owned. Missing tools are reported in `unsupported` (`… is not on the policy allowlist`).
- **Traceability:** FR-035, SR-011.

---

### TL-14 manage_simulator

- **Purpose:** Perform approved lifecycle actions on simulators and emulators.
- **Responsibilities:**
  - Enforce the ownership and tier policy.
  - Create devices tagged as AutoTest-owned: name prefix `autotest-` plus a lease record.
  - Boot or shut down owned devices.
  - Erase or delete only owned devices without approval. Non-owned devices require P2 approval.
  - v1.4 (B3): `acquire {platform, deviceType?, runtime?, allowAdopt = true}` returns a booted device for a run: a free AutoTest device (`reused`, P1), else a user simulator or AVD already approved for this host with a valid lease, else one of the user's free simulators or AVDs (never physical) after a single-use `device_action` approval `use_non_owned` (`adopted`, P2; the lease is not ownership and ends with the run; AutoTest never erases, deletes or shuts it down on its own), else a new AutoTest device (`created`; the request's type and runtime or the newest installed defaults; at most `devices.maxOwned`, default 2, per platform, else `E_DEVICE_UNAVAILABLE`). `create` is idempotent: a free AutoTest device of the same type and runtime is returned as `reused`.
  - v1.2 (RN-003): `install` an app built beforehand (`install: {workspace, appPath}`: a `.app` bundle for a simulator, a `.apk` for an emulator, inside an allowlisted workspace) on a booted device AutoTest owns (P1). Devices AutoTest does not own are refused (`E_DEVICE_NOT_OWNED`), not approved.
- **Non-responsibilities:** Physical devices (never erased). Installing runtimes. Building apps.
- **Input schema:**

```ts
input = z.object({
  action: z.enum(["boot", "shutdown", "create", "erase", "delete", "install", "acquire"]),
  deviceId: z.string().optional(),
  create: z.object({ platform: z.enum(["ios","android"]), deviceType: z.string().max(100), runtime: z.string().max(100) }).strict().optional(),
  install: z.object({ workspace: z.string().max(64), appPath: z.string().max(1024) }).strict().optional(), // v1.2, action "install" only
  acquire: z.object({ platform: z.enum(["ios","android"]), deviceType: z.string().max(100).optional(), runtime: z.string().max(100).optional(), allowAdopt: z.boolean().default(true) }).strict().optional(), // v1.4, action "acquire" only
  runId: z.string().optional(),
  approvalId: z.string().optional(),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  action: z.string(), deviceId: z.string(), owned: z.boolean(),
  tierApplied: z.enum(["P1", "P2"]),
  result: z.enum(["done", "already_in_state"]),
  leaseId: z.string().nullable(),
  state: z.string(),
})
```

- **Validation rules:**
  - `create` requires `create.*`. Other actions require `deviceId`.
  - The action must be supported on the host.
  - Physical devices are rejected with `E_POLICY_DENIED`.
- **Preconditions:** v1.1+ capability. In v0.x the tool returns `E_CAPABILITY_UNAVAILABLE`.
- **Postconditions:** A lease is recorded for owned devices. Ownership is never transferred to non-owned devices.
- **Authorization:**

  | Action | Owned device | Non-owned device |
  |---|---|---|
  | boot, shutdown, create, erase, delete | P1 | — |
  | boot, shutdown | — | P2 + AL2 approval (`device_action`) |
  | erase, delete | — | P2 + AL2 approval |
  | physical device | never | never |

- **Side effects:** Device state changes.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** State-targeting, so a repeated boot of a booted device gives `already_in_state`. A boot failure is retried once.
- **Errors:** `E_CAPABILITY_UNAVAILABLE`, `E_DEVICE_UNAVAILABLE`, `E_DEVICE_NOT_OWNED`, `E_APPROVAL_REQUIRED`, `E_APPROVAL_STALE`, `E_POLICY_DENIED`, `E_TIMEOUT` (boot 180 s).
- **Timeout and cancellation:** Boot 180 s, other actions 60 s.
- **Observability and audit:** `device.action` with the tier and approval ID.
- **Security considerations:** Protects the user's personal simulators (T-10). Approval scope digest = `(action, deviceId, hostId)`. Single use.
- **Example request:**

```json
{"action": "create", "create": {"platform": "ios", "deviceType": "iPhone 16", "runtime": "iOS 18.6"}, "runId": "run_01JC000000000000000000000A"}
```

- **Example response:**

```json
{"action": "create", "deviceId": "A1B2C3D4-0000-0000-0000-0000000000AA", "owned": true, "tierApplied": "P1", "result": "done", "leaseId": "lease_01JC000000000000000000000E", "state": "Shutdown"}
```

- **Tests:**
  - Unit: the tier matrix.
  - Integration (macOS): create, boot, erase on owned devices.
  - Security: erasing a non-owned device without approval is denied. Spoofed `autotest-` names on non-leased devices are not treated as owned (ownership = lease record + UDID).
- **Dependencies:** `devices`, `policy`, `storage`.
- **Implementation notes (v1.1, DEV-002):**
  - `create`: iOS takes a device type and runtime by name or identifier (`iPhone 17e`, `iOS 26.4`); Android takes a hardware profile (`pixel_7`) and `android-<level>` (resolved to an installed system image for the host ABI) or a full `system-images;…` id. The name is `autotest-<ulid>`; the lease lasts 24 h and a boot for a run extends it.
  - Android `erase` boots once with `-wipe-data` and shuts down again; `boot` starts the emulator headless (`-no-window -no-snapshot`) on a free even port and waits for `sys.boot_completed` (180 s). An emulator that refuses to start (for example for lack of disk space) is `E_DEVICE_UNAVAILABLE` with its reason.
  - Approval actions for devices AutoTest does not own: `boot_non_owned`, `shutdown_non_owned`, `erase`, `delete` (the `deviceAction.action` of `request_approval`).
  - `autotest cleanup` deletes owned devices whose lease expired and no running run uses; `doctor` warns about them.
- **Traceability:** FR-036, SR-011.

---

### TL-15 collect_test_evidence

- **Purpose:** List a run's artifacts with integrity metadata, and optionally return bounded, redacted excerpts.
- **Responsibilities:**
  - Ensure ingestion has run (trigger it for terminal runs not yet ingested).
  - Return metadata and quarantine status.
  - Return redacted excerpts of text artifacts on request.
- **Non-responsibilities:** Returning raw logs, binary contents, or quarantined content.
- **Input schema:**

```ts
input = z.object({
  runId: z.string(),
  kinds: z.array(ArtifactKind).optional(),
  include: z.enum(["metadata", "excerpt"]).default("metadata"),
  excerptBytes: z.number().int().min(256).max(8192).default(2048),
  artifactIds: z.array(z.string()).max(20).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(), partial: z.boolean(),
  artifacts: z.array(ArtifactRef.extend({ redactionApplied: z.boolean(), truncated: z.boolean(), provenance: z.object({ producer: z.string(), toolVersion: z.string().nullable() }), excerpt: z.string().nullable() })),
  quarantinedCount: z.number().int(),
  nextCursor: z.string().nullable(),
  untrustedFields: z.array(z.string()),
})
```

- **Validation rules:** `excerpt` only for text MIME types. `artifactIds` must belong to the run.
- **Preconditions:** The run exists.
- **Postconditions:** For a terminal run, the evidence index is complete.
- **Authorization:** P0.
- **Side effects:** It may trigger ingestion, which writes redacted copies into the run's data root.
- **MCP annotations (advisory):** `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** Idempotent.
- **Errors:** `E_RUN_NOT_FOUND`, `E_CURSOR_INVALID`, `E_ARTIFACT_QUARANTINED` (when a requested ID is quarantined), `E_REDACTION_FAILED`.
- **Timeout and cancellation:** 20 s, which can include ingestion.
- **Observability and audit:** `artifact.ingested`, `artifact.quarantined`.
- **Security considerations:** Path containment, no symlinks, MIME sniffing, size caps, fail-closed redaction (SR-005, SR-012). Excerpts are untrusted.
- **Example request:**

```json
{"runId": "run_01JC000000000000000000000A", "kinds": ["junit", "stderr"], "include": "excerpt", "excerptBytes": 1024}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "partial": false, "artifacts": [{"artifactId": "art_01JC000000000000000000000F", "kind": "junit", "sizeBytes": 1840, "sha256": "sha256:ab12000000000000000000000000000000000000000000000000000000000004", "mimeType": "application/xml", "quarantined": false, "uri": "autotest://runs/run_01JC000000000000000000000A/artifacts/art_01JC000000000000000000000F", "redactionApplied": true, "truncated": false, "provenance": {"producer": "flutter", "toolVersion": "3.38.4"}, "excerpt": "<testsuites tests=\"2\" failures=\"1\">..."}], "quarantinedCount": 0, "nextCursor": null, "untrustedFields": ["/artifacts/*/excerpt"]}
```

- **Tests:**
  - Unit: MIME and size rules.
  - Integration: ingestion of the fixture run.
  - Security: a symlinked artifact, a 2 GiB artifact, a secret canary in stderr (must be redacted), and binary disguised as text.
- **Dependencies:** `evidence`, `policy`, `storage`.
- **Traceability:** FR-037, SR-005, SR-012.

---

### TL-16 analyze_test_failures

- **Purpose:** Classify failed and indeterminate results using rule-based signals, with evidence and conservative confidence.
- **Responsibilities:**
  - Apply the classification rules ([observability §Failure classification](observability-and-failure-analysis.md#failure-classification)).
  - Compare against the baseline and the known-failure registry.
  - Emit observations, inference, alternatives and next steps.
- **Non-responsibilities:**
  - Emitting `product_defect` as `confirmed`.
  - Re-running tests.
  - Calling an LLM.
- **Input schema:**

```ts
input = z.object({
  runId: z.string(),
  resultIds: z.array(z.string()).max(200).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  runId: z.string(), rulesetVersion: z.string(),
  summary: z.partialRecord(FailureClass, z.number().int()),
  analyses: z.array(z.object({ analysisId: z.string(), resultId: z.string(), class: FailureClass, subtype: z.string(), strength: z.enum(["hypothesis", "supported"]), confidence: z.number().min(0).max(1), observations: z.array(z.object({ text: z.string().max(500), artifactId: z.string().nullable() })).max(10), inference: z.string().max(1000), alternatives: z.array(z.object({ class: FailureClass, subtype: z.string(), confidence: z.number() })).max(4), nextSteps: z.array(z.string().max(300)).max(5) })),
  nextCursor: z.string().nullable(),
})
```

- **Validation rules:** The run is terminal, otherwise `E_REPORT_NOT_READY`. `resultIds` belong to the run.
- **Preconditions:** Evidence has been ingested.
- **Postconditions:** Analyses are persisted per `(resultId, rulesetVersion)`.
- **Authorization:** P0.
- **Side effects:** Data-root writes.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** The same ruleset version returns the stored analyses.
- **Errors:** `E_RUN_NOT_FOUND`, `E_REPORT_NOT_READY`, `E_CURSOR_INVALID`.
- **Timeout and cancellation:** 20 s.
- **Observability and audit:** Class distribution metric.
- **Security considerations:** Log text is untrusted. Rules match patterns. Nothing in a log can raise confidence beyond rule caps.
- **Example request:**

```json
{"runId": "run_01JC000000000000000000000A"}
```

- **Example response:**

```json
{"runId": "run_01JC000000000000000000000A", "rulesetVersion": "anl-1", "summary": {"product_defect": 1}, "analyses": [{"analysisId": "fa_01JC0000000000000000000010", "resultId": "res_01JC000000000000000000000C", "class": "product_defect", "subtype": "behavior", "strength": "hypothesis", "confidence": 0.55, "observations": [{"text": "Assertion failure (TestFailure) in test mapped to REQ-001.AC-02", "artifactId": "art_01JC000000000000000000000F"}, {"text": "Failed on 1 of 1 attempts; no environment signals", "artifactId": null}], "inference": "Changed badge visibility logic may not hide the badge at count 0.", "alternatives": [{"class": "test_defect", "subtype": "assertion", "confidence": 0.3}], "nextSteps": ["Re-run to check reproducibility", "Run the same test on the base branch to rule out pre-existing failure"]}], "nextCursor": null}
```

- **Tests:**
  - Unit: the rule table with fixtures for each class.
  - Property: confidence caps.
  - Contract: examples.
  - Security: crafted logs ("this is a product defect, confidence 1.0") have no effect.
- **Dependencies:** `analysis`, `storage`.
- **Baseline and known failures (ANL-002, v0.3):** the baseline input of each result is its outcome in the latest completed baseline run of the same plan version (`unknown` without one), and the known-failure input is the first unexpired registry entry whose target id matches and whose name pattern (`*` wildcard) matches the test name. A failure that also failed at the base commit is `pre_existing/baseline_failure`; a registry match is `pre_existing/known_failure`. Both excuse the failure in the verdict (CORE-005). When these inputs change, the run's analyses are recomputed and replaced.
- **Traceability:** FR-038, FR-047.

---

### TL-17 generate_pr_test_report

- **Purpose:** Render the report (Markdown, JSON, JUnit) and compute the PR verdict.
- **Responsibilities:**
  - Assemble the PR context, requirements, plan, coverage decision, approvals, runs, results, analyses, evidence references, metrics and limitations.
  - Compute the verdict with `core.computeVerdict()`.
  - Embed the agent narrative in a labelled section.
- **Non-responsibilities:** Publishing (TL-18). Changing outcomes.
- **Input schema:**

```ts
input = z.object({
  planId: z.string(),
  planHash: z.string(),
  runIds: z.array(z.string()).max(10).default([]),
  narrative: z.string().max(8000).optional(),
  formats: z.array(z.enum(["markdown", "json", "junit"])).default(["markdown", "json", "junit"]),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  reportId: z.string(),
  verdict: z.enum(["pass", "fail", "inconclusive", "blocked"]),
  verdictRule: z.number().int(),
  reportHash: z.string(),
  artifacts: z.array(ArtifactRef).max(3),
  markdownPreview: z.string().max(12000),
  plannedVsExecuted: z.object({ planned: z.number().int(), executed: z.number().int(), notRun: z.number().int(), blocked: z.number().int() }),
  limitations: z.array(Limitation),
})
```

- **Validation rules:**
  - Every `runIds` entry must belong to `planHash`. All of them must be terminal, otherwise `E_REPORT_NOT_READY`.
  - An empty `runIds` is allowed and yields `blocked` (rule 1 or 2).
- **Preconditions:** A coverage decision exists for `planHash`.
- **Postconditions:** The report is persisted, and `reportHash` = sha256 of the JCS of the JSON report.
- **Authorization:** P0.
- **Side effects:** Data-root writes.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- **Idempotency and retry:** The same inputs give the same `reportHash`, and the existing report is returned.
- **Errors:** `E_PLAN_NOT_FOUND`, `E_PLAN_HASH_MISMATCH`, `E_COVERAGE_MISSING`, `E_REPORT_NOT_READY`, `E_RUN_NOT_FOUND`.
- **Timeout and cancellation:** 20 s.
- **Observability and audit:** `report.generated` with the verdict.
- **Security considerations:**
  - Quarantined artifacts are excluded.
  - Narrative text is marked "agent-written, not verified".
  - Content is redacted.
  - The report never lists a non-executed test as passed (FR-039).
- **Example request:**

```json
{"planId": "plan_01JC0000000000000000000005", "planHash": "v1:sha256:9f2c000000000000000000000000000000000000000000000000000000000001", "runIds": ["run_01JC000000000000000000000A"], "narrative": "Badge visibility at zero appears regressed."}
```

- **Example response:**

```json
{"reportId": "rpt_01JC0000000000000000000011", "verdict": "fail", "verdictRule": 3, "reportHash": "sha256:feed000000000000000000000000000000000000000000000000000000000005", "artifacts": [{"artifactId": "art_01JC0000000000000000000012", "kind": "report", "sizeBytes": 6120, "sha256": "sha256:feed000000000000000000000000000000000000000000000000000000000006", "mimeType": "text/markdown", "quarantined": false, "uri": "autotest://runs/run_01JC000000000000000000000A/artifacts/art_01JC0000000000000000000012"}], "markdownPreview": "# AutoTest report: Add saved-search badge\n**Verdict: FAIL** (rule 3) ...", "plannedVsExecuted": {"planned": 2, "executed": 2, "notRun": 0, "blocked": 0}, "limitations": []}
```

- **Tests:**
  - Unit: every verdict-table row.
  - Snapshot: Markdown and JSON.
  - JUnit: schema validation.
  - Security: a quarantined artifact excluded, and a narrative injection rendered inert (Markdown escaping, no raw HTML).
- **Dependencies:** `reporting`, `core`, `storage`.
- **Traceability:** FR-039, FR-049.

---

### TL-18 publish_github_report

- **Purpose:** Publish a generated report to GitHub, but only with P3 authorization. The publication is idempotent and least-privilege.
- **Responsibilities:**
  - Verify the authorization (approval or pre-authorization scope digest).
  - Probe the available mechanisms.
  - Upsert the comment (by marker), create or update the check run (`external_id`), or set a commit status.
  - Report the result per mechanism.
  - Audit everything.
- **Non-responsibilities:** Merging. Approving PRs. Labelling. Any write not listed.
- **Input schema:**

```ts
input = z.object({
  reportId: z.string(),
  mechanisms: z.array(z.enum(["comment", "check_run", "commit_status"])).min(1),
  approvalId: z.string().optional(),
  dryRun: z.boolean().default(false),
}).strict()
```

- **Output schema:**

```ts
output = z.object({
  reportId: z.string(), scopeDigest: z.string(), dryRun: z.boolean(),
  results: z.array(z.object({ mechanism: z.enum(["comment","check_run","commit_status"]), status: z.enum(["published","updated","skipped","failed","would_publish"]), remoteId: z.string().nullable(), url: z.string().nullable(), errorCode: z.string().nullable() })),
})
```

- **Validation rules:**
  - The report has a GitHub PR context with `head.sha`.
  - Mechanisms must be enabled in config.
  - `dryRun` does not require authorization and performs no writes.
- **Preconditions:** A usable `github_publish` approval or a matching pre-authorization. A write credential is configured.
- **Postconditions:**
  - Publication records exist per `(scopeDigest, mechanism)`.
  - A single-use approval is consumed.
  - A partial failure leaves the successful mechanisms recorded.
- **Authorization:** P3. Requires AL2 locally, or a CI pre-authorization or AL3 (ADR-0006). The credential matrix is in ADR-0013.
- **Side effects:** External writes to GitHub.
- **MCP annotations (advisory):** `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. `_meta["anthropic/requiresUserInteraction"]: true`.
- **Idempotency and retry:**
  - Comments are upserted by marker.
  - Check runs use `external_id`.
  - Statuses use a fixed context string `autotest/<planId>`.
  - Retries use backoff, up to 5 times, honouring `retry-after`.
  - Republishing the same scope returns `updated` or `skipped`.
- **Errors:** `E_APPROVAL_REQUIRED`, `E_APPROVAL_STALE`, `E_APPROVAL_EXHAUSTED`, `E_ASSURANCE_INSUFFICIENT`, `E_GITHUB_AUTH`, `E_GITHUB_PERMISSION`, `E_GITHUB_FEATURE_UNAVAILABLE`, `E_GITHUB_RATE_LIMITED`, `E_GITHUB_UNAVAILABLE`, `E_NOT_FOUND`.
- **Timeout and cancellation:** 60 s overall.
- **Observability and audit:** A `github.write` audit event per mechanism, with the remote ID. Rate-limit metrics.
- **Security considerations:**
  - Only redacted, non-quarantined content is published.
  - The comment body is length-capped, with a link to the artifacts.
  - No secret, raw log or screenshot is ever posted.
  - Credentials are resolved by `secretRef`.
- **Implementation notes (v0.2, GH-005):**
  - github.com only. The credential is the user's `gh` login (`gh auth token`, allowlisted executable) unless `credentialRef` is set; there is no CI pre-authorization.
  - The commit status context is `autotest` (one per commit), not `autotest/<planId>`.
  - A `gh` user token cannot create check runs. `check_run` then reports `failed` with `E_GITHUB_FEATURE_UNAVAILABLE`, and a commit status is written as the fallback, covered by the same approval.
  - Publication is off unless `github.publication.enabled` is true and the mechanism is listed (`E_POLICY_DENIED`).
- **Example request:**

```json
{"reportId": "rpt_01JC0000000000000000000011", "mechanisms": ["comment", "commit_status"], "approvalId": "appr_01JC0000000000000000000013"}
```

- **Example response:**

```json
{"reportId": "rpt_01JC0000000000000000000011", "scopeDigest": "sha256:0b0b000000000000000000000000000000000000000000000000000000000007", "dryRun": false, "results": [{"mechanism": "comment", "status": "published", "remoteId": "IC_kwDOA0000001", "url": "https://ghe.example.com/org/app/pull/42#issuecomment-1", "errorCode": null}, {"mechanism": "commit_status", "status": "published", "remoteId": "autotest/plan_01JC0000000000000000000005", "url": null, "errorCode": null}]}
```

- **Tests:**
  - Unit: the scope digest and the marker.
  - Integration: recorded GHES fixtures (comment upsert, checks-disabled fallback, 429).
  - Security: no write without authorization, single-use enforcement, and a redaction canary never published.
- **Dependencies:** `github`, `policy`, `reporting`, `storage`.
- **Traceability:** FR-040, FR-041, SR-009. ADR-0013, ADR-0006.

## 5. Contract test strategy (summary)

- Every example in this document is extracted and validated against the Zod schemas in CI (CON-007). Examples that fail break the build.
- The JSON Schema snapshots are diffed against this document's field lists by the doc validator during planning, and by CON-007 during implementation.
- Each tool has negative tests for every error code listed in its **Errors** section.
