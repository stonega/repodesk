# Telegram feedback acceptance

Use a dedicated staging bot, authorized test members and a test repository. Live
messages, model spend and GitHub writes need an explicitly scoped operator session;
these steps are not part of automated setup or tests.

1. Send a short private question. Observe the native thinking preview and one final
   answer, without an extra immediate queued message.
2. Ask for a coding change in a configured Reviewed repository and approve the
   proposal. Repeat with a Direct repository. Observe factual preparation, work
   and verification stages by editing the original acknowledgement, with inline
   **Status** and **Cancel** buttons. Tap **Status** on that message; it should report the current task and confirmed
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
    same PR actions. Repeat with a blocker and a `/status` reply; an older Status
    button must return the current PR actions. Use `/cancel` for post-publication
    cancellation and verify its receipt keeps the existing PR links.

Record the deployed image, repository, verification performed and sanitized
task/run references. Do not put credentials, private requests, device codes or raw
provider output in routine logs or checked-in evidence. Local automated coverage
is in `tests/unit/telegram-feedback.test.ts`, the development/system/native-Stop
integration suites and the Codex browser fixture.
