# Native Topic repair attempts after the confirmed send failure

Investigated 2026-11-10. Follow-up to the
[reset and version investigation](2026-11-10-private-topic-root-cause-investigation.md).

## Native reply-anchor attempt

The user requested restoring native Topic delivery after the cause investigation.
A single, audited diagnostic send used the retained authentic input of run
`79b57f43-d49f-4a19-aaff-a80434db9b8b`. Current member, private-chat audience,
bot identity, run/source authorization and source retention were rechecked.
The request omitted `message_thread_id` and used `reply_parameters` with the
received message ID and `allow_sending_without_reply: false`.

Telegram returned success, a nonzero remote ID, `message_thread_id: 1997146`,
`is_topic_message: true`, the correct private chat and the expected reply anchor.
However, the user reported the diagnostic visible **nowhere**. This is a failed
native repair despite the matching API receipt. It must not be deployed as an
automatic retry or recorded as restored native conversation behavior.
The experimental transport was not added to production code. The probe is not
replayed after this accepted-but-invisible outcome.

## Bot-created Topic attempt

One further audited API request attempted `createForumTopic` for the same verified
private-chat member with the fixed name `RepoDesk recovery check`. Telegram returned
HTTP 400, categorized in memory as `BOT_TOPIC_WRONG_HOME`. No successful new Topic
ID was returned, so no message was sent to a guessed destination. The request is
not repeated: upstream reports describe possible creation side effects even when
this API returns an error.

This is now a direct local reproduction of the server error previously recorded
only in [upstream issue #944](https://github.com/tdlib/telegram-bot-api/issues/944).
Private Topic restoration is blocked by Telegram-side behavior: explicit Topic
sends fail, the strict reply route is invisible, and supported Topic creation fails.
The exact internal Telegram cause remains unknown.

## Current operational state

The existing explicitly authorized main-private-chat fallback is retained.
No bot credentials, budgets, model choices, webhook registration or application
runtime were changed for these probes. No old Topics or chat history were removed.
No automatic native recovery was shipped without visible acceptance. Direct Topic
link refreshing was offered as one final client check; its result is recorded in
the protected repair evidence when available.

The protected VPS release directory retains `native-repair-proof.json`. The local
proof is `/tmp/repodesk-topic-anchor-20261110/native-repair-proof.json`.
No actor IDs, tokens, raw upstream descriptions or private message contents were
written to this report or routine logs.


## Direct-link follow-up and main-chat visibility

The user reported the direct Topic link still did not restore the conversation.
A subsequent real request at 09:56 UTC reached RepoDesk as Topic `1997156`, run
`4c3eec49-9f3b-4f2e-8d67-049279e13d15`. Model execution succeeded; the explicit
Topic send failed and the opted-in main-chat fallback received a confirmed remote
ID. This receipt establishes API acceptance, not user-visible recovery.

One audited plain `sendMessage` check was then sent to the same verified member's
main private chat. Telegram returned a nonzero message ID, no Topic, no rich content,
no business/guest/ephemeral context, and the expected bot/chat identities. User
visibility confirmation remains pending. Earlier references to a "working" main-chat
fallback should be read as confirmed API delivery until the user verifies display.
No new routing or formatting change was deployed based on an unverified receipt.

The second model attempt later recorded on the 08:59 request was inspected and
identified as `memory_extract`, not a rerun of its assistant answer. No run-retry
or delivery-deduplication bug was inferred from that accounting entry.
