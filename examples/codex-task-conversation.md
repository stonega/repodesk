# Talk with a Codex task

Implemented locally, 2026-10-17. Deploy matching app/worker and supervisor builds
before using the new tools. Both Docker and OpenSandbox share this channel;
OpenSandbox still needs its prepared server, image, storage and proxy profile.

With the bot's [Main Mini App configured](../docs/implementation/telegram-mini-app.md),
select **View conversation** on a task message to read original inputs, actual
completed Codex messages, factual exchanges and expandable tool activity. The page
follows Telegram's theme and preserves reading position as new messages arrive.
Reply through Telegram; closing the read-only viewer leaves the task running.
Old tasks show only retained messages that were actually recorded.

1. Ask the bot to implement an authorized change, such as “Improve the landing
   page's mobile layout.” All Codex tasks use the continuous workflow; no mode
   selection, task approval or prerequisite Issue is needed.
2. While Codex works, ask “Why did you change the navigation?” Chat Agent resolves
   the task, reads `development_task_conversation` and, if needed, sends a factual
   question with `ask_development_task`. It may formulate technical follow-ups
   within your request. A queued/received receipt does not mean Codex has answered.
3. Codex acknowledges reading and answers through the current turn. The answer is
   delivered asynchronously in the original chat/topic. Meaningful Codex progress
   updates can also arrive while implementation continues. Saved dialogue remains
   available on later bot turns and after supervisor/worker restarts.
4. Say “Also make the mobile button larger.” This is a requirement change, so the
   bot sends the original message with `send_development_input`. It advances the
   requirement revision. The tool/history distinguishes received, dispatched, read
   and verified revisions. New requirements reach a completed-turn boundary;
   pending revisions still block publishing an older patch.
5. If Codex asks a consequential product question, reply to that confirmed notice.
   Chat Agent cannot choose the answer on your behalf. A factual side question
   does not consume or replace this pending product question.
6. After a verified result/PR is ready, ask “Which checks did you run, and why?”
   Saved evidence can answer directly. A fresh Codex answer uses a separate
   read-only execution, preserving the result, product question and PR. New
   implementation waits for that execution to finish and clean up.

Use `development_task_conversation` with `taskId` and optional `offset`/`limit`
(up to 20) to read saved questions, receipts, answers and requirement revisions.
Use the existing Stop controls to cancel the task, including any read-only
conversation execution. Unknown native delivery is visible and is never blindly
sent a second time; explicitly ask again only if a fresh question is intended.
An unclaimed question can continue at the next safe boundary.

The channel has no GitHub publication or general host-management permission.
Messages and answers follow task audience, membership, repository and source
retention checks. Expiry/deletion scrubs dialogue and retries owned-runner cleanup.
Compatible surviving sessions may resume; otherwise retained context reconstructs
the conversation. This local journey is distinct from a live model/Telegram pilot.
