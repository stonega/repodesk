# Assistant repository analysis stopped by the total execution deadline

Date: 2026-11-02. Status: corrected and deployed to the VPS.

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
smoke checks and did not prevent startup. Those smoke checks used disposable
state; the authorized production rollout followed separately.

## Production rollout

The operator-authorized release `1793607782072-26985359` deployed isolated source
`14d28d05e60b91a646f061c0062803466791fae3` on the existing production source
`895d0e6925be87d49e300815783bcfdefb1c516b`. The snapshot retains the deployed
Browser fixes and changes only ordinary assistant deadline handling. Its 1,354
tests across 147 files passed. Exact-image startup, CPU speech, offline Code
Truth, Compose readiness, migration rerun and disposable backup/restore passed.

Coding and Browser checkpoints passed before the guarded cutover. The protected
2,500,838-byte backup passed archive verification; all 51 deployed artifacts and
public/loopback HTML/assets match the tested images. App, worker, runner, Code
Truth, PostgreSQL and the unchanged native Browser service are healthy. Secrets,
persistent mounts, PostgreSQL and CI runner identities are preserved. The worker
ignores the retired deadline variable retained in legacy environment entries. The incident run
remains failed with its original seven attempts; it was not automatically retried.

The first packaging preflight caught a missing Codex Compose overlay before
writers stopped. The corrected bundle reused the verified images; the retained
initial failure log and final `deployment-receipt.json` distinguish those outcomes.
Live execution beyond five minutes remains a user acceptance check; deployment
did not send a Telegram test request or call a live model.
