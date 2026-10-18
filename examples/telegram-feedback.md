# Telegram feedback acceptance

## Personality acceptance

The maintained [SOUL.md](../src/agent/SOUL.md) is included in model prompts;
fixed notices use conversational English. Use a dedicated pilot bot for the
following live checks, only after the operator authorizes live messages/model use:

| Situation | Check |
| --- | --- |
| Chinese and English conversation | Replies follow the person's language and sound like a warm colleague. “小伙伴” or “buddy” is optional, not repeated on every reply. |
| Short factual answer | Warmth stays in the answer itself; no obligatory greeting, praise, emoji or closing question. |
| Queued coding request | Acknowledge receipt and say it is queued; do not claim investigation or implementation has started. |
| Repair or failure | State the actual problem and next step calmly. Never celebrate failure or promise an unconfirmed repair/retry. |
| Approval or formal report | Preserve the exact approval facts or requested output format, using restrained wording. |
| Desktop and mobile | Check the complete progress, waiting, failure and final messages in native Telegram. Buttons, source links and Stop retain their existing behavior. |

Local coverage is in `tests/unit/soul.test.ts` and the feedback/integration suites.
The Node runtime contract verifies the bundled Markdown loads. These checks do
not establish live model tone or native Telegram visual acceptance.

## Progress and recovery acceptance

Use a dedicated staging bot, authorized test members and a test repository. Live
messages, model spend and GitHub writes need an explicitly scoped operator session;
these steps are not part of automated setup or tests.

1. Send a short private question. Observe the native thinking preview and one final
   answer, without an extra immediate queued message.
2. Ask for a coding change in a connected repository. Observe factual preparation, work
   and verification stages by editing the original acknowledgement, with inline
   **Status** and **Cancel** buttons. Tap **Status** on the latest task message; it should report the current task and confirmed
   links, clear the native spinner and remain usable after ten minutes. Also test
   `/status` in the same Topic or by replying to a task message.
3. Supply a change that needs a consequential product choice. Answer the question
   by Reply to its current question. Confirm that the same task continues. Also
   answer without Reply in its Topic: Pi should resolve the pending question and
   explicitly relay the original answer to the same task.
4. Exercise a slow phase and a failing repository check in the test fixture.
   Observe at most one natural delayed edit per confirmed active phase, and a repair
   edit only after repair starts. Repeated check/repair cycles must not add messages.
   Questions and final results should be separate replies; the progress message
   should close with the current waiting/finished state and remove active controls.
   Delete the progress message and confirm that the next update creates only one
   replacement and later stages edit it. A successful task returns one confirmed PR.
5. Tap **Cancel** during work. Observe “Stopping…” followed by confirmed termination.
   Repeat for queued, waiting and sign-in-paused tasks. During publication, inspect
   the recorded outcome; a write already in flight may require reconciliation.
   Repeated taps must not duplicate cancellation; a status reply after stopping
   should omit Cancel. Explicit `/cancel` remains available.
6. Create two tasks in one Topic and send `/cancel`. Choose one. Verify that only
   that task stops and the command was not appended as a requirement. A different
   user or a stale/wrong-topic selection must not control it. Test a copied button
   from another chat, Topic, workspace or bot; it must not control the task.
7. Restart the worker during a retained task, then request status and continue the
   same PR. Check that recorded notices and writes were not replayed.
8. Inspect a denied permission, runner outage and model failure. Each eligible
   requester should get a readable next step. Inspect the panel separately for
   a Telegram delivery failure; an unknown original send must not automatically
   retry. An uncertain edit can safely retry the same known message.
   Configure a nonexistent base branch for the test repository and start a coding
   request. Its failure and `/status` reply should name the repository and missing
   branch, explain that Codex did not start, and point to Plugins → Codex →
   Repositories before a new request. Confirm the same saved details on desktop
   and mobile in the panel. Restore the intended branch; the failed task must not
   restart automatically. No raw Git output or token should appear in the reply.
   An assistant request requiring more than eight authorized reads should finish
   while model turns and budget remain. Confirm that revocation or cancellation
   still stops subsequent reads and model-turn exhaustion reports its own cause.

9. After a task publishes its PR, send “Can you review it?”, “Explain what
   changed”, and an unrelated question in the same Topic, including a Reply to its
   old result. Each should reach Pi without automatically resuming Codex. A review
   must stay read-only and disclose missing diff/source evidence when unavailable.
   Then request a concrete code change to that PR: Pi should resolve and continue
   the same task with the original instruction. A new feature request should get
   its own task. Repeat with two tasks in one Topic; ordinary conversation should
   not open a Codex-task selection. Test private and explicitly addressed group
   conversations; plain unrelated group traffic should remain uncollected.
10. Once a PR is confirmed, check the progress message and result on Telegram
    desktop and mobile. **Review** and **Merge** should replace Status/Cancel:
    Review opens that PR's changed files; Merge opens that PR's GitHub page, where
    merge permissions and confirmation still apply. Continue the task until it
    asks a necessary question: the question and progress edit must retain the
   same PR actions. Repeat with a blocker and a `/status` reply. Use `/cancel` for post-publication
    cancellation and verify its receipt keeps the existing PR links.
11. Before publication, generate two distinct Codex progress notes. After each
    confirmed delivery, only the latest task message should show **Status/Cancel**;
    older message text and other URL links stay intact. Editing the original
    progress acknowledgement must not restore its controls. Repeat with two tasks
    in one Topic; each task keeps its own latest controls. Inspect desktop/mobile.
    In deterministic delivery fixtures, reject or delay the next send: the existing
    controls must remain. Restart during keyboard cleanup and replay the job: only
    the known old keyboard changes, without another message. A stale callback is
    denied even if Telegram could not remove its keyboard. A terminal update may
    leave no Status/Cancel buttons; PR Review/Merge links remain usable.

Record the deployed image, repository, verification performed and sanitized
task/run references. Do not put credentials, private requests, device codes or raw
provider output in routine logs or checked-in evidence. Local automated coverage
is in `tests/unit/telegram-feedback.test.ts`, the development/system/native-Stop
integration suites and the Codex browser fixture.
