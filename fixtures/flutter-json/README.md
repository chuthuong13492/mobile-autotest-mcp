# Flutter JSON-reporter corpus (DISC-006)

These are captured outputs of `flutter test --no-pub --file-reporter json:<file>`. The scenarios are pass, fail, error, skip, load_error, timeout, plain_name and interrupted (SIGTERM).

- **Source project:** the scratch app in `spikes/disc-006/scratch_app`.
- **Flutter versions:** 3.38.4, 3.38.10, 3.41.9 and 3.47.1.
- **Captured:** 2026-10-23.
- **Scrubbing:** absolute paths are replaced with `<APP>` and `<HOME>`.

Each version folder has a `summary.json` with these fields:

- exit code
- protocol version
- `done.success`
- per-test results
- whether each flag is present in `--help`

Findings are in [RL-034](../../docs/research-log.md#rl-034--flutter-json-reporter-corpus-across-versions). FL-004 parser tests consume these files.
