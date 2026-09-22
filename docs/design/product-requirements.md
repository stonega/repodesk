# DeepX Agent: Telegram product requirements

Status: **product contract**, 2026-09-18. P0 has a local implementation; live release
gates and deliberate limits are recorded in [implementation evidence](../implementation/implementation-status.md).
P1/P2 remain proposed.
Research baseline: [Every feature inventory](../research/every-agent-features.md).

## Product intent

A shared assistant for teams already coordinating in Telegram. A member delegates a
task in chat, reviews the result, turns useful work into a recurring workflow, and
teaches the assistant conventions colleagues can reuse. The first useful outcome is
an approved, repeatable team report, not unrestricted access to every company system.

Working name: DeepX Agent. This name follows the repository; it does not imply an
exchange/trading integration. The first audience is small product, engineering,
operations, sales and support teams using Telegram groups or supergroup topics.

Primary users:

- **Champion:** introduces the bot, demonstrates a useful workflow, teaches conventions.
- **Member:** requests work, reviews outputs, runs shared workflows.
- **Admin:** connects chats, manages members, access, budgets and retention.
- **Connection owner:** authorizes an external account and explicitly controls delegation.

## Scope and priorities

**P0 / usable pilot:** private onboarding, one explicitly linked team group per
workspace, deterministic command/mention/reply routing, source-grounded recap generation,
one manually triggered and scheduled recap workflow, approvals, scoped instructions,
status/cancellation, tenant boundaries, usage limits, run history, deletion controls
and an authenticated web admin panel with first-run admin/bot setup and skill management.

**P1 / team beta:** multiple explicitly linked chats, richer corrections and memory,
blocker/follow-up workflows, one read-only connector, files, monitoring suggestions,
connection delegation and richer administration.

**P2 / expansion:** external write tools, executable skill extensions, additional connectors,
Mini App dashboard, advanced artifact formats, voice intake and commercial billing.

Excluded from the initial release: autonomous trading, arbitrary shell execution,
unrestricted web sessions, importing all Telegram history, accessing personal Telegram
accounts, silently joining chats, and automatically spending from a payment method.

## F01 — Identity, onboarding and workspace creation (P0)

First web load must provide [admin creation and bot setup](first-run-setup.md), with
a one-use deployment claim, local admin login, encrypted credential inputs, owner
verification, whitelist and skill selection, and explicit activation. Interrupted setup
resumes after login; initialized deployments cannot be claimed again.

Inspired by E-25–35, E-49–50. A Telegram account is an identity; a group is not
automatically a company or tenant. An internal workspace owns each connected chat.

- `/start` in private chat explains capabilities, current limitations and data scope.
- Champion creates a workspace and confirms name, timezone and role.
- Adding a bot to a group and linking that group are distinct operations. Confirm
  Telegram admin authority and workspace admin authority before establishing the link.
- A one-time, expiring link token binds an explicitly selected group to the workspace.
- Display whether the bot can receive all group messages or only directed interaction.
- Default to command/reply mode. Monitoring is a separate opt-in setting.
- Never treat unfinished setup, silence or a model guess as permission.
- Support a configurable allowed-user whitelist, managed in the admin panel. Default
  to whitelist-only; enroll and allow the workspace creator atomically. Authorize by
  Telegram user ID, and recheck eligibility for callbacks, jobs and scheduled runs.
  See [access-control requirements](access-control.md) for modes and revocation rules.

Acceptance: no data processing job begins before the chat is active; one chat cannot
silently join two workspaces; a non-admin cannot claim someone else's group; repeat
`/start` resumes setup rather than duplicating it. Private content never appears in
group onboarding. If a welcome DM is unavailable, provide a Start link in the group.

## F02 — Conversation routing and context (P0)

Inspired by E-01, E-07. Support private chat text, delivered `@botname` mentions,
`/ask@botname` and replies to the
bot. Use current bot identity and Telegram entities for commands; do not rely on a
substring username match. Plain group mentions are best-effort only where delivered.

Associate each request with workspace, actor, chat, topic, reply chain and run ID.
Answer directly and keep context handling silent unless asked. Resolve ordinary
ambiguity from the conversation or a reasonable low-risk assumption. Ask one focused
clarification only when essential information is missing and the answer or action
would otherwise be materially incorrect or unsafe. Required approvals still apply.
Reject unsupported media honestly. Group-wide passive response classification is P1.

Acceptance: ignore unrelated chat, commands addressed to other bots and bot senders
by default; keep simultaneous topics separate; duplicate update delivery creates one
logical run; missing essential facts produce a brief statement of the specific
unknown rather than fabricated history or routine context explanations.

## F03 — Task execution and reviewable results (P0)

Inspired by E-02–03, E-19–24. Generate an answer/draft with a short summary, evidence
links or source references, relevant date range, incomplete-data caveats and run ID.
Make facts, inferences and suggested actions distinguishable. Preserve the approved
format on repeat runs. Ask before widening the audience or executing external writes.

Track `queued`, `running`, `awaiting_input`, `awaiting_approval`, `succeeded`,
`failed` and `cancelled`. A run can end as `partial` when explicitly reported
incomplete. Use concise progress messages and edit status rather than flooding chat.

Acceptance: users can inspect status and request cancellation; completed output
returns to the right chat/topic; errors include a recovery action; unsupported work
does not appear completed. P0 exposes no external write tools at all.

## F04 — Recurring workflows and scheduling (P0)

Inspired by E-08–11, E-15. Convert a natural-language instruction into a structured
draft containing name, task, input sources, time window, timezone, recurrence,
destination, owner, instructions, allowed tools, budget and approval policy.

- Show a readable preview and next three execution times; require activation.
- Confirm ambiguous dates/timezones. Store an IANA timezone and explicitly define
  daylight-saving behavior rather than silently converting to a fixed UTC time.
- Provide list, inspect, run-now, edit, pause, resume and delete actions.
- Every run references the workflow version that produced it.
- Corrections modify future runs; an in-flight run keeps its starting version.
- Recheck permissions, owner validity, connector grants and budget at execution.
- Use a unique occurrence key to prevent duplicate runs after retries.
- Default missed-run policy: skip stale occurrences, notify owner, do not flood a
  chat with historical catch-up outputs. Make the threshold a documented setting.

Acceptance: a rejected draft never runs; repeated approval is harmless; paused
workflows do not enqueue new work; permission loss blocks execution; timezone/DST
fixtures match the preview; scheduler retries cannot double-publish a report.

## F05 — Approvals and action policy (P0)

Inspired by E-13 and source ambiguity around approval breadth. Deterministic policy
decides whether approval is required; model output alone cannot grant permission.

An approval records requester, authorized approver, exact proposed action, sources,
destination, workflow version, expiry and immutable payload hash. Buttons support
approve, edit and reject. Changes to action/destination invalidate the old approval.
Store callback payloads as short opaque IDs and validate them server-side.

P0 activation authorizes a bounded schedule, including future report publication to
its displayed destination. A new destination or wider source scope needs a new review.
External sends/edits/deletes remain a later, separately governed capability.

Acceptance: another user cannot approve an owner-only action; expired or replayed
callbacks cannot execute; two concurrent clicks execute once; approving one run does
not grant unlimited future authority. A cancellation cannot undo an already sent message.

## F06 — Instructions, corrections and team memory (P0 core, P1 advanced)

Inspired by E-04–06 and E-48. Begin with explicit workspace and workflow instructions,
not invisible automatic memory. A user can say “remember this” or correct a run;
the bot proposes the persistent change, its scope and who can use it.

Memory records include content, scope, author, source run/message, timestamp,
version, status and optional expiry. Scope choices: personal, workspace, workflow.
Personal memory stays personal unless explicitly promoted. Store preferences and
stable facts separately from task state and raw message history.

Provide list, edit and forget; admins manage workspace facts. Explain conflicting
instructions and ask which should replace the older rule. P1 adds richer retrieval,
confidence, stale-fact review and rollback. Never store credentials as memory.

Acceptance: a correction affects the next run; colleagues can reuse approved team
instructions; deleting memory prevents future retrieval; tenant-crossing and personal-
to-group leakage tests pass. Memory adoption is visible and attributable.

## F07 — Observation, suggestions and blocker triage (P1)

Inspired by E-12, E-14, E-16–18. Admin explicitly enables monitoring for a connected
chat/topic, receives a coverage explanation, and selects retention and digest cadence.
Read only delivered, authorized messages. Identify unresolved decisions, missing
owners, overdue follow-ups and repeated chores with links to supporting conversation.

Suggestions are drafts, never auto-created workflows. Store declined ideas so they
are not continually repeated. Configure quiet hours, maximum digest frequency and
an admin kill switch. Do not treat unavailable history as evidence of no activity.

Acceptance: disabling monitoring stops new observation jobs; expired messages are
not summarized; each blocker includes evidence and uncertainty; rejection suppresses
the same suggestion; reporting excludes chats outside the approved scope.

## F08 — External connections and tool access (P1 reads, P2 writes)

Inspired by E-41–46. Start with one justified connector (candidate: GitHub read-only
for PR reports, or Google Drive read-only for document work). Select based on pilot
needs before adding dependencies or OAuth scopes.

Connections default to owner-only. Owner may explicitly grant named members or the
workspace access, with a visible warning that actions use the owner's upstream rights.
Record provider, scopes, owner, encrypted credential reference, sharing policy,
health and revocation time. Validate permissions per action and scheduled run.

OAuth is completed on a secure browser page with state/PKCE where supported; bind
the callback to the initiating Telegram identity and workspace. Never collect
passwords or tokens through group messages. Treat retrieved content as untrusted.

Acceptance: disconnect immediately blocks new calls; sharing changes invalidate
affected work; audit records actor/connection/action/time/outcome without secret or
document content; membership removal revokes delegated access. No credentials enter
model context. Reads from one audience cannot be posted to another without authorization.

## F09 — Files, links and generated artifacts (P1)

Inspired by E-22, E-44, E-46–48. Accept selected document types and public links,
record their origin and permissions, enforce byte/type limits, and fetch files only
when needed. Keep raw uploads separate from extracted text and derived artifacts.
Do not assume a Figma URL is readable without a connector.

Outputs start with Telegram text and Markdown/text attachments. Add richer exports
only when required. Artifact records contain tenant, run, source references, media
type, storage key, audience and expiry. Download links are authorized and expiring.

Acceptance: oversized or unsupported files produce clear errors; URLs cannot access
private infrastructure or credential-bearing endpoints; removal of an input source
invalidates access to derived content as policy requires; artifact links do not bypass
tenant checks. Prompt injection in files cannot change tool permissions.

## F10 — Admin web panel, roles and audit (P0)

Inspired by E-37–43, E-48–49. Initial administration uses a web panel plus private
bot commands. See [admin panel requirements](admin-panel.md) for screens and APIs.
Admins manage chat links, roles, workflow owners, monitoring, retention and budgets.
They also configure allowed users, including bulk ID entry, access-mode changes and
audited removal. Whitelisting never grants admin privileges or wider source access.
Members can run shared workflows but cannot grant access they do not own.

Audit workflow edits, approvals, memory changes, connection delegation, membership
changes and deletion. Capture actor, target, version, time and outcome. Do not store
raw private text in general logs. The panel includes bot/model settings, chat access,
workflows, instructions, run history, usage, members, privacy and audit. A Telegram
Mini App wrapper remains optional later.

Acceptance: admin API requests and commands validate server-side role and Telegram identity regardless
of command menu visibility; removed members lose access; chat migration updates
bindings safely; one user's multiple workspaces remain isolated.

## F11 — Usage, cost controls and billing (P0 metering, P2 payments)

Inspired by pricing research, with no chosen subscription model. Record model,
input/output usage, provider cost basis, run, actor, workflow and workspace. Expose
estimated cost before expensive work and actual recorded usage after execution.

Enforce per-run tool/step/time limits and workspace daily/monthly budgets. Reserve
budget before dispatch, reconcile after completion and prevent concurrent overspend.
Display incomplete provider usage as unknown, not zero. A funded internal pilot may
have budgets without payments. Decide payment channel and current Telegram digital-
goods requirements before implementing a paid plan.

Acceptance: exhausted budget prevents a new model run; retries do not double-charge;
usage totals reconcile to provider records; admins see only their workspace; failed
jobs report any real incurred cost. Auto-refill is not part of P0.

## F12 — Privacy, retention and removal (P0)

Inspired by E-52–59. Define separate retention for message cache, task state, files,
memory, audit and provider state. Proposed pilot defaults: 30-day raw message cache,
30-day run source snippets, explicit memory until deleted, and 90-day metadata-only
audit. These are product decisions to validate, not implemented deletion guarantees.

Private instructions/files never become team data automatically. Minimize model
inputs, redact routine logs, document actual providers and retention before a pilot.
Provide `/privacy`, personal-data deletion requests and admin workspace deletion.
Stop execution immediately on unlink/uninstall; purge asynchronously with status
and a documented completion target. Provider-side deletion must be tracked separately.

Acceptance: deletion revokes retrieval and queued work immediately; sweeper fixtures
cover expiration and references; operational tools cannot browse private payloads;
user confirmation explains that deleting our copy does not delete Telegram originals.

## F13 — Reliability and operational support (P0)

Webhook authentication, bounded input parsing, durable event acceptance, deduplication,
queue retries, backoff and dead-letter handling are prerequisites to a real bot.
Publish completion only after final state is committed. Respect Telegram retry hints
and classify blocked chat, revoked token, deleted topic and provider failure separately.

Use correlation IDs and metrics for accepted events, queue age, run latency, failed
delivery and cost. `/help` includes current capabilities; support reports can use
run IDs without forwarding private content. An operator can pause model dispatch
while leaving status/support endpoints available.

Acceptance: webhook retries do not multiply jobs; process restart does not lose
accepted work; partial publication is recoverable; cancellation blocks future steps;
permanent delivery failures do not retry forever; no external request is falsely
reported as successful after a timeout with an ambiguous outcome.

## F14 — Web-managed skills and reusable workflow templates (P0)

Inspired by the dashboard's skills listing; Every's actual skill format is unverified.
See [web skills management](agent-skills.md). P0 includes an admin catalog/editor,
Markdown import, configuration, test, publish, enable/disable, scoping and rollback.
Our skill proposal: versioned instructions, expected inputs/outputs, allowed tools,
owner, examples and evaluation fixtures. Ship curated templates and editable instruction skills; executable code bundles
remain a later capability. A skill cannot expand the caller's permissions.

Acceptance: skills are configured through the web panel and selected during onboarding;
workflows pin a version; updates can be tested before adoption; invalid
inputs are rejected clearly; skill evaluation includes permission-denial cases.

## F15 — Telegram-specific enhancements (P2)

Optional voice transcription, multilingual commands, private topics, Mini App
administration and newer guest/bot-to-bot interaction modes should be separate
experiments. None is needed to validate recurring team reports. Recheck current
platform support and add loop prevention before enabling bot-to-bot workflows.

## Workflow templates to design and evaluate

| Template | Inputs | Output | Required boundary |
| --- | --- | --- | --- |
| Weekly team recap (P0) | Received messages, selected time range, approved format | Shipped work, decisions, blockers, next steps, source references | Only data from the connected chat and available retention window |
| Open PR digest (P1) | Authorized repo/PR metadata | Stale PRs, owners, review requests and links | Read-only repository grant; no inferred GitHub access |
| Support themes (P1) | Approved support discussions | Themes, examples, frequency estimates, recommendations | Redact customer details; acknowledge sample coverage |
| Follow-up queue (P1) | Explicit commitments and due dates | Pending owner/date/status list; drafts of reminders | No automatic outreach to new recipients |
| Blocker digest (P1) | Monitored topic and age threshold | Unresolved decision/owner gaps with evidence | Speculative issues labeled as inference |
| Social pack (P2) | Approved source document/design export and style instructions | Draft posts with source citations and variant lengths | Draft only until separate publication approval |

## Proposed success measures

Measure a two-week internal pilot before making commercial promises. Suggested
initial targets, to be adjusted with evidence:

- At least 5 pilot teams; 4 create a useful approved workflow within their first week.
- At least 60% of activated teams rerun or retain a schedule the following week.
- At least 80% of reviewed recap outputs are accepted with only minor edits.
- At least 95% of due pilot recaps reach their destination within five minutes,
  excluding explicitly blocked permission/budget cases reported separately.
- Zero unauthorized cross-workspace disclosures in test and pilot review.
- All production model runs have attributable usage or an explicit reconciliation flag.

Track time to first useful result, workflows retained, corrections per run,
unnecessary notifications, failure reasons, delivery delay and cost per accepted output.
Do not equate message volume with product value.

## Decisions still required

Model/provider; pilot connector; whether group observation requires admin status;
retention and purge target; initial languages; workspace membership invitation flow;
paid plan economics/payment channel; whether a Mini App wrapper is actually needed. The repo
can progress through the local scaffold and deterministic transport work without
pretending those decisions are settled.
