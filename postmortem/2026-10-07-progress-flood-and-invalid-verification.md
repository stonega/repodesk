# Repeated Telegram progress and an invalid frozen verification plan

Date: 2026-10-07. Status: **diagnosed on the VPS; progress correction implemented
locally; live task recovery and Telegram acceptance pending**.

## Impact and evidence

The search/filter task in `stonega/repodesk`, reference
`3a9b89e3-a48e-4754-ab11-0efd0daf26eb`, repeatedly sent check, repair and delayed
repair notices with Status/Cancel buttons. The screenshot shows these cycles from
13:34 to 13:53 Taipei time. A read-only inspection at approximately 13:56 found the
task still working, rather than terminally failed. By approximately 14:00 the
runner had reserved 21 repairs for the same work attempt.

The task's private saved check diagnostics end with:

```text
cp: missing destination file operand after '/task/home/.cache/repodesk-browser-libs/usr./not'
```

Inspection was scoped to this task's state, attempt metadata and saved verification
output. No credentials, private conversation bodies or provider transcripts are
included here.

## Causes

Two independent problems reinforced each other:

1. Each confirmed progress transition queued a new `sendMessage`; a two-minute
   delay also queued a new message. Deduplication prevented replaying an individual
   event, but a genuine repeated check/repair cycle still created more messages.
2. The initial verification result contained two frozen commands: dependency
   installation and an environment preparation command exactly 2,000 characters
   long. The latter ended in `cp /task/home/.cache/repodesk-browser-libs/usr./not`
   with no destination. Neither command contained RepoDesk's check, typecheck,
   test or build invocation. The recorded failure is environment preparation,
   before application verification. The generated plan was incomplete at the
   schema's per-command limit; there is no evidence that application code sliced
   a longer valid command. The supervisor freezes the first plan so model repairs
   cannot weaken verification, and consequently replayed the same invalid command.

Changing repository code cannot supply the missing argument in that frozen string.
The removed execution quotas did not cause the malformed plan; adding retry quotas
would not repair it.

## Local correction

Routine task acknowledgements and progress now share one Telegram message. Each
update remains a separate durable intent, but targets that message through
`editMessageText`. Questions, actionable blockers, requested receipts/status and
outcomes remain new replies. Waiting/finished messages close the progress card.
Legacy confirmed progress can be reused after an update; old messages are not
bulk-deleted.

Edits retain actor, workspace, task, chat, Topic and bot checks, serialize against
other edits, respect rate limits and suppress stale pending stages. Unknown edits
retry the known message; unknown original sends require reconciliation. A confirmed
missing/uneditable message rejection permits one replacement. Already-applied
edits count as successful delivery.

Verification output guidance now explicitly states the 2,000-character bound,
requires complete commands and recommends a checked-in script for longer logic.
Codex is told to execute the exact returned plan, account for phase-local `/tmp`,
and report an irreparable frozen-plan/environment blocker through `needs_input`
instead of repeatedly declaring completion. The original verification gate and
execution policy remain intact. This guidance cannot retroactively rewrite the
live attempt's frozen plan and does not prove a future model will always comply.

## Recovery and remaining verification

Biome, strict TypeScript and Bun build passed. All **538 deterministic tests**
passed against disposable PostgreSQL, including repeated repair edits, necessary
question delivery, concurrency, scope revocation, uncertain sends/edits and recovery.

The local correction is not deployed. The existing live attempt still needs
operator-authorized recovery preserving its checkout/checkpoint and requirements,
then a fresh complete verification plan. Do not mark the task verified, publish
its patch or silently weaken the frozen checks to escape the loop. A clean new
attempt should use a short invocation of a repository script that includes all
required checks. Live Telegram acceptance follows the
[feedback example](../examples/telegram-feedback.md).
