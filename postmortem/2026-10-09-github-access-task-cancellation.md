# GitHub access checks cancelled coding work and replaced completed status

Inspected through read-only VPS/database/runner access on 2026-10-10.
No deployment, task replay, Telegram send or GitHub mutation was performed.

## Evidence

- RepoDesk task `71e01493-3c5f-4900-9531-cef171ca6919` was cancelled during
  implementation at 2026-10-09 14:57:49 UTC (22:57:49 Taipei), with
  `github_user_access_denied`. A GitHub permission-sync audit entry preceded it by
  about two seconds. Its retained checkout contained unverified implementation
  changes; an earlier local quality run had 660 passes and one failing
  host-daemon heartbeat test. The runner had no completed work result or PR.
- Docket task `0ab62645-fd5f-419d-9bdf-856b24beaee7` passed runner checks and
  published [PR #233](https://github.com/stonega/docket/pull/233) at
  2026-10-09 03:15:28 UTC (11:15:28 Taipei). At 11:04:55 UTC (19:04:55 Taipei),
  its completed task was changed to cancelled with the same access error.
- At inspection, the linked member had fresh read/write/admin snapshots for both
  repositories. The underlying error at the cancellation times was not retained.
  Timeout, rate limiting and an actual temporary access change cannot be
  distinguished conclusively from the historical records.

## Failure mechanism

GitHub account sync caught all errors, marked access unavailable and discarded
the repository list. Authorization collapsed unavailability, snapshot expiry and
confirmed permission denial into `github_user_access_denied`. The continuous task
executor converted every authorization failure into permanent cancellation and
continued checking already completed review-state tasks. The shared failure-message
catalog lacked the access-denied code, leaving the panel with a generic message.

Temporary permission verification is therefore a plausible initiating cause,
and the destructive handling of unavailable checks is reproducible independently
of the incident's missing upstream diagnostic. Earlier intake results mentioned
sandbox startup failures, but both tasks subsequently executed repository commands;
those reports do not establish the terminal cancellation cause.

## Correction and recovery boundaries

Separate unavailable verification from confirmed denial. Block new execution,
auth resume and publication while unavailable, retaining the original attempt;
already-running local work may finish under its original grant. Successful sync
resumes progression. Rate limits respect server cooldowns and increasing backoff.
Keep last confirmed permission data only for comparison and retain its original
timestamp; it must not authorize actions while unavailable.

Confirmed loss fences pending durable coding tasks in the same tenant transaction,
including tasks containing inputs from the affected actor. Stop, configuration and
membership checks remain effective. Completed review-state artifacts retain their
history, while new follow-ups reauthorize access. Record only safe sync-failure
codes and provide specific recovery messages.

The old cancelled records are not automatically revived. Inspect existing PRs and
retained checkpoints before separately authorized recovery; never replay an
uncertain publication. The fix requires an authorized app/worker rollout.
