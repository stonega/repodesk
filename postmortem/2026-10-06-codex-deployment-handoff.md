# Verified Codex task failed during a deployment handoff

Date: 2026-10-06. Evidence: operator-authorized read-only production database,
runner state and Docker inspection. Times below are UTC; Taipei is UTC+8.

Task `1d2ad139-14e7-46ca-9f78-07604cc56e5d` completed implementation at 14:31 and
passed replayed verification at 14:39:42. Its second attempt was settled with
`checkPassed: true` and 8,211,552 reported tokens. A later authenticated input
required another intake turn before publication. The verified patch remained
saved in the persistent runner state.

At 14:39:48 the application marked the task `failed` with
`coding_runner_unavailable`. The replacement supervisor was created at
14:39:48.201 and started at 14:39:48.725. The replacement worker started at
14:40:26. The timing points to the old worker querying the unavailable runner
during the release. No PR was recorded.

## Cause

The release script replaced and health-checked the runner before stopping the old
application and worker. Independent task containers survived, but worker queries
and provider requests proxied through the supervisor could lose their connection.
Queued account-auth tasks checked runner auth before reserving an attempt; that
connection error fell through to terminal failure. Completed-checkpoint cleanup
also performed a runner cancellation after settling application state, without a
durable cleanup retry when its acknowledgement was lost.

## Changes

- Deployment keeps the old runner and bot live while running attempts reach a saved
  checkpoint, then stops writers and checks again before changing the supervisor.
  A bounded deployment wait defers the release; it does not cancel the task.
- Pre-cutover deferral restores only writer services that were previously running.
  Existing images, task containers, runner state and database schema remain intact.
- Runner read failures before dispatch retain queued state. Ambiguous start and
  publication requests preserve their recorded identity and remain subject to
  reconciliation rather than automatic replay.
- Verified slot cleanup has a persisted attempt identity and retries idempotently
  across worker restarts. Usage, results and ordered inputs stay settled once.

## Verification

Deterministic deployment tests cover both checkpoint guards, the shutdown race,
deferral without runner replacement, restoration of previously running writers,
first installation and startup failures. Checkpoint-reader tests prove that active
or invalid state cannot authorize replacement and private records are untouched.
Real-PostgreSQL regressions cover lost cleanup acknowledgement, review-state cleanup
after executor restart and pre-dispatch runner outages. The real Docker smoke checks
verified checkpoint identity, usage and subsequent publication after supervisor
restart using fake Codex and GitHub. Production rollout remains a separate action.
