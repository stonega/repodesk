# Private thread examples

Run deterministic tests locally; no Telegram or model credentials are used:

```sh
bun test tests/unit/private-threads.test.ts tests/unit/live-input.test.ts
# Set TEST_DATABASE_URL to a disposable PostgreSQL server with CREATEDB privileges.
bun test tests/integration/private-threads.test.ts
```

The integration test creates uniquely named databases and exercises real ingress,
executor, history tools and delivery persistence with fake external transports.
Without TEST_DATABASE_URL it explicitly skips.

In a staging bot with native private Topics already enabled through BotFather:

1. Create/open a Telegram topic named `Kyoto` and send `Plan a Kyoto trip`.
2. Send `Add vegetarian restaurants` in the same topic without Reply. The answer
   continues the trip discussion. Send another detail while it is generating;
   the additional input joins the active Pi run at the next model-turn boundary,
   and one final answer incorporates both requests. Ordinary answers do not quote
   the triggering message; ask it to emphasize a particular message to exercise
   selective native replies.
3. Create/open a different topic named `Server` and send `Help debug my server`.
   Its default context contains no Kyoto discussion.
4. Return to `Kyoto` and send `Make it three days` without Reply. The retained
   trip and restaurant discussion is available, including after an API/worker restart.
5. Reply to an older message within `Kyoto`: it continues the latest topic context,
   without branching. A cross-topic quote, if supported by the client, must not
   switch the current topic's context.
6. Verify the thinking placeholder, streamed response and final answer all appear
   in the requesting topic. Stop one topic's generation while another topic is
   running; the other topic should continue.
7. Send `/help` in the topic. Help stays there and creates no model run/thread.
8. Switch to another enrolled workspace and ask in the same topic. The original
   workspace's context is unavailable. Switch back to resume its retained context.

Outside Topics, messages sent while an answer is running join the active
conversation. Once it finishes, standalone messages start separate threads, and
replies to retained answers or your own requests continue them. Forwarded messages and their accompanying
notes received within one minute also share a thread:

1. Forward a text message or supported attachment and add `save this` in the
   forwarding dialog, or send that note immediately afterward. The save request
   must receive the original text, origin and supported attachment content.
2. Send the note before the forward. The received forward continues the note's
   request, including if the note is already being answered. The forward is inserted as reference input at a model-turn boundary,
   without rewriting an in-flight provider prompt. Only the combined final answer
   is published.
3. Repeat inside a native Topic. Both messages remain in that Topic. Try another
   Topic or workspace and verify that unrelated content is absent.
4. After the earlier answer finishes, wait more than a minute, or send `/help`
   between the forward and note outside Topics. They should start separate conversations; Reply explicitly to the
   forward to supply its reference content.

The one-minute association applies only to received private messages. It does not
move Telegram messages or merge native Topics. Deterministic regression checks:

```sh
bun test tests/unit/telegram-private-forward.test.ts
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres bun test --timeout 30000 tests/integration/private-threads.test.ts
```

Ask about another topic explicitly to exercise history retrieval, for example:
`What did we discuss about Kyoto earlier?` in `Server`.

Example tool calls (the server supplies user/workspace identity):

```json
{"query":"Kyoto","limit":10}
```

```json
{"threadId":"<thread UUID returned by the first search>","limit":20}
```

When `hasMore` is true, repeat with the same filters and `cursor` set to
`nextCursor`. Results are excerpts from retained history, not all Telegram history.
After restart, replying to a confirmed old answer still resolves its thread.
After switching workspaces, replies cannot access the previous workspace's threads.

## Topic discussion memory and long conversations

```sh
bun test tests/unit/topic-memory.test.ts
# With TEST_DATABASE_URL pointing to disposable PostgreSQL:
bun test --timeout 30000 tests/integration/topic-memory.test.ts
```

In an explicitly configured staging bot, discuss deployment in one Topic, add a
memory constraint, then ask `Why?` or `Revise it`. Change to a hiring question in
the same Topic without Reply; the bot should answer directly. Ask to return to
the deployment decision. No new-conversation confirmation or custom thread list
should appear. Replies should omit context/memory explanations, unsolicited offers
and closing questions. For example, after `Make it three days`, expect the revised
itinerary directly, without “Based on the available context” or “Would you like hotel
suggestions?”. A concise clarification is valid only if essential information is
missing; required approvals still apply.

Internal tool examples (not Telegram commands):

```json
{"query":"deployment","limit":5}
```

Use the result's discussion ID with `query_chat_history`:

```json
{"discussionId":"<discussion UUID>","limit":10}
```

The deterministic integration fixture uses a small model capacity and a long fake
history to trigger compaction without paid calls. It verifies retained recent turns,
unchanged subsequent summary, source preservation, accounting and checkpoint recovery.
For live evaluation, compare provider cache-read tokens and actual cost over repeated
turns; check summary fidelity and recall separately. Local prefix tests establish
cache eligibility, not a guaranteed live cache hit rate.
