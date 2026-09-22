# Telegram response and draft delays

Status: investigated 2026-09-21; live client rendering remains unverified.

The user reported no response after the native-streaming deployment. For the
reported greeting, the worker accepted ingress at 07:04:55 UTC, started execution
at 07:04:59, completed at 07:05:15, and recorded Telegram's successful final send
at 07:05:20 (remote message 92). These records establish server-side acceptance,
not what the Telegram client displayed.

Subsequent worker logs showed repeated `telegram_outcome_unknown` polling failures
around 07:12–07:13 UTC. Polling reconnected at 07:13:50, and two newer requests
completed with successful final sends at 07:14:09 and 07:14:44. The underlying
network failure was not identified; no credential or webhook change was made.

Draft failures were previously swallowed without diagnostics. A single unknown
outcome, including the two-second request timeout, disabled all remaining previews
for that execution. This is a confirmed recovery flaw, but the original greeting's
draft outcome cannot be reconstructed from existing logs.

The correction retries the latest ephemeral text after one second with the same
draft ID, with a cap of three consecutive transient failures. Each retry still
checks cancellation, access and execution fencing. Rate-limit delays remain
authoritative, permanent rejections stop previews, and final sends with unknown
outcomes are never retried automatically. Fixed runtime events record first draft
acceptance and preview failure codes without text, tokens or raw Telegram responses.

Regression tests cover recovery after a thinking-draft timeout, bounded retries,
revocation between attempts and sanitized logging. No additional test messages
were sent to the user's Telegram chat during investigation.

Deployed the correction as `localhost/deepx-agent:draft-recovery-20260921`
(`fa16a2fbfab5`) to the existing Podman app and worker after active work drained.
All 217 tests, lint, typecheck, build, isolated Node runtime and HTTP/UI image
checks passed. Both containers are healthy; readiness passed and polling
reconnected at 07:18:12 UTC. The earlier `native-stream-20260921` image and database
backup remain available. No schema change was needed. A subsequent user request
is needed to verify draft behavior in the actual Telegram client.
