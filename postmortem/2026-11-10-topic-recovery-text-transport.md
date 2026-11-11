# Use the verified text transport for private Topic recovery

Diagnostic code: `telegram_thread_not_found`. Follow-up on 2026-11-10.

Native Topic delivery remains blocked: explicit sends fail and bot-created Topics
return `BOT_TOPIC_WRONG_HOME`. A strict reply-anchor probe received a matching API
receipt but the user saw it nowhere. That experimental route was not deployed.

The user's latest real requests completed model execution and received API-accepted
main-chat fallback receipts using `sendRichMessage`. Their display was not verified.
A separate plain `sendMessage` diagnostic, without a Topic or reply reference, was
confirmed visible by the user. This does not establish a rich-message regression;
it establishes a usable recovery transport.

Normalize only explicitly opted-in fallback deliveries to the existing standard
text transport with text entities/links. Persist the format during the claim, after
policy checks and before the external effect. Previously queued rich fallback
intents receive the same normalization after restart. Existing source/run context,
bot-bound consent, actual-destination receipts and uncertain-send non-replay rules
remain in force. Sent or unknown old answers are not automatically replayed.

Production-composition coverage checks rich-to-standard-text method selection,
restart from a rich pending fallback, preserved links, duplicate jobs, revocation
and unknown outcomes. Native Topic restoration is a separate unresolved Telegram
issue; this correction is limited to reliable recovery in All messages.


Release `1794305442311-77002991` (source `ac7abf1`) is deployed and healthy.
Validation passes all 1,479 deterministic tests across 158 files, lint, types,
build, the local runtime contract and exact-image Compose/restore checks. The
production worker retried one previously failed saved result: the original Topic
returned 400, then `sendMessage` in the main chat returned 200. The persisted receipt
records standard text format and actual Topic zero; model attempts are unchanged.
Visibility of the recovered answer remains pending user confirmation. The earlier
plain-text main-chat diagnostic was confirmed visible. Native Topics remain affected.
