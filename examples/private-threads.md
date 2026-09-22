# Private thread examples

Run deterministic tests locally; no Telegram or model credentials are used:

```sh
bun test tests/unit/private-threads.test.ts
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
   the follow-up executes after the preceding request.
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

Outside Topics, the compatibility behavior is unchanged: standalone messages start
separate threads, and replies to retained answers or your own requests continue them.
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
