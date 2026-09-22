# Telegram adaptation and platform constraints

Reviewed 2026-09-20. Platform constraints and implementation guidance.

## Bot API 10.3 rich replies and Stop

Selected API baseline: **10.3**, checked against the official
[10.1](https://core.telegram.org/bots/api-changelog#june-11-2026),
[10.2](https://core.telegram.org/bots/api-changelog#july-14-2026), and
[10.3](https://core.telegram.org/bots/api-changelog#august-24-2026) changelogs.
10.1 introduced rich messages/drafts; 10.2 added outgoing structured blocks;
10.3 added compact tables and native draft cancellation.

[sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage) supports group
and private replies. [sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft)
supports **private chats only**, with an optional thread ID and nonzero draft ID.
Reusing the ID animates updates. Drafts are temporary 30-second previews; a final
send is still required. They cannot upload new files or upload media by URL.
`can_stop:true` enables Stop; `keep_on_stop` only temporarily retains the preview,
not a persisted partial message.

[MessageGenerationStopped](https://core.telegram.org/bots/api#messagegenerationstopped)
contains `chat`, optional `message_thread_id`, and `draft_id`; there is **no sender
field**. We only accept private-chat stops, using the chat ID as the actor and the
persisted bot/topic/draft/fence binding to select the run. This update must be
included in `allowed_updates` for polling and webhook subscriptions.

Implemented: rich model replies with native headings, lists/tasks, quotes, code,
dividers, compact aligned tables and safe inline formatting; private streaming;
native Stop; durable final delivery and text fallback. Arbitrary rich media,
LaTeX, inline rich buttons, ephemeral group messages and Communities remain outside
this change. Live Telegram behavior still requires staging verification.
See [manual example](../../examples/telegram-streaming.md).

## Verified platform facts

Privacy-enabled group bots receive a limited subset of interaction; admin bots or
bots with privacy disabled receive broader group traffic. Commands and replies are
the safest initial invocation contract. Mini Apps offer richer interfaces. Current
documentation also supports conditional bot-to-bot communication and guest interactions;
guest mode does not provide ongoing chat history. [Bot features](https://core.telegram.org/bots/features)

The Bot API provides update delivery, not a general arbitrary-chat history/search
interface. Use HTTPS webhooks with `secret_token`, deduplicate `update_id`, and
preserve `message_thread_id` when present. `sendMessage` text is limited to 4,096
characters after entity parsing; inline callback data is limited to 64 bytes.
Use `answerCallbackQuery` for button interactions. [Bot API](https://core.telegram.org/bots/api)

Webhook delivery and long polling are mutually exclusive. Rate limits apply by chat
and globally; handle 429 responses and retry hints instead of assuming unlimited
throughput. The older FAQ's blanket bot-to-bot restriction conflicts with newer
feature-specific guidance. [FAQ](https://core.telegram.org/bots/faq),
[newer bot communication rules](https://core.telegram.org/bots/features#bot-to-bot-communication)

## Private Topics

Telegram supports native topics in private chats with bots when topic mode is enabled
through BotFather. Incoming `message_thread_id` selects the conversation; outgoing
messages and drafts preserve it. `getMe.has_topics_enabled` reports the bot's mode.
See [private Topics](https://core.telegram.org/bots/features#topics-in-private-chats)
and [Bot API](https://core.telegram.org/bots/api), checked 2026-09-22.

The application prioritizes native topic identity over reply anchors for private
interactive requests. Topics partition default context within the selected workspace,
user, chat and bot. Outside Topics, reply-based compatibility routing remains.
See [private threads](../design/private-threads.md). Enabling topic mode is an operator
BotFather action; local implementation does not change bot settings or create topics.

## Product decisions derived from those constraints

| Slack concept | Proposed Telegram design | Consequence |
| --- | --- | --- |
| Workspace | Internal tenant containing explicitly linked chats | Never infer company membership from a Telegram username or group title. |
| Channel | Group/supergroup; broadcast channels are later scope | Group membership, bot reach and publication rights need separate checks. |
| Thread | Reply chain and, when present, forum topic | Include chat/topic IDs in context keys and delivery destinations. |
| Mention anywhere | Delivered mention, command or reply in an approved chat | Do not promise delivery of every plain mention under privacy mode. |
| Public channel discovery | Admin explicitly connects each chat | No scan of all chats a person belongs to; no automatic chat joining. |
| Historical retrieval | Locally retained, authorized received messages | Display oldest available message/time window. Never invent prior context. |
| Private onboarding DM | User starts the bot through a private link | Design around a user-initiated private onboarding flow. |
| Channel monitoring | Explicit access plus product-level monitoring consent | Broader Telegram visibility is not automatically consent to analyze everything. |
| Private channel summarization elsewhere | Source and destination authorization | Being allowed to read does not automatically permit posting to a wider group. |
| CI bot pings | Direct integration or explicitly enabled bot communication | P0 ignores bot senders; no promise to summarize events it cannot receive. |
| Dashboard | P0 admin web panel plus private command shortcuts; Mini App later | Same domain services and permissions across both surfaces. |
| Long artifact | Brief message plus protected attachment/link | Avoid uncontrolled message splitting and token-heavy repetition. |

## Transport implementation contract

1. Authenticate the webhook before expensive parsing or model work. Validate payload
   shape and cap request size. Reject unsupported variants safely.
2. Persist accepted updates and deduplication state before acknowledging success.
   Use a transactional outbox or equivalent durable dispatch pattern; an in-memory
   set is insufficient. Separate accepted delivery from successful task completion.
3. Use numeric Telegram IDs as opaque persisted identifiers (prefer decimal strings
   at application boundaries). Handle group-to-supergroup migration explicitly.
4. Recheck workspace/chat/actor authorization on callbacks and scheduled runs.
   Command menus and button visibility are presentation, not authorization.
5. Chunk text at safe boundaries or send an attachment; escape markup and never let
   untrusted text create misleading links or unsupported entity structures.
6. Store short callback IDs referring to server-side state; do not place secrets,
   full task definitions or authorization decisions inside callback payloads.
7. Serialize/retry outbound delivery per chat, honor `retry_after`, and stop on
   permanent permission failures. Track ambiguous send outcomes for reconciliation.
8. Keep polling as a local-development alternative only after a transport exists;
   never run it against a bot with an active webhook.

Before enabling payments, media-heavy workflows, newer agent features or a Mini App,
recheck the current official documentation and record the selected supported API
version. The initial scaffold does not register a webhook or process Telegram updates.
