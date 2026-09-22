# Group conversations and natural follow-ups

Implemented locally, 2026-09-22. Live Telegram/model acceptance remains a deployment
check. This extends [Topic memory](private-threads.md) to interactive group requests.

## Conversation scope

An ordinary human sender is identified by Telegram `from.id`, never by display name
or username. Anonymous administrators and messages sent on behalf of a channel
(`sender_chat`) cannot identify a person reliably and do not start assistant runs.

Each workspace/bot/group/native-Topic/user resumes its most recent interactive
conversation. Groups without Topics use topic zero. A and B can discuss different
subjects without their short follow-ups being routed to whoever spoke last.
Clear new subjects within a conversation are recorded internally without a prompt
to create or switch conversations. No New/Recent conversation UI is added.

Replying to a confirmed, retained bot answer in the same group/topic/bot joins its
conversation and records the sender as a participant. Subsequent requests from
that participant continue it. The original participant can continue too. Cross-topic,
cross-bot, expired and unknown anchors cannot switch the current conversation.
Message content alone does not silently change thread membership: the model can
retrieve related public discussions when interpreting an explicitly addressed ask.

Context contains that conversation's retained user/assistant messages in execution
order, with speaker IDs. It does not automatically mix all group messages into every
answer. `query_chat_history` can retrieve retained conversations from the same
group/topic/bot, including other participants' public discussions, but cannot retrieve
private chats or other topics. Private retrieval remains restricted to the requesting
user's private history. Every tool still checks current workspace access.

Manual `/recap` and scheduled workflows retain group coverage and existing workflow
permissions; they do not become a participant's interactive thread. Use Reply or an
explicit ask to discuss their answers. Existing legacy group runs remain unchanged;
new interactive Telegram requests establish the new thread mapping.

## Automatic reply decision

The first interaction remains an explicit command, mention or reply to the bot.
An unaddressed message is only a candidate when all of the following hold:

- The sender is an authorized human in an active, linked group.
- Their most recent interactive run in this bot/group/topic has a retained answer
  and a confirmed final delivery. A teammate's answer cannot open their window.
- The answer finished within five minutes; the incoming Telegram timestamp is
  recent and not before that answer (allowing Telegram's one-second precision).
- The message contains at most 500 characters of nonempty text and has no reply,
  mention, text-mention entity, or command directed elsewhere.

Time and length are conservative application defaults, not Telegram limits. The
window uses answer completion time; delayed deliveries do not extend it. While a
candidate or another answer is pending, additional plain messages do not start more
model calls. Explicitly addressed requests continue through the normal queue.

Each candidate receives one bounded tool-free Pi classification, using the configured
model, the actor, up to six recent conversation excerpts, and the current message.
Only the exact verdict `REPLY` enters normal answering. `IGNORE`, malformed output,
uncertainty and classifier failures remain silent. The classifier is instructed to
recognize semantic continuations across languages, not just a list of keywords.
It has no tools, extension hooks, approvals, previews or ability to answer the group.

Messages addressed to teammates/other bots and non-conversation control commands
close that user's attention window. This also invalidates a pending classifier's
anchor. An ignored candidate closes the window until another explicit interaction.
When the bot is clearly addressed, it resolves ordinary ambiguity from the
conversation or a reasonable low-risk assumption. It asks only when essential
information is missing and the answer or action would otherwise be materially
incorrect or unsafe. Ambiguity about whether it is addressed stays silent.

## Persistence, budget and retention

Ingress deduplication, workspace locking, per-thread execution order and outbox
delivery are reused. Candidates are runs with a separate classification checkpoint;
completed verdicts can be recovered without another provider call. The main prompt
and execution transcript never include the classification transcript.

Classification shares dollar/turn limits, deadline, cancellation, permissions and
fencing with the eventual answer. It leaves at least one provider turn for answering.
A one-turn workspace therefore skips automatic follow-up answering; explicit asks
remain available. Unknown provider outcomes remain reserved and are not replayed.
Source hashes include speaker identity; edits, removal or revoked access stop stale
classification. Failure before acceptance does not send an error message to the group.

Candidates are temporarily persisted for durable processing. On ignore/failure their
task, source snapshots and classifier transcript are cleared, leaving accounting
metadata. Their original message is removed unless ordinary group collection is
enabled; collected originals stay unthreaded and are not marked directed. Expired
or cancelled candidates are also cleared by maintenance. Accepted follow-ups become
directed conversation messages. Unrelated group traffic is not persistently collected
without the existing admin consent. Workspace deletion removes all derived state.

The existing discussion tools, fixed summaries, threshold compaction, source retention
and stable hashed workspace/thread cache key apply to group threads, including topic
zero. Actor/request metadata stays at the end of the prompt. Joining participants
does not rewrite prior messages or the system prompt. Classification uses its own
run cache identity and consumes one extra model call for a candidate, not every group
message. Compaction preserves speaker attribution. Adding speaker identity to memory
hashes invalidates summaries made under the earlier hash format; original retained
messages remain usable and can be summarized again.

## Telegram prerequisite and validation

The bot must actually receive ordinary group messages: disable privacy mode in
BotFather and re-add the bot, or use a bot that is already a group administrator.
Enabling Topics alone does not change message visibility. No code path fetches old
Telegram history, changes BotFather settings or promotes the bot. See the official
[privacy-mode documentation](https://core.telegram.org/bots/features#privacy-mode)
and [Message identity fields](https://core.telegram.org/bots/api#message), checked
2026-09-22. Context7 was quota-limited; the privacy documentation was read directly.

Deterministic tests exercise routing, participants, privacy boundaries, prefix reuse,
discussion tools, compaction, deduplication, checkpoints, budgets and quiet failure.
These establish application behavior; they do not measure real classifier precision,
summary fidelity or provider cache hit rates. See [examples](../../examples/group-conversations.md).
