# Telegram widgets

RepoDesk supports Bot API 10.4's `sendWidget` for self-contained interactive HTML
in an ordinary private assistant conversation, including private Topics. The
default-enabled **Telegram widgets** preset supplies instructions and a rendering
guide through `load_skill`. Existing workspaces receive the preset on read, with
a stable workspace-local ID, and persist it on their next change. Existing slug
collisions, disablement and full catalogs are preserved; existing run pins do not
gain new grants. New workspaces include it with the other starter presets.

The assistant proactively chooses a widget when a visual comparison, diagram,
interactive calculation or scenario exploration materially helps the answer. A
request does not need to mention widgets, interactivity or charts. Simple facts,
brief explanations, acknowledgements, status updates and text-only requests use
text. Selection is a model judgment from the conversation, without a keyword
router or a separate presentation approval. The main prompt reinforces this only
for an authorized run with a matching private bot thread and a pinned widget
skill granting the tool and its rendering guide. The guide is loaded after the
assistant decides a widget helps; it is not included in every prompt.

On workspace reads, the unchanged, application-owned original preset receives a
new immutable published snapshot and a revision increment. Its ID and enabled
state are preserved, including when the catalog is full. Existing runs and
workflows keep their exact pins; future runs use the latest enabled snapshot.
Custom slug collisions, changed instructions, imported/conversation-created
skills, archived records and deleting workspaces are not upgraded. Repeated reads
are idempotent, and the snapshot is persisted on the next workspace change.

The skill's Markdown and supporting guide are bundled into `dist/telegram-widgets`
by the build. No external dependency, service lookup or BotFather setup is needed.
Registration is local; the production startup fixture includes the tool and preset
for owners and ordinary members even when unrelated integrations are unavailable.

## Execution and delivery

`send_telegram_widget` accepts `html`, a required plain-text `caption`, and optional
`width`/`height`. Application state binds the actor, bot, chat, private Topic and
reply. A pinned enabled skill must grant the tool. Workflow runs, groups and runs
without a private bot thread cannot use it. The application validates UTF-8 HTML
bytes (32,768), zlib level-9 bytes (4,096), NUL exclusion, caption length (1,024)
and dimensions. Telegram's compressor may differ at the boundary; a server
rejection still follows the safe caption fallback path.

One widget is staged per run. Identical calls are idempotent; changed arguments
for the same call ID conflict. A new call can revise the staged presentation;
replaying an older call never replaces the revision. New live input suppresses
a stale presentation until revised for that message. Staging has no external effect.
Only a successful answer publishes a durable `run:RUN_ID:widget` delivery beside
the ordinary rich-text answer. Partial/failed/cancelled, approval-waiting and Codex
handoff results do not publish widgets. The text remains useful independently.

Delivery rechecks membership, retained sources, skill grants, source permissions,
workspace/deployment pause, current bot and exact staged payload before sending.
The bot sends `allow_queries:false`, `is_shared:false`, `protect_content:true`,
with the caption below the widget. Rate limits honor retry hints, up to five
attempts. A confirmed widget rejection queues its caption using `sendMessage`.
Unknown outcomes and interrupted sends remain `delivery_unknown`: no retry or
fallback that could duplicate the message. Private Browser HTML is encrypted
with run/delivery content; source erasure and retention remove staged HTML.

## Supported scope and verification

Controls can change local calculations or views. Bot queries, mutable server
state, shared widgets, inline mode, wallet operations and widget-authorized writes
are outside this implementation. No widget update subscriptions are installed.
These are distinct from Telegram's broader platform support.

Deterministic coverage checks ingress, executor, staging and delivery with fake
Telegram/model transports, plus grants, duplicate events/calls, tenant/Topic/bot
boundaries, source removal, retries, uncertainty, encryption and preset upgrades.
Prompt coverage checks private eligibility, current grants, text-only/simple-answer
guidance and on-demand rendering instructions. Production Store coverage checks
upgrade persistence and unchanged old pins; ingress/executor coverage uses an
ordinary cost question without an explicit widget request. The fake model proves
prompt/tool wiring and delivery, not real-model selection quality.
Browser coverage exercises the guide's real HTML example at 320/430px in light/dark
and the saved preset at desktop/mobile widths. A browser does not emulate
Telegram's restricted rendering profile. Native desktop/mobile Telegram behavior
and real-model output quality remain staging checks. See the
[runnable conversation examples](../../examples/telegram-widgets.md).

Sources checked November 10, 2026: [Bot API 10.4 changelog](https://core.telegram.org/bots/api-changelog#november-9-2026),
[widget profile and design guide](https://core.telegram.org/bots/widgets),
[sendWidget](https://core.telegram.org/bots/api#sendwidget).
