# Recover an explicitly opted-in private reply

Use deterministic fixtures; do not register a webhook or send live messages locally.

```sh
TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/TEST_DB bun test tests/integration/private-threads.test.ts tests/unit/telegram-topic-fallback.test.ts --timeout 15000
```

1. Authenticate a private Topic request through normal ingress, execute it once,
   and save its ordinary result delivery.
2. With no opt-in, simulated `telegram_thread_not_found` fails in the original Topic.
3. For a consenting fixture member, configure the current bot-bound preference.
   Simulate that same confirmed rejection, then reconstruct the delivery worker.
4. The second attempt goes to the same private chat without Topic/reply parameters.
   It includes the recovery explanation; the receipt keeps logical `topicId: 77`
   and records `deliveredTopicId: 0`. The model executes once.
5. Repeating the job sends nothing. Revocation before retry cancels the intent;
   an uncertain main-chat send remains unknown and is never automatically replayed.

See [the host runbook](../docs/implementation/telegram-topic-fallback.md) for the
separate, explicitly authorized production recovery operation.
