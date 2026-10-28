# Architecture Decision Records

> **Status:** Planned design, baseline of 2026-10-22. Nothing described here is implemented yet.

**Canonical home for:** architectural decisions and their status. The other documents link here instead of restating the rationale.

## Status semantics

| Status | Meaning |
|---|---|
| `Accepted (planning)` | Accepted as a planning constraint. It still needs implementation-time verification where a "Verification" section says so. A compatibility claim marked *Unverified* in the [research log](../research-log.md) is never covered by this status. |
| `Proposed` | A recommendation that needs more evidence or explicit stakeholder acceptance before it becomes binding. |
| `Open` | Unresolved. Work that depends on it is blocked or runs behind an abstraction. |
| `Superseded` | Replaced by a later ADR. The ADR text is kept for history. |
| `Withdrawn` | The question no longer applies because the scope changed. The ADR text is kept for history. |

## Index

ADRs map one-to-one to the 15 decision topics in the planning specification. Use the [template](ADR-template.md) for new ADRs.

| ADR | Topic | Status | Primary requirements |
|---|---|---|---|
| [ADR-0001](ADR-0001.md) | MCP SDK, protocol revision and transport | Accepted (planning). Client interop verified 2026-10-23 (DISC-001). | NFR-001, NFR-010, SR-017 |
| [ADR-0002](ADR-0002.md) | Modular monolith in a pnpm workspace | Accepted (planning) | NFR-007, NFR-009 |
| [ADR-0003](ADR-0003.md) | Zod 4 schemas as the single source of contract truth | Accepted (planning) | FR-011, NFR-002, NFR-013 |
| [ADR-0004](ADR-0004.md) | No server-side LLM in Release 1 | Accepted (planning) | FR-011, NFR-002, SR-006 |
| [ADR-0005](ADR-0005.md) | Independent, plan-hash-bound coverage gate | Accepted (planning) | FR-015, FR-017, FR-018, FR-019 |
| [ADR-0006](ADR-0006.md) | Approval sources, assurance levels, and separate execution authorization | Accepted (planning). AL1 is confirmed hook-automatable. The local AL3 mechanism awaits an organization decision (OQ-13). | FR-021, FR-022, SR-007, SR-008 |
| [ADR-0007](ADR-0007.md) | Asynchronous run model with a detached run supervisor | Accepted (planning) | FR-023 – FR-029 |
| [ADR-0008](ADR-0008.md) | Filesystem artifact store plus SQLite index | Accepted (planning). Driver: `node:sqlite` (DISC-008). | NFR-005, FR-037, SR-019 |
| [ADR-0009](ADR-0009.md) | Platform adapter capability model with injected ports | Accepted (planning) | FR-005, FR-014, FR-030 – FR-034, NFR-007 |
| [ADR-0010](ADR-0010.md) | Flutter host unit/widget tests as the first platform | Accepted (planning) | FR-030 |
| [ADR-0011](ADR-0011.md) | Native runners first; Appium only where it adds value | Accepted (planning) | FR-031 – FR-034 |
| [ADR-0012](ADR-0012.md) | CI provider selection process | **Proposed** (decision in Phase 0) | G-12, FR-042, SR-016 |
| [ADR-0013](ADR-0013.md) | GitHub App / Actions token for checks; token-scoped comments; status fallback | Accepted (planning). GHES 3.21.6 capabilities are documented; instance configuration still needs verifying (OQ-07). | FR-040, FR-041, SR-009 |
| [ADR-0014](ADR-0014.md) | Shell-free, policy-governed execution | Accepted (planning) | SR-001, SR-002, SR-003, SR-004, SR-010 |
| [ADR-0015](ADR-0015.md) | Dependency-boundary enforcement with dependency-cruiser | Accepted (planning) | NFR-007, NFR-009 |
| [ADR-0016](ADR-0016.md) | GitHub Enterprise Server is a first-class host | Accepted | FR-002, FR-004 |
