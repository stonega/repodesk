# Plugin notification events

Scope: optional plugin-declared events and personal subscriptions. The owner
requested plugin notification support on 2026-11-14 while GitHub notifications were
being completed. The first profile publishes candidates from an ordinary private
plugin tool invocation. Independent polling, external plugin webhook endpoints and
background callbacks are future producer types, not current capabilities.

## Author and runtime contract

The package and producing tool declare `notifications.publish`. The manifest adds
1–16 unique `notifications` declarations (`name`, `title`, `description`). A
notification-producing tool uses `effect: read`; compute tools retain an empty
capability ceiling. The capability permits host-managed candidate publication;
it grants no Telegram API, arbitrary external writes or new data access.

`ToolResult.notifications` optionally contains up to ten events with `event`,
stable `id`, ISO `occurredAt`, `title`, `body` and optional HTTPS `url` without URL
credentials. Limits are 32/128/120/2,000/2,048 characters respectively for event,
ID, title, body and URL. Unknown fields and event names, duplicate IDs within one
result and invalid URLs/timestamps fail validation. Even an empty notifications
array requires the producing tool's capability declaration. Generated contracts
export `NotificationEvent`; the SDK's optional third generic constrains event names.

This is an additive preview API 1 capability. Older hosts reject its capability or
manifest fields before execution. Existing packages without notifications retain
their contract. The SDK, JSON schema and portable CLI/template are regenerated
together using the pinned Bun 1.3.14 compiler. No new dependency is added.

## Host publication and privacy

Plugin code returns candidate data. Only the host may persist and deliver it after
the complete result validates and the current installation grant is rechecked.
There is no in-sandbox messaging broker and no model call for event delivery.

Candidates can reach only an active subscription belonging to the current private
invocation's actor. Another member's subscription does not receive that actor's
HTTP/GitHub results. Group invocations do not publish notifications. Installation
digest/generation, actor, bot, source-read grants and current run fence remain
host-owned. Payloads supply neither tenant nor actor/destination authority.

Publication runs under the workspace lock. Migration `025_plugin_notifications.sql`
records a unique workspace/actor/plugin/event hash and an ordinary Telegram
delivery intent in one transaction. Store.save records its outbox entry. Receipts
contain no event body/title and expire after 30 days. Events older than three days,
before the subscription activation second or over one minute in the future are
ignored. Stable IDs must represent the upstream event, not a new ID per retry.

Delivery uses the same Telegram worker as GitHub notifications. It rechecks the
subscription revision, bot, installation and the original run's source pins. Pause,
delete, revocation, plugin disable/update/configuration changes and uninstall stop
affected pending delivery. Removing an installation explicitly pauses its
subscriptions so reinstalling identical bytes cannot revive an old grant. Workspace
deletion clears subscription/receipt state; deactivated members are paused.
Uncertain Telegram sends follow the existing non-replay recovery policy.

## Management

`manage_plugin_notifications` lists enabled plugin identities and declared events,
then manages `subscribe|pause|resume|delete` for the verified current private text
request. It shares the retained-source/quote/forward/workflow checks used by GitHub
subscription management. It does not connect a source or authorize data reads.

Package details show a saved **Notifications** card only when events are declared.
New/Edit opens a shared modal. Existing records include their subscription revision
and current installation generation when saving. Removed event types are dropped
from editor drafts after an upgrade. The host derives the current panel actor;
unlinked identities cannot create subscriptions.

The endpoints are `GET|POST
/api/admin/workspaces/:id/plugin-packages/:repositoryId/notifications`, protected by
the existing panel authentication, workspace management, Origin and CSRF boundaries.
The same UI rules and acceptance criteria as GitHub notifications apply: saved
labels separate from forms, modal editing, retained failed drafts, pending dismissal
locks, shared controls, toast feedback, and right-aligned mobile management actions.

## Verification and remaining gates

The production-factory startup fixture now includes a granted notification-producing
package declaration and the management tool, across the existing owner/member,
stale/denied/missing-service cases. It still requires zero startup HTTP/credential
calls. Deterministic tests cover manifest/result ceilings, forged recipients,
private actor isolation, duplicate events, pause/resume, source revocation,
uninstall/reinstall, current generation checks and panel CSRF.

The runnable author example is `examples/plugins/repository-alerts`. It reports an
observed star threshold, without claiming the historical crossing time. The exact
job-image fixture exercises its candidate event through the real Docker sandbox;
the package integration suite also uses the real private runner client/host broker
path with that immutable image. Portable template verification is performed from an
independent directory. The Code Truth catalog is regenerated and its real-index/MCP
service smoke is required after the protocol extension.

Final combined validation: 1,755 passing tests and nine Docker-gated skips; the
exact-image/package suite separately passed all 21 cases. There are 42 distinct
selected browser passes, including a final fresh 13-case notification/package run.
Strict types, build, runtime contract, pinned portable template and Code Truth
smoke passed. Final image IDs and selection evidence are recorded in
[implementation-status.md](implementation-status.md#plugin-notification-events-2026-11-14). Local image
builds are validation artifacts, not a production release. Live model interpretation,
native Telegram rendering and real provider events remain separate acceptance.
