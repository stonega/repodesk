# Private Topics after the data reset: cause investigation

Diagnostic code: `telegram_thread_not_found`. Investigated 2026-11-10.

## Finding and limits

The confirmed failure boundary is Telegram's explicit private-Topic resolution
before message sending. No RepoDesk serialization, Topic mapping or deployed
version regression was found. The fallback restored delivery through the main
private chat; it did not repair native Topic delivery. The precise Telegram
server-side reason remains unconfirmed.

The user confirmed Topics worked before the data reset and that the same
`@crane_stone_bot` was used. The reset's timing is a correlation, not established
causation. It intentionally erased the pre-reset database and backups, so an
independent historical bot-token/Topic-state comparison is no longer possible.

## Reset and version comparison

The protected reset receipt records 2026-11-10 03:48:52 UTC, source
`44a76df8e8f6ee54a42bf7a83b1d9eaddbc586e1`. The reset script verifies and keeps the
same application images while recreating local application volumes and secrets.
It makes no Telegram Topic creation/deletion or other Topic-management calls.
Native Telegram Topics live in Telegram, independently of RepoDesk's retained
conversation history.

Ingress still takes the native `message_thread_id` directly from the update.
`src/telegram/webhook.ts`, `src/workspaces/threads.ts` and
`src/telegram/feedback.ts` have no changes between that source and deployed
`8b51873`. The subsequent rich-input normalization preserves the Topic field.
All retained source/run/thread/delivery Topic IDs agree, and stored thread bot IDs
match the configured/current bot.

The exact old and current production DeliveryWorker implementations were run
against isolated in-memory copies of the same saved ordinary reply. The real
Store was used only for reads; all Telegram calls were captured by a fake client.
Both versions emitted the same method and byte-identical serialized request:

| Property | Pre-reset `44a76df` | Current `8b51873` |
| --- | --- | --- |
| Method | `sendMessage` | `sendMessage` |
| `message_thread_id` | `1997120` | `1997120` |
| Target chat | Same active member's private chat | Same |
| Reply parameters | Absent | Absent |
| Request SHA-256 | `b9a9c6604f7d4fb69fb1bedafb4caf599cd64b72c302b584b93dbb85bb987ffc` | Identical |

This comparison made zero Telegram requests, zero database writes and zero
unexpected SQL attempts. It does not prove historical Telegram state was unchanged;
it establishes that rolling back this delivery code produces the same failing
request for the current chat/Topic.

## Fresh user reproduction from a previously working Topic

The user sent a new test from a Topic they identified as working before the reset.
The normal webhook accepted update `915026498` at 09:34:18 UTC and created run
`79b57f43-d49f-4a19-aaff-a80434db9b8b`, preserving Topic `1997146`.

| UTC | Production evidence |
| --- | --- |
| 09:34:22 | Worker starts the run. |
| 09:34:23 | Telegram accepts the draft. |
| 09:34:26 | `deepseek-flash` completes successfully with one model attempt. |
| 09:34:27 | Final send to the original Topic fails with `telegram_thread_not_found`. |
| 09:34:28 | The explicitly opted-in main-private-chat fallback is confirmed sent. |

The final durable receipt has two delivery attempts, logical Topic `1997146` and
actual `deliveredTopicId: 0`. Source Topics match the run, and membership is active.
The bot identity matches its configured identity; Topics are enabled and user
Topic creation is allowed. The webhook matches the deployment, permits message
updates, has zero pending updates and no recorded delivery error.

This fresh test rules out the earlier missing-price/budget failure for this request:
model execution succeeded. It also rules out a missing local pre-reset conversation
mapping as the reason this received request could not be sent to its native Topic.

## Upstream mechanism and corroboration

The official [Bot API implementation](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp)
uses `check_message_topic` and `TdOnCheckForumTopicCallback` to resolve an explicit
private Topic with TDLib's `getForumTopic`. A resolution error is mapped to the
Bot API's `message thread not found` response before the send proceeds. This
message therefore does not itself disclose Telegram's underlying error or prove
that RepoDesk supplied an invented/deleted ID.

[TDLib's implementation](https://github.com/tdlib/td/blob/master/td/telegram/ForumTopicManager.cpp)
uses cached Topic data briefly, then resolves through `messages.getForumTopicsByID`.
That state/cache belongs to Telegram's Bot API/TDLib, not RepoDesk's PostgreSQL
conversation records. No claim is made that the hosted Bot API runs the exact
current master revision; these primary sources explain the observed error path.

[Upstream issue #944](https://github.com/tdlib/telegram-bot-api/issues/944) records
independent failures beginning on November 9, before this local reset. Reports
cover unchanged deployments, both cloud and local Bot API, and failures persisting
after an API 10.3 rollback. Some reports also cover previously working Topics.
[#905](https://github.com/tdlib/telegram-bot-api/issues/905) describes the related
one-way private-Topic failure. These are independent reproductions, not a maintainer
confirmation of Telegram's internal root cause. RepoDesk did not attempt Topic
creation to reproduce `BOT_TOPIC_WRONG_HOME`; that error is not claimed as a local
observation.

## A misleading diagnostic ruled out

An `editForumTopic` request omitting both optional name and icon returned HTTP 200
for the affected Topics. A control with made-up Topic `2147483000` also returned
200. TDLib returns early when neither value changes, before fetching the Topic.
These no-op results do **not** establish that a Topic exists or accepts writes.
Drafts and typing actions likewise cannot substitute for a confirmed final send.
No Topic name/icon was changed and no diagnostic Telegram message was sent.

## Operational outcome

No additional application deployment or configuration change was made during this
investigation. The existing explicitly authorized private fallback remains the
working delivery path. Native Topic delivery remains affected. A RepoDesk rollback
would emit the same request and has no demonstrated repair value. Further claims
about Telegram's internal migration, home routing or deleted state require
Telegram-side evidence; none is fabricated here.

Sanitized evidence is retained locally in
`/tmp/repodesk-topic-cause-20261110/investigation-proof.json` and in the protected
VPS release directory. No token, actor ID, private message contents or raw upstream
exception was included in the report or routine logs.
