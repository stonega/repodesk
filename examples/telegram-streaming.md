# Rich replies and native Stop

Requires a deployed worker with this change, a configured streaming model and an
authorized Telegram user. Use Bot API 10.3 or newer. Existing webhook deployments
must explicitly re-register the webhook through Setup so its subscription includes
`stopped_message_generation`; polling picks up the new subscription on worker restart.
This is an explicit manual staging check; automated tests
use fake Telegram/model transports and do not send messages.

In the bot's private chat, send:

```text
/ask Compare three ways to organize a weekly engineering review. Use a heading, a comparison table, a task list and a short code example.
```

Expect no “Queued” message. When execution starts, Telegram shows its native
“Thinking…” placeholder, which becomes a temporary reply that grows as the model
generates text, followed by one
persisted final answer without an automatic coverage block or run-ID footer. Model reasoning and tool
arguments must not appear. A fast response may produce only one preview.

For a longer request, press the native **Stop** button on the draft. The run should
become cancelled in the panel, generation should stop, and no pending final response
should publish. Partial drafts are not saved. As a fallback, copy the run UUID from
the panel and send `/cancel REPLACE_WITH_RUN_UUID`.

Switch workspaces while a preview is active, then press its Stop button: only the
original run should be cancelled. Repeat the request in a linked group: expect one
completed rich message with a real table and headings, without streaming or Stop.
There is no queue acknowledgement in groups either. Repeat with `/recap` and a
reply containing `/correct once Make it shorter` to check the same delivery flow.

Local deterministic validation:

```sh
NO_PROXY=localhost,127.0.0.1 bun test tests/unit/telegram-draft.test.ts tests/unit/agent.test.ts
# Optional disposable PostgreSQL root URL; the suite creates its own databases:
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres \
  NO_PROXY=localhost,127.0.0.1 bun test tests/integration/telegram-generation.test.ts tests/integration/system.test.ts
```
