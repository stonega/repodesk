# Reasoning request cancelled at the worker deadline

Run `adad9ac6-a578-4fde-8694-4d848d355f97` started on 2026-09-20 at
08:53:02.255 UTC and failed at 08:54:32.289 UTC, matching the hardcoded
90-second execution deadline. The persisted user-cancellation flag was false.
The provider attempt ended with `stopReason: aborted` and no confirmed usage;
its estimated USD 0.3903252 reservation remains unknown. No tool result or
completed assistant answer was checkpointed.

The executor combined its deadline, policy guard and shutdown signals, then
classified any abort as `cancelled`. This obscured the operational timeout.
Rebuilding the unchanged executor could not correct either the limit or label.
The earlier `provider_failed` run remains a separate failure of unknown cause.

The fix makes the deadline configurable through `RUN_TIMEOUT_SECONDS`, with a
five-minute default and a 30-minute maximum. Queue expiry allows a further
60 seconds for finalization, and migration updates existing queue defaults.
Timeouts now report `failed (run_timeout)`. Shutdown and policy aborts preserve
their cause; explicit cancellation remains cancelled. The existing renewable
conversation lease, budget checks and unknown-attempt no-replay rule remain.

Regression coverage uses controlled abort signals and an isolated PostgreSQL
database to check first-abort precedence, user cancellation, shutdown, safe log
codes, budget reservations, terminal-run deduplication, pre-dispatch timeouts and
queue expiration. No live paid request is needed for these checks. A longer
deadline does not establish why the upstream request was slow or guarantee that
future requests complete. Historical reservations require provider billing evidence.
