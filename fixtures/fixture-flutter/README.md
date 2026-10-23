# fixture-flutter (E2E-001)

A synthetic Flutter app used by AutoTest's end-to-end and adapter tests. Every test has a fixed, known outcome.

| File | Level | Outcome |
|---|---|---|
| `test/calculator_test.dart` | unit | passes (3 tests) |
| `test/counter_widget_test.dart` | widget | passes |
| `test_scenarios/fail_test.dart` | unit | fails (assertion) |
| `test_scenarios/error_test.dart` | unit | fails (uncaught exception) |
| `test_scenarios/skip_test.dart` | unit | skipped |
| `test_scenarios/flaky_test.dart` | unit | fails on the first attempt of a run, passes on the next (counter file in the run's `TMPDIR`) |
| `test_scenarios/slow_test.dart` | unit | runs for 60 s (cancellation and timeout tests) |
| `test_scenarios/sigterm_ignoring_test.dart` | unit | ignores SIGTERM and runs for 60 s (escalation to SIGKILL) |
| `test_scenarios/load_error_test.dart.txt` | — | copy to `test/load_error_test.dart` to produce a load error |

`test/` holds the tests a healthy plan selects; `test_scenarios/` holds the failure scenarios. Tests copy this
directory to a temporary location, move the scenario files they need into `test/`, and run
`flutter pub get --offline` there; the fixture itself is never modified.
