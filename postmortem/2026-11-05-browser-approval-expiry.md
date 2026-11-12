# Private Browser approval expired without terminal feedback

Date: 2026-11-05. Status: verified correction awaiting VPS rollout.

The reported private Topic contains run `f9d34008-8b08-4b76-a4e4-004617018c89`
and follow-up `42f6a487-189c-4fd7-8e8c-2cdf57fb7afb`, in workspace
`3b2dfe82-61c6-444e-8058-7a179f2bf27a`, thread
`6ea018e0-dcb1-4cfe-b1f1-97198fc8c580`. Read-only, scoped inspection through
the existing VPS runner confirmed production release `1793614570991-61029298`.
Only metadata, content lengths, tool names and fixed diagnostic codes were emitted;
private messages and credentials were not printed.

The original request made six settled model attempts and six Browser calls.
It waited for an approval, then ended `partial (browser_request_expired)` at
02:13:57 UTC. Its approval notice was sent, but no terminal expiry notice or final
answer was recorded. The follow-up arrived five seconds before that transition
and created a separate run. Its sole model attempt was aborted with unknown usage;
the run ended `cancelled`, and its failure notice was confirmed sent. It performed
no Browser actions. These records do not establish the upstream abort's cause.

The deployed service was healthy. The newer correction in
`445ec494ae16b9da5591bea83ebfa97c35b292e0` had passed
[CI verification](https://github.com/stonega/repodesk/actions/runs/41819505686)
but was not deployed. That correction adds durable, idempotent expiry feedback,
routes recognized status/continuation input to the existing Browser task and
preserves the authenticated goal when explicitly retrying expired work. Fresh
approval remains necessary; cancellation, uncertain effects and revoked access
are not automatically replayed. Its production-composition regressions cover
expiry, retry, duplicate notices, task contention and current authorization.
See the [failure-family analysis](2026-11-04-browser-task-contention.md).

The authorized rollout uses the verified Browser correction in an isolated
checkout based on production commit `c0ef7f8e6eef34675b0c234f2dfeb4f45b5eb4d6`,
preserving its deadline removal, transcription behavior and unrelated local changes.
The first candidate's image build was stopped before any cutover or writer
shutdown because its branch omitted production-only fixes. Production remained
on its original healthy services. Release packaging now requires the deployed
source commit to be an ancestor of the candidate; a real temporary-Git regression
rejects the stale branch and accepts source retaining that commit.
The exact application image,
native Browser package, startup contract, disposable Compose state and
backup/restore must pass before guarded production cutover. Historical terminal
runs and existing website decisions are preserved; no manual Telegram message,
model call or task approval is a deployment probe.

## Readiness instability found during verification

The Browser correction cut over as release `41958024518-1`, source
`52ea869cd0927bfee7a15cf0df30cdff863ac0ae`. Native private downloads and
approval enforcement pass. The release's final HTTP check exposed intermittent
`worker_unavailable` responses despite a healthy running worker. Read-only
metadata showed a heartbeat age near the 30-second readiness threshold and no
worker maintenance errors. Heartbeats were written only after a complete
maintenance pass; slow delivery or ordinary maintenance could outlast that limit.

A production-composition regression blocks maintenance, ages the recorded
heartbeat and exercises the real worker timers and `/readyz` route. It fails
before the correction and passes with a separate, serialized heartbeat timer.
Shutdown clears the timer, drains its pending write and deletes the heartbeat;
the regression also requires readiness to fail after shutdown. Database heartbeat
failures retain a fixed `worker_heartbeat_failed` diagnostic.

Pre-cutover verification also caught a synthetic download probe missing its
interaction grant and a receipt parser mixing diagnostics with JSON. The first
recovery helper expected container names while Compose supplied service names.
Those failures briefly interrupted app/worker availability. The unchanged writers
were restored without a database restore. Regressions now cover service-name
recovery, retained original host backups, receipt stream separation and production
source ancestry. The corrected native probe passes, and later verification is
read-only. Original run outcomes and unknown provider usage remain preserved.
