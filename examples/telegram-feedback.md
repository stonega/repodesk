# Telegram feedback acceptance

Use a dedicated staging bot, authorized test members and a test repository. Live
messages, model spend and GitHub writes need an explicitly scoped operator session;
these steps are not part of automated setup or tests.

1. Send a short private question. Observe the native thinking preview and one final
   answer, without an extra immediate queued message.
2. Ask for a coding change in a configured Reviewed repository and approve the
   proposal. Repeat with a Direct repository. Observe factual preparation, work
   and verification stages. Send `/status` in the same Topic or reply to a task
   message; the reply should use readable language and show confirmed links.
3. Supply a change that needs a consequential product choice. Answer the question
   in its Topic or by Reply. Confirm that the same task continues.
4. Exercise a slow phase and a failing repository check in the test fixture.
   Observe at most one delayed notice per confirmed active phase and a repair
   notice only after repair starts. A successful task returns one confirmed PR.
5. Send `/cancel` during work. Observe “Stopping…” followed by confirmed termination.
   Repeat for queued, waiting and sign-in-paused tasks. During publication, inspect
   the recorded outcome; a write already in flight may require reconciliation.
6. Create two tasks in one Topic and send `/cancel`. Choose one. Verify that only
   that task stops and the command was not appended as a requirement. A different
   user or a stale/wrong-topic selection must not control it.
7. Restart the worker during a retained task, then request status and continue the
   same PR. Check that recorded notices and writes were not replayed.
8. Inspect a denied permission, runner outage and model failure. Each eligible
   requester should get a readable next step. Inspect the panel separately for
   a Telegram delivery failure; an unknown send must not automatically retry.

Record the deployed image, repository, verification performed and sanitized
task/run references. Do not put credentials, private requests, device codes or raw
provider output in routine logs or checked-in evidence. Local automated coverage
is in `tests/unit/telegram-feedback.test.ts`, the development/system/native-Stop
integration suites and the Codex browser fixture.
