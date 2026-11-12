# Private Topic delivery recovery

Implemented 2026-11-10. Telegram may return a confirmed HTTP 400 `message thread not
found` for a private Topic. The client classifies this as `telegram_thread_not_found`
without retaining the upstream description. Model success and delivery success are
separate; opening a Topic can also produce a service update with no user text.

## Explicit operator recovery

Obtain the named member's explicit request before enabling this workaround. Verify
the selected workspace, Telegram actor and current bot identity. There is no general
workspace default and no admin-panel toggle. The operator-only helper records an
audit event and member version. Removing membership clears consent; a new opt-in
invalidates previously queued fallback intents. No SQL migration is needed.

Bundle the recovery command from the exact release source with Bun, then execute it
inside the running application container using its existing encrypted Store and
environment. Do not copy secrets into the bundle or print workspace data:

```sh
bun build scripts/private-topic-fallback.ts --target=node --packages=external --outfile=/tmp/topic-fallback.mjs
# Copy the bundle to the authorized host, then into /app/dist/topic-fallback.mjs.
# Use explicit verified IDs, never usernames or IDs from an untrusted message.
docker exec -w /app/dist repodesk-app-1 node topic-fallback.mjs enable WORKSPACE_ID TELEGRAM_ACTOR_ID BOT_ID
# The same command with disable revokes the preference.
```

The command changes only the preference and audit record. It does not retry old
work. For an existing failed answer, first establish that every attempt received a
confirmed rejection, that no remote ID exists, and that the original run and sources
are still authorized. An explicitly authorized operator may return that specific
intent to `pending`; the production delivery worker revalidates it. Never reset a
`delivery_unknown` intent or rerun the model to recover a saved answer.

## Delivery contract

Only the original `run:<id>:result` / `:failure` ordinary private response qualifies.
The first known rejection durably saves the current bot/consent generation on the
same delivery intent. The next attempt removes both `message_thread_id` and
`reply_parameters`, keeps the same private chat and adds a short explanatory prefix.
Run context, citations and logical `topicId` stay unchanged. Successful receipts
include `remoteId` and `deliveredTopicId` (zero for the main chat), visible in Runs &
delivery's existing detail data. No frontend/editor contract changes.

Groups, scheduled work, controls/buttons, widgets, reactions, edits and Browser
requests or sealed content cannot use this fallback. Generic destination rejection,
401/403, outages and timeouts do not trigger it. A main-chat send with an unknown
outcome stays unknown; duplicate jobs cannot resend it. Membership, run permissions,
bot identity and the exact consent generation are checked before the external send.
Native Topic drafts and input routing are unchanged. A reply in the main chat does
not silently select the old Topic conversation.

Regression coverage exercises the production ingress/executor/delivery composition,
worker reconstruction, duplicate work, opt-in absence, consent/member/bot/run
revocation and ambiguous fallback outcomes. Unit tests cover the fixed transport
classification, excluded audiences/controls, host configuration and membership
reactivation. See [the repeatable example](../../examples/telegram-topic-fallback.md).
