# Telegram adaptation and platform constraints

Reviewed 2026-09-18. This is implementation guidance for proposed features.

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

## Product decisions derived from those constraints

| Slack concept | Proposed Telegram design | Consequence |
| --- | --- | --- |
| Workspace | Internal tenant containing explicitly linked chats | Never infer company membership from a Telegram username or group title. |
| Channel | Group/supergroup; broadcast channels are later scope | Group membership, bot reach and publication rights need separate checks. |
| Thread | Reply chain and, when present, forum topic | Include chat/topic IDs in context keys and delivery destinations. |
| Mention anywhere | Command or reply in an approved chat | Do not promise delivery of every plain mention under privacy mode. |
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
