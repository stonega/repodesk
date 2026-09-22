# Group conversation examples

Implemented locally. The manual steps below are staging acceptance scenarios; they
have not been sent to Telegram by local verification.

Run deterministic tests with disposable PostgreSQL:

```sh
NO_PROXY=localhost,127.0.0.1 TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  bun test tests/unit/group-conversations.test.ts tests/integration/group-conversations.test.ts --timeout 30000
```

For manual acceptance, use a linked group with two authorized members and a bot that
receives ordinary group messages. In BotFather this requires disabling Group Privacy
and re-adding the bot, unless the bot already receives them as an administrator.
Use the configured bot's actual username.

1. A sends `/ask@your_bot 帮我写部署方案` and waits for the answer.
2. B sends `/ask@your_bot 帮我写招聘文案` and waits for the answer.
3. Within five minutes, A sends `再详细点` as plain text. The answer should expand
   A's deployment discussion, with no reference to B's recruiting copy.
4. B replies to the bot's deployment answer with `加上回滚演练`. B joins that public
   discussion. After its answer, B can send a plain `换成英文` within five minutes.
5. A sends `@someone_else 再详细点`, then plain `继续`. The bot should stay quiet.
   A can explicitly ask the bot to resume the retained discussion later.
6. Repeat in another native Topic. Context and attention must stay separate. Repeat
   after five minutes, before the bot finishes, and with an unauthorized user: plain
   text should not start an answer.
7. Ask `/recap@your_bot`. It should use available group coverage, preserving the
   existing collection rules. Reply explicitly to discuss the recap.

Inspect the run in the admin panel for a separate `followup` usage attempt and a
normal answer attempt. A rejected candidate has no group delivery and retains only
sanitized run/accounting metadata unless ordinary collection was enabled. Long group
conversations should also show `compaction` attempts and frozen summaries, with
original retained messages still available for scoped retrieval.

Test failures/cancellation/provider recovery with the deterministic suite rather
than intentionally generating unknown charges against a paid provider. No setup,
webhook registration, deployment or real messages are part of these tests.
