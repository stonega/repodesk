# Native Telegram reactions

RepoDesk's interactive assistant can use `react_to_message` to choose an occasional
native emoji reaction to the current requester's message in private conversations
and linked groups/Topics. The model chooses whether to react and which supported
emoji fits; reactions are not automatic acknowledgements or task-status signals.
The ordinary final answer remains independent of the reaction.

## Runtime and authorization

The tool accepts only `emoji`, from a small standard-emoji palette. Both `❤` and
`❤️` normalize to Telegram's `❤`. The application binds the target to the current
run's retained user source, requester, chat, Topic, thread and bot. The model cannot
provide a destination, message ID, source ID, custom emoji or animation settings.
Scheduled runs and requests without a native retained message cannot react.

An active member needs no additional saved-skill grant for this conversational
tool. Dispatch still checks tenant/run identity, the execution fence, active
membership, source retention, cancellation, workspace/deployment pause and bot
identity. One durable intent, `run:RUN_ID:reaction`, records the choice per turn.
Duplicate tool calls reuse the intent; a second emoji choice is rejected.

The existing delivery worker rechecks policy and target identity before calling
[`setMessageReaction`](https://core.telegram.org/bots/api#setmessagereaction).
It sends one standard emoji with `is_big:false`. A reaction creates no Telegram
message, reply anchor or assistant-history entry; its delivery has no `remoteId`.
The tool reports queuing, rather than claiming a confirmed Telegram effect.

Rate limits honor retry hints. Uncertain outcomes and interrupted sends can retry
the same reaction, which replaces the bot's existing choice rather than adding a
new message. Retries stop after five attempts. A permanent rejection or exhausted
attempts ends that optional delivery without affecting the final answer or sending
an emoji as fallback text. A timed-out reaction may already be visible even when
its final status is failed. Cancellation or revocation cannot retract effects
already accepted by Telegram.

## Telegram limits and verification

Bots can select at most one reaction per message. Available reactions and chat
permissions still apply; some service messages cannot be reacted to. Custom and
paid reactions are outside this implementation. No reaction update subscription is
needed for sending; processing user reaction events is outside this feature.

Deterministic unit and PostgreSQL integration coverage exercises actual ingress,
executor tool registration and delivery with fake Telegram/model transports,
duplicate updates/calls, process restart, source/audience boundaries, bot rotation,
revocation, retries and independent final replies. Live Telegram desktop/mobile
rendering and real-model reaction frequency remain staging checks; see the
[manual scenario](../../examples/telegram-reactions.md).

No new dependency, SQL migration, panel setting or BotFather change is required.
