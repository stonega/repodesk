# Misleading workflow approval feedback — 2026-11-11

## Observed impact and evidence

A Telegram screenshot showed a schedule proposal followed by the generic
"I hit a snag" notice. Read-only inspection of the Seattle VPS found that the
schedule itself was active, with daily recurrence at 08:00 Asia/Taipei and its
next execution at 2026-11-12T00:00:00Z. No duplicate workflow existed.

For workspace `6a084cfc-c08f-4268-a0eb-84a80fe93760`, run
`ae71a6c4-f5a5-490f-a103-c7ab12fd86fd` successfully executed `propose_workflow`.
The proposal was saved at 04:03:08 UTC and the run paused for requester approval.
Approval succeeded at 04:03:28, activating the exact saved version and completing
the run. A separate ingress error delivery was created at 04:03:47 in the original
private Topic. The successful approval confirmation had been sent to Topic 0.

The older ingress handler did not retain a safe diagnostic code for this error.
The evidence cannot establish the exact later command/button or exception.
A repeated approval/rejection of the consumed proposal reproduces the misleading
generic notice, and is consistent with the saved sequence. It does not establish
a model failure, failed schedule activation or missing administrator approval.

## Failure family and correction

Telegram controls previously passed every click to the one-use decision service.
A fresh update for an already consumed approval raised `approval_consumed`, which
had no specific user message. The original run's success remained unchanged.
Private approval confirmations also omitted the source Topic.

The corrected ingress checks current membership and the bound requester before
reporting an existing decision. Repeated and opposite clicks preserve that
decision, create no extra workflow or authorization, and report the saved outcome.
Private confirmations remain in the original private Topic. Expired, denied,
changed and stale proposals have explicit recovery messages. Rejected controls
log `telegram_control_rejected` with an allowlisted code and workspace/run UUIDs;
raw exceptions, callback bodies and private text stay out of logs.

The user also clarified the product flow: show owner profiles on workflow cards
and require no separate administrator approval. Cards/details now reuse saved
Telegram name/username/ID display. Explicit panel saves activate the exact version
in one transaction. Explicit Telegram requests activate immediately and receive a
durable application-owned confirmation without another model call or approval
step. Workflow proposals no longer appear in the panel approval list.

## Verification and release boundary

The deterministic regression goes through the production app/webhook, Executor,
Pi tool registration, PostgreSQL and DeliveryWorker with fake transports. It
covers immediate activation for an ordinary member, interruption/recovery without
replay, a denied historical quote, another actor's denied legacy decision,
duplicate updates,
repeated/opposite clicks, original-Topic delivery and duplicate scheduler ticks.
Additional API/unit and desktop/mobile browser checks cover profile projection,
direct saves, version conflicts, editor recovery and missing profile fields.

VPS inspection made no state changes or manual Telegram/model calls. These
corrections are local until a separately authorized deployment.
