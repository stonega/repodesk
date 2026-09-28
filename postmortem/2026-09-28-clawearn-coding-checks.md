# Clawearn coding tasks stopped at repository checks

Date: 2026-09-28. Scope: local RepoDesk Codex runner, tasks for
[issue #2](https://github.com/stonega/clawearn/issues/2) and
[issue #3](https://github.com/stonega/clawearn/issues/3).

## What happened

Both tasks started real Codex sessions, produced local working-tree changes, and
reached a `task_complete` event. The implementation containers then exited with
code 1. RepoDesk recorded `coding_execution_failed`; neither task reached patch
export or draft PR creation. The isolated work volumes retain the changes until
the runner's retention cleanup.

## Verified causes

- Issue #2 used the configured check command `bun run test`. Its generated
  `package.json` had no `test` script, so Bun exited before running any tests.
  A diagnostic `bun test` run under the runner's bridge network passed 55 tests
  and failed the pre-existing Polymarket assertion described below.
- Issue #3 used `bun run test`. It ran 53 tests: 52 passed and one pre-existing
  Polymarket CLI test failed. The test expects `--amount` in a missing-argument
  error; the CLI emitted `Usage: clawearn polymarket balance check`. Neither
  task changed that test or the corresponding CLI command.

## Recovery

Fix the Polymarket assertion or CLI usage response in Clawearn, and configure a
check command the repository actually supports. A new approved coding task is
needed to rerun the issue-to-PR flow; failed tasks are not published. Retained
work volumes can be inspected before their configured cleanup time.
Protected patch copies of both generated working trees are saved locally as
`backups/clawearn-issue-2-20260928.patch` and
`backups/clawearn-issue-3-20260928.patch` (mode 0600). Both parse with
`git apply --stat`; neither was pushed or published.

These two historical records have the generic `coding_execution_failed` code.
The runner now records a safe failure stage (setup, Codex, repository check, or
empty patch) and retains a started thread ID when a future implementation fails,
without logging prompts, repository output, or credentials.
