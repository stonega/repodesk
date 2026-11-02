# Assistant repository analysis stopped by the total execution deadline

Date: 2026-11-02. Status: diagnosed in production; correction implemented locally.

## Incident and evidence

An ordinary assistant request began at 07:50:11 UTC and finished at 07:55:17 UTC
with `failed (run_timeout)`. The worker recorded `run_started` at 07:50:15 and
`run_failed` with the fixed `run_timeout` diagnostic at 07:55:17. The affected
workspace is `3b2dfe82-61c6-444e-8058-7a179f2bf27a`, run
`29fe01ae-dbb9-4df2-8a3c-321bbeeeafb9`, thread
`a8e7a7ac-c29a-4b15-8925-1a9f18602161`.

Seven source/discovery tool calls completed without recorded tool errors. Six
model attempts settled; the final model attempt was aborted and its usage remains
unknown. No final answer or Codex task was created. The separate failure notice
was confirmed sent. No private request text, credentials or raw provider errors
are included in this report.

## Cause

The ordinary executor imposed a 300-second deadline across analysis, model calls,
tool calls and checkpoints. Productive repository analysis reached that deadline
before a final response or development-task handoff. The scheduling missed-run
grace is unrelated. These records establish the interruption mechanism; they do
not isolate upstream latency from application/storage overhead.

Removing only the executor timer would leave a second finite deadline: pg-boss
held each run job active throughout execution, with expiry tied to the configured
deadline. Its worker API requires a finite active-job expiry.

## Correction and regression coverage

Ordinary assistant execution now has no total deadline. The environment variable
is retired and ignored, including preexisting values. Queue jobs only dispatch
durable runs, acknowledging each wakeup before execution; they no longer remain
active for the assistant's lifetime. The worker retains three execution slots,
one-second authorization/cancellation checks, renewable conversation leases and
shutdown draining. The durable outbox recovers acknowledged wakeups after a crash.
Unknown provider attempts and incomplete tool checkpoints still prevent blind
replay. Historical failures are not restarted.

Deterministic PostgreSQL regressions exercise the production dispatch/Executor
composition with simulated elapsed analysis beyond the old limit, duplicate
wakeups, a live lease, a crash between acknowledgement and claim, expired leases
with unknown usage, bounded concurrency, cancellation, permission revocation and
shutdown. Deployment and live Telegram acceptance remain separate checks.

## Local validation

Biome, strict TypeScript, build and 1,352 deterministic tests across 144 files
passed against disposable PostgreSQL, including all seven new run-worker cases.
The Node runtime and exact Docker image passed the 16-case plugin startup contract
with zero external startup calls. Compose configuration and image migrations
passed. The image served HTTP 200 for health, readiness and admin, recorded a
worker heartbeat, and stopped app/worker cleanly with heartbeat cleanup. The
legacy environment value `RUN_TIMEOUT_SECONDS=300` was present during the image
smoke checks and did not prevent startup. No production deployment was performed.
