# RepoDesk: Telegram product requirements

Status: **product contract**, updated 2026-09-27. The original P0 has a local implementation; live release
gates and deliberate limits are recorded in [implementation evidence](../implementation/implementation-status.md).
The original P1/P2 backlog remains proposed unless a section explicitly identifies
a later local implementation.
Research baseline: [Every feature inventory](../research/every-agent-features.md).

## Product intent

RepoDesk is a Telegram bot that helps people work with selected GitHub repositories.
A person asks about code or describes a desired change in chat. The AI interprets
the request, retrieves authorized repository context or drafts a bounded GitHub
action, and returns a useful answer or a proposal for human review. The first useful
outcome is a repository-grounded answer, approved issue or maintainer-approved draft
PR, linked back to the same chat. See the [primary GitHub journey](github-workflows.md).

The first audience is small engineering teams and repository maintainers using
Telegram private chats, groups or supergroup topics. Recaps, schedules and shared
instructions remain supporting capabilities, including for team coordination.

Primary users:

- **Member:** asks repository questions, reviews answers and proposes issues.
- **Repository maintainer:** may approve configured issue-to-draft-PR tasks.
- **Workspace admin/operator:** connects selected repositories, manages members,
  grants, chat access, budgets and retention.
- **GitHub installation owner:** grants the App access to repositories and required
  GitHub permissions in the upstream account.

## Scope and priorities

**Original P0 / locally implemented foundation:** private onboarding, one explicitly linked team group per
workspace, deterministic command/mention/reply routing, source-grounded recap generation,
one manually triggered and scheduled recap workflow, approvals, scoped instructions,
status/cancellation, tenant boundaries, usage limits, run history, deletion controls
and an authenticated web admin panel with first-run admin/bot setup and skill management.

**GitHub focus / next validation:** selected-repository connection through a GitHub
App, configured source questions, approved issue submission and maintainer-approved
issue-to-draft-PR tasks are locally implemented. Validate this sequence with live
GitHub, Telegram and model accounts before calling it a working pilot. A read-only
issue/PR metadata tool, including status and digest questions, is proposed next.

**Later team beta:** multiple explicitly linked chats, richer corrections and memory,
blocker/follow-up workflows, files, monitoring suggestions, more connection
delegation and richer administration.

**P2 / expansion:** additional reviewed GitHub write actions, executable skill extensions, additional connectors,
Mini App dashboard, advanced artifact formats, voice intake and commercial billing.

Excluded from the initial release: automatic merging, autonomous trading, arbitrary shell execution,
unrestricted web sessions, importing all Telegram history, accessing personal Telegram
accounts, silently joining chats, and automatically spending from a payment method.

## F01 — Identity, onboarding and workspace creation (P0)

First web load must provide [admin creation and bot setup](first-run-setup.md), with
a one-use deployment claim, local admin login, encrypted credential inputs, owner
an optional Telegram owner link, explicit member approval and skill selection,
and explicit activation. Interrupted setup
resumes after login; initialized deployments cannot be claimed again.

Inspired by E-25–35, E-49–50. A Telegram account is an identity; a group is not
automatically a company or tenant. An internal workspace owns each connected chat.

- `/start` in private chat explains capabilities, current limitations and data scope.
- Workspace creator confirms name, timezone and role.
- Adding a bot to a group and linking that group are distinct operations. Confirm
  Telegram admin authority and workspace admin authority before establishing the link.
- A one-time, expiring link token binds an explicitly selected group to the workspace.
- Display whether the bot can receive all group messages or only directed interaction.
- Default to command/reply mode. Monitoring is a separate opt-in setting.
- Never treat unfinished setup, silence or a model guess as permission.
- Allow all active workspace members to use the bot. Enroll the workspace creator
  as owner atomically. Authorize by verified Telegram user ID and recheck active
  membership, roles and scoped permissions for callbacks, jobs and scheduled runs.
  See [access-control requirements](access-control.md) for membership and revocation rules.

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
does not appear completed. The original P0 had no external write tools; the current
GitHub issue and coding paths are separately scoped and approved.

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
GitHub issue creation and coding tasks have their own exact, actor-bound approvals;
other external edits/deletes remain later, separately governed capabilities.

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

## F08 — GitHub connection and scoped tools (locally implemented paths; more proposed)

GitHub is the primary integration. The operator registers an App, then connects a
workspace to an installation and selects accessible repositories. The App's GitHub
permissions and each workspace's selected repository IDs are separate gates. Code
Truth also requires configured source targets and grants; connecting the App alone
does not enable source questions. See [the GitHub journey](github-workflows.md).

The local read path queries indexed source from configured branches. The local write
paths are a requester-approved issue and a maintainer-approved coding task that can
create an issue, start Codex and open a PR. The latter requires a separate
repository maintainer grant and runtime setup. AI output is never authorization.
Read-only issue/PR metadata and scoped digests are implemented locally as of
2026-10-07; live usefulness remains unverified. See the
[reports, skills and handoff plan](../implementation/team-workflows-plan.md).
Broader GitHub actions and other providers remain proposals.

The browser connection flow binds authorization to the operator session and
workspace. Store secrets encrypted and mint short-lived tokens restricted to the
operation and selected repository. Never collect credentials through Telegram.
Treat repository content and GitHub responses as untrusted data. Recheck current
membership, repository selection, connection revision, destination and approval
before a write; record ambiguous remote outcomes without automatic replay.

Acceptance: disconnect blocks new calls; changing repository selection invalidates
pending proposals; members cannot cross workspace or repository boundaries; source
answers identify their branch/snapshot and cite what is available; exact write
targets and payloads are visible to the authorized approver; logs and model context
contain no credentials. A private source cannot be copied into a group response
without destination authorization.

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
Workspace operators also manage GitHub installation selection, Code Truth targets
and repository-specific coding grants in the Plugins panel.
They manage member enrollment, active status and roles with audited changes.
Active membership never grants admin privileges or wider source access.
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
experiments. None is needed to validate the GitHub journey. Recheck current
platform support and add loop prevention before enabling bot-to-bot workflows.

## Workflow templates to design and evaluate

| Template | Inputs | Output | Required boundary |
| --- | --- | --- | --- |
| Repository source explanation (local implementation) | Configured Code Truth branch/snapshot | Answer with source references and stated coverage | Active workspace and repository grant; never infer live PR state from source index |
| GitHub issue draft (local implementation) | User request and selected repository | Exact title/body for approval, then issue link | Requester-bound approval; selected repository and Issues permission |
| Coding task (local implementation) | Maintainer request, configured base branch and workflow | Approved issue, task status and PR link | Repository maintainer grant and explicit issue/workflow/PR approval |
| Open PR digest (proposed) | Authorized current PR metadata | Stale PRs, owners, review requests and links | New read-only metadata tool; no inferred GitHub access |
| Weekly team recap (supporting P0) | Received messages, selected time range, approved format | Shipped work, decisions, blockers, next steps, source references | Only data from the connected chat and available retention window |
| Support themes (P1) | Approved support discussions | Themes, examples, frequency estimates, recommendations | Redact customer details; acknowledge sample coverage |
| Follow-up queue (P1) | Explicit commitments and due dates | Pending owner/date/status list; drafts of reminders | No automatic outreach to new recipients |
| Blocker digest (P1) | Monitored topic and age threshold | Unresolved decision/owner gaps with evidence | Speculative issues labeled as inference |
| Social pack (P2) | Approved source document/design export and style instructions | Draft posts with source citations and variant lengths | Draft only until separate publication approval |

## Proposed success measures

Measure the GitHub journey with a small internal pilot before making commercial
promises. Suggested targets should be adjusted after the first staging run:

- A newly connected workspace reaches its first useful repository answer or
  approved issue without operator repair after setup.
- Reviewers can identify the repository, exact issue payload and coding-task scope
  before approval; no GitHub write occurs without the required approval.
- Repository answers cite authorized sources and reviewers flag unsupported claims.
- Approved issue/coding tasks report a GitHub link or a clear failed/unknown state;
  an unknown outcome is never silently retried.
- Zero unauthorized cross-workspace disclosures in test and pilot review.
- All production model runs have attributable usage or an explicit reconciliation flag.

Track connection completion, time to first useful GitHub result, answer corrections,
proposal acceptance, task completion, failure reasons, delivery delay and cost per
accepted output. Track recap and schedule usage separately as supporting features.
Do not equate message volume with product value.

## Decisions still required

Model/provider; which GitHub issue/PR metadata questions to support next; whether
group observation requires admin status;
retention and purge target; initial languages; workspace membership invitation flow;
paid plan economics/payment channel; whether a Mini App wrapper is actually needed. The repo
can progress through the local scaffold and deterministic transport work without
pretending those decisions are settled.
