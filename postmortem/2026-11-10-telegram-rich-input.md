# Private messages acknowledged without an assistant run

Diagnostic code: `telegram_rich_input_dropped`.

On 2026-11-10, private messages were silent after source `2b05a41` was deployed.
The operator registered the initially absent webhook and redeemed an invitation.
Telegram confirmed the expected webhook, zero pending updates and no delivery
error. Services remained healthy without restarts; the access confirmation sent.

Workspace `6a084cfc-c08f-4268-a0eb-84a80fe93760`, update `915026480`, reached the
API as a new private Topic message from an active member. Safe metadata showed
neither legacy text nor caption. No source, assistant run or response was created.
No private message text or credentials were logged. A routing diagnostic with the
current member configuration created a run for legacy text; its transaction was
rolled back, with zero external calls.

The input schema discarded Telegram's documented `rich_message` field. A rich
paragraph fixture reproduces the silent drop through the production webhook.
The live metadata did not retain the rich payload, so native Telegram confirmation
remains necessary rather than inferring the full payload from the missing fields.

Normalize displayed rich content before schema stripping. Bound text, traversal
and nesting. Preserve explicit command and mention entities only when the displayed
text matches their declared target. Code and quoted blocks grant no command or
mention authority. Forwards remain reference data. Hidden URLs, buttons and widget
content are not extracted. Existing membership and audience checks remain.

Production-composition coverage submits a rich private Topic message through the
webhook, prevents duplicate execution, generates a fake-model answer and confirms
fake-Telegram delivery in the original Topic. Authentication and inactive-member
boundaries remain covered. Unit cases cover commands, foreign bot targets, UTF-16
entity offsets, quotes, forwards, edits, references, precedence and input bounds.

Do not replay old acknowledged updates: their content was not retained. Verify
using a fresh message after cutover. No dependency or migration is required.

Sources checked 2026-11-10: [Message](https://core.telegram.org/bots/api#message),
[RichMessage](https://core.telegram.org/bots/api#richmessage), and
[RichText](https://core.telegram.org/bots/api#richtext).

## Live follow-up: pricing and an unavailable private Topic

After cutover to `80946f2` in bundle `1794297677476-38110726`, update `915026482`
contained legacy text and created run `e4629e72-ac5d-4a31-ba76-9fe7ec9b9300`.
Therefore the rich-input gap was not the cause of this later run's failure.

The selected `glm-5.3-flash` had no price metadata while a per-request dollar
budget was configured. Execution stopped with `model_pricing_required_for_budget`
before a billable model attempt. The New API pricing endpoint returned HTTP 401,
and no pricing group was configured. Do not fabricate rates or remove the budget
without the operator's explicit choice.

The failure reply targeted private Topic `1997120`. Telegram rejected it with
HTTP 400, categorized as `telegram_private_topic_unavailable` (upstream response:
message thread not found). A retry of the same confirmed-failed error intent
through the production delivery worker returned the same category. Neither attempt
was ambiguous. The bot's topic settings are enabled and the registered webhook is
correct. Existing main-chat access confirmation had succeeded.

This is consistent with [Telegram Bot API issue 905](https://github.com/tdlib/telegram-bot-api/issues/905),
including November 9–10 reports of newly created private topics accepting inbound
messages but rejecting bot writes, and opening messages that never reach bots.
The upstream server-side cause is unconfirmed. An older working Topic may be a
workaround; creating another new Topic is not guaranteed to repair it. Do not
silently move private replies to the main chat. A deterministic production-path
regression proves confirmed Topic rejection does not cause an unthreaded resend.

The VPS remains healthy and the rich-input correction is deployed, with 1,466
full-suite tests and exact-image runtime/Compose/restore checks passed. Native
chat is not restored until pricing/budget configuration and a writable Telegram
destination are resolved. The current dollar budget remains unchanged.

The operator subsequently chose to remove the per-request budget explicitly.
The audited update clears only `runBudgetUsd`; monthly and other settings are
preserved. Existing failed runs are not replayed. Topic delivery remains blocked
by the confirmed Telegram rejection. The focused Topic-boundary suite passes all
29 scenarios after disposable PostgreSQL readiness; its initial attempt stopped
during database startup, before any scenario ran.

Later safe metadata captured updates `915026487` and `915026488` as
`forum_topic_created` service messages, without any message text or rich content.
This corrects the earlier rich-format hypothesis for the empty-content events.
The deployed rich-input compatibility correction is independently covered, but
the observed remaining delivery failure is the Telegram Topic rejection above.

Run `5c24aa89-32a4-4de2-9833-79b921f4c6c3` completed successfully at
08:09 UTC with one model attempt. Its response failed delivery to Topic `1997120`.
This run predates the 08:18 UTC budget removal; it must not be presented as a new
post-change model test. No newer model run was recorded at the subsequent recheck.

At the operator's next recheck around 08:50 UTC, the VPS and webhook remained
healthy, both dollar budgets were null, and the latest received update at 08:48
created no new run. A third attempt to deliver the existing confirmed-failed
result in its original Topic again received HTTP 400, categorized as
`telegram_private_topic_unavailable`. The intent remains failed; no alternative
destination was used.
