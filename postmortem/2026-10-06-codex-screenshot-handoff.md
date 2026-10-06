# Telegram screenshots did not reach the Codex task

Date: 2026-10-06. Production version: 0.1.21. Investigation was read-only.

## Impact and evidence

Task `ef9163a2-018b-45e8-ad69-b101f04ff834` in `stonega/repodesk` asked for
dropdown styling based on a screenshot. Telegram ingress retained the image, and
Pi received image content, but Codex received only text. Codex asked for the
screenshot twice. Sending it again through the bot could not satisfy the task.

All times below are UTC on 2026-10-06; add eight hours for Asia/Taipei.

| Time | Confirmed event |
| --- | --- |
| 13:41:52 | Initial captioned screenshot retained as a 9,141-byte JPEG photo; the successful Pi run had one user image block and called `start_development_task`. |
| 13:42:03 | Codex intake attempt reserved revision 1 with text, actor, source ID and input kind; its context had no references or decisions. |
| 13:42:52 | Codex asked, “Can you attach the screenshot you want all dropdown inputs to match?” Delivery was confirmed. |
| 13:49:43 | A photo without a caption started a separate Pi run. It succeeded with two user image blocks from conversation context and made no task-input tool call. |
| 13:50:39 | A text clarification became task input revision 2, recorded as an answer. |
| 13:51:22 | The second Codex intake attempt asked the same screenshot question; delivery was confirmed. |
| 13:52:30 | Another photo without a caption started a separate Pi run, with three user image blocks in its checkpoint. That run failed with `provider_failed`. |
| 13:56:52 | The task entered `cancelled`, still at input revision 2 and intake phase. |

The task's two persisted attempt envelopes contain only text input fields. Neither
contains attachment metadata or image content. Three photo uploads are retained
in the bound Topic, but neither photo-only resend became a task input. The last
Pi provider failure is separate from the already-established Codex handoff gap.

## Cause

[Task creation](../src/coding/tasks.ts) copies the source's text into
`DevelopmentInput` and copies only text fields into reference context. The
[input schema](../src/coding/development.ts) has no attachment field. The
[conversation adapter](../src/coding/local/conversation.ts) sends `turn/start`
with a single text input block. Pi's downloaded image content never reaches the
Codex runner.

[Task message routing](../src/coding/telegram.ts) also requires `msg.text`.
Telegram photos use `caption`, or have no text at all, so photos bypass the task
route and enter ordinary Pi handling. Adding a caption alone cannot repair this
path. The task route builds sources without attachments as well.

At the time of the incident, the attachment documentation explicitly limited media
delivery to Pi and described the Codex runner as accepting text requirements.

## Correction

The 0.1.22 correction resolves original retained attachments for initial task intake
and task follow-ups under current tenant, actor, bot, credential and retention
checks. It uses the existing bounded download/decoder and passes validated image
data URLs through the pinned app-server protocol. Captioned and photo-only messages
now use the same confirmed task bindings as text answers.

Media persists in private runner state for repair, authentication pauses and
restart recovery. New attempts reload original retained sources; erasure and
expiry scrub media, and expired tombstones no longer fail live-run parsing on
supervisor restart. A captionless answer keeps its original empty caption while
intake pins evidence to the preceding authenticated text. A standalone image
follow-up cannot use that answer exception to inherit implementation authority.

Regression coverage verifies initial image delivery, captionless answers, image
documents, edits, duplicate updates, task selection, revocation/cancellation/source
expiry/bot credential changes during downloads, readable download failures, runner
restart/erasure/expiry and payloads exceeding the old JSONL limit. The pinned real
Codex 0.155.1 protocol proof confirms an image input at a local fake Responses
endpoint. Docker container smoke verifies media during continuation and repair.

The 0.1.22 rollout succeeded with a protected database backup and healthy services,
despite an SSH disconnect during supervisor startup. Another task completed work
while the supervisor was restarting and returned to intake for its pending input.
Its account-status GET then failed with `coding_runner_unavailable`. The old
executor treated that read failure as permanent when no attempt was reserved.

The 0.1.23 correction leaves undispatched queued tasks queued on transient runner
read failures, preserving the existing no-replay handling for uncertain POSTs.
The regression checks that recovery starts exactly one attempt. All 436 tests,
lint, typecheck and build pass. The affected task has no current attempt and no
cancellation request; recovery and the final production check are pending. The
original screenshot task remains cancelled.
