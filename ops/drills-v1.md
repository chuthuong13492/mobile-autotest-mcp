# Operations drills v1 (OPS-007)

Each recovery procedure of [operations §4](../docs/operations-and-troubleshooting.md#4-recovery-procedures) was
performed as written, on a fresh data root with the fake runner, on 2026-10-25 (macOS 26.6, Node 24.22.1). The drills
are automated so they stay true: `ops/drills.test.ts` (part of `pnpm test`), and two scenarios of the resilience suite
(`resilience/resilience.test.ts`, OPS-006).

| §4 situation | What was done | Outcome | Automated in |
|---|---|---|---|
| Claude Code session ended mid-run | Closed the server's stdin while a run was executing, then opened a new server | The server exited 0; the supervisor finished; the new server reported `completed` | resilience: client disconnect |
| Server crashed or was killed | `kill -9` of a real stdio server mid-run, then a new server | The run completed; `get_run_status` on the new server reported it; the audit chain verified | resilience: kill -9 of the server |
| Run stuck in `cancel_pending` | A run record in `cancel_pending` | `doctor` lists it with "end them manually if they are the run's" | drills: cancel_pending |
| `E_STORAGE_CORRUPT` (broken index) | Overwrote 8 KiB in the middle of `autotest.db`; ran `doctor`; moved the file (and `-wal`/`-shm`) aside; started again | `doctor` reported the index; after the move it passed; plan snapshots stayed on disk; the workflow ran again from the start | drills: broken index |
| Tampered or mismatched approval file | Edited `maxUses` in an approval file | `run_tests` refused with `E_STORAGE_CORRUPT`; after `autotest revoke` and a new `autotest approve` the run completed | drills: tampered approval |
| Audit chain broken | Edited one audit line | `doctor --audit` exit 1 naming the file and line; the next report carried `audit_chain_broken` | drills: audit chain |
| Policy config invalid | Added an unknown key to `config.yaml` | Tools answered `E_POLICY_UNAVAILABLE`; `doctor` FAIL `config`; restoring the file restored `PASS` | drills: invalid policy |
| Disk usage high | 300 MiB of run data with a 256 MiB cap | `doctor` WARN `disk`; `cleanup --dry-run` listed the run's artifacts; `cleanup` removed exactly them; `doctor` PASS | drills: disk usage |

## Corrections to the document

The drills changed the procedures where the document did not match the product:

- `E_STORAGE_CORRUPT`: there is no `doctor --repair`. Moving the index aside works, but this build does not re-index
  plans, approvals or runs from the files, so contexts, decisions, results and reports are produced again.
- Audit chain broken: new events do not start a new segment; they keep chaining, the verifier keeps reporting the
  first broken line, and reports now carry `audit_chain_broken` (added during this drill).
- Tampered approval: `autotest revoke` failed on the modified record, and the record kept blocking every approval of its
  scope. Revoke now moves it to `quarantine/approvals/` (found and fixed during this drill).
- §5 and §6 rows that described CI commands, `cleanup --devices` and `flutterSdk` were corrected (OPS-004).
