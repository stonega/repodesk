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
