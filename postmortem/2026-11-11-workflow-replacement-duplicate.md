# Schedule replacement left the old workflow active — 2026-11-11

## Observed impact

A Telegram screenshot showed the assistant offering to create a Widget version
of an existing daily weather report and asking the requester to stop the old
text version manually. The requester accepted; only a new activation was confirmed.

Scoped read-only production inspection confirmed two active workflows in the
same private Topic, both daily at 08:00 Asia/Taipei. This established a duplicate
schedule, without evidence that either had already sent a duplicate report.

## Cause and correction

`propose_workflow` could create a schedule but could not address an existing
workflow. Context provided existing specs and IDs without owner/version metadata.
The model treated a format change as another creation and delegated cleanup to
the requester. Activation ends the model turn, so a later cleanup tool call would
not make creation and replacement atomic.

The tool now accepts `workflowId` and `expectedVersion` for an in-place update.
It checks current-request evidence, current ownership, chat/Topic, version and
permissions before committing. The existing service replaces the spec, records
its version and cancels queued old runs and output in the same transaction.
Paused schedules remain paused. Prompt and tool guidance use this path for an
explicit revision, and the durable confirmation identifies the replacement.

## Production repair and release boundary

The reported workspace was `6a084cfc-c08f-4268-a0eb-84a80fe93760`.
After checking exact workflow IDs, owner, destination, version, names and
recurrence, a scoped maintenance invocation of `workflowAction` soft-deleted old
workflow `c87a93d2-ad4b-4612-af11-41323e02fcfd` in a locked Store transaction.
The action followed the requester’s report that the old workflow had not been
removed and preserved its audit history. Subsequent independent SQL inspection
confirmed the old workflow is `deleted` and Widget workflow
`8bbcec90-5047-4666-bd60-58c3dbf9c706` is `active`, next due
2026-11-12T00:00:00Z (08:00 Asia/Taipei).

No Telegram message, live model call or deployment was performed. The production
data repair is complete; the general code correction remains local pending rollout.

## Regression coverage

The production Executor/Pi/Store/DeliveryWorker regression changes a text report
to a Widget format, retains one identity and its history, cancels queued old
work/output, confirms in the original Topic, survives repeated execution and
produces one revised occurrence after duplicate scheduler ticks. Tool regressions
cover paused updates, call replay/conflict and rejected stale, deleted,
other-workspace, other-owner, other-chat/Topic, unverified-request and denied-source
updates without partial mutations. All model and Telegram transports are fake.

Validation passes all 1,443 deterministic tests across 152 files, Biome, strict
TypeScript, build and the Node runtime contract (16 startup cases, zero external
startup calls). An initial broad run failed the separate plain-Stop control test;
its isolated suite and the complete rerun passed. No dependency or migration was
added.
