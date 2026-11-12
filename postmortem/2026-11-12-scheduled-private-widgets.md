# Scheduled private widgets were rejected locally

Date: 2026-11-12. Status: corrected locally; deployment and native Telegram
acceptance remain outstanding.

## Report and evidence

A user requested a scheduled weather widget in a private Telegram Topic. The
scheduled answer arrived as text and attributed the failure to Telegram allowing
widgets only in private chats, suggesting moving the schedule out of the Topic.
The screenshot establishes the reported behavior and explanation, not the raw
upstream response. Production logs were not inspected in this investigation.

Telegram's current `sendWidget` documentation permits private chats and exposes
`message_thread_id` for private bot chats with forum topic mode enabled. RepoDesk's
current source independently reproduced a local scheduling restriction.

## Cause

Three application contracts excluded scheduled presentation: the workflow tool
allowlist omitted `send_telegram_widget`; widget authorization required an
interactive conversation thread and rejected every workflow using the broad
`widget_private_chat_required` error; and the bundled preset instructed scheduled
answers to use text. Workflows also pinned only their single selected procedure,
so ordinary free-form schedules could not load or invoke the widget skill.

The shared error conflated a local run-type restriction with an upstream chat-type
restriction. Moving the schedule to the main private chat would not have corrected
any of these application gates. Earlier tests asserted that schedules were denied
instead of exercising the user's scheduled private presentation through production
dispatch, execution and delivery.

## Correction

New private occurrences pin the enabled built-in presentation skill alongside the
selected procedure. Existing run pins, workflow versions, custom collisions and
disablement remain intact. Known unchanged preset versions upgrade idempotently;
application guidance explicitly supersedes obsolete schedule restrictions in old
pins. Free-form schedules retain their existing cost-query permission.

Scheduled widget authorization binds the run to the current active workflow
version, owner and exact saved private chat/Topic. The first staged widget pins
the current deployment bot, retained across replay, revision and delivery. No
interactive thread or main-chat relocation is needed. Groups remain ineligible.
Distinct local codes identify private-audience, missing-thread and changed-workflow
failures. The tool and prompt distinguish local policy errors from Telegram
rejections. Existing safe diagnostics retain workspace/run IDs without raw HTML,
private messages, credentials or upstream exception contents.

## Regression and limits

Deterministic production-path tests use disposable PostgreSQL, the real Store,
workflow dispatch, application tools, Executor and DeliveryWorker with fake model
and Telegram transports. They cover main-private-chat and private-Topic schedules,
guide loading, supplementary and old selected skill pins, duplicate dispatch,
execution and delivery, Store restart, workflow changes, bot rotation, same-Topic
caption fallback and uncertain outcomes. Unit tests cover current grants,
membership, group denial, exact audience binding and preset upgrades.

Validation passes all 1,569 tests across 163 files with Bun 1.3.14 and disposable
PostgreSQL, including 60 focused widget/workflow tests. Biome, strict TypeScript,
production build and the offline Node runtime contract pass; all 16 integration
startup cases make zero external startup calls.

No live Telegram/model call, schedule mutation, account connection or production
deployment was performed. Native client rendering and real-model presentation
selection remain acceptance checks after deployment.

Reference: [Telegram sendWidget](https://core.telegram.org/bots/api#sendwidget),
checked 2026-11-12; [implementation](../docs/implementation/telegram-widgets.md).
