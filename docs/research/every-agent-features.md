# Every Agent: detailed public feature inventory

Baseline reviewed **2026-09-18**; public launch follow-up reviewed **2026-10-07**.
Read the [launch follow-up](#launch-follow-up-2026-10-07) for current findings and
RepoDesk recommendations. The original inventory below preserves the September
snapshot. See the [source register](../reference/sources.md) for methods and
limitations. “Documented” means publicly claimed, not tested by us. Telegram
equivalents are proposals, not implementation claims.

## Product model

At the September review, Every Agent was a beta AI coworker embedded in Slack. Its target champion was someone
who introduces AI to colleagues through useful, repeatable team work. The central
loop is to delegate a recurring task, reuse it, correct it in conversation, and let
the team benefit from that accumulated context. The interface spans chat and a web
dashboard. [Homepage](https://agent.every.to/), [installation FAQ](https://agent.every.to/install/slack)

## Conversation and collaboration

| ID | Public capability | Evidence and detail | Proposed Telegram equivalent |
| --- | --- | --- | --- |
| E-01 | Work inside team chat | Documented: mention the bot in a conversation or DM it to ask questions and delegate work. | Commands and replies in approved groups; private bot chat. |
| E-02 | Recurring work as the entry point | Documented: repeated reporting and follow-up tasks are the primary use case. | Start with a repeatable recap rather than an unrestricted autonomous agent. |
| E-03 | Preserve prior output conventions | Demonstrated: a weekly engineering recap references the prior week's format. | Versioned workflow template and approved example output. |
| E-04 | Correct work in the same conversation | Documented: feedback should influence subsequent runs. | Reply to a run, review the proposed rule change, save a new workflow version. |
| E-05 | Team-shared learning | Documented: team facts persist for colleagues to reuse. | Explicit group memory with provenance and editable scope. |
| E-06 | Teammates continue existing work | Documented: another person can build on what the initial user established. | Shared workflow ownership with member/admin permissions. |
| E-07 | Selectively respond to untagged messages | Policy-disclosed: a lightweight classifier determines whether an untagged message is directed to the agent. | Later opt-in classification in monitored groups; ignore unrelated chat. |

Sources: [support](https://agent.every.to/support), [homepage](https://agent.every.to/),
[FAQ](https://agent.every.to/install/slack), [classifier disclosure](https://agent.every.to/legal/privacy-policy).
The public material does not specify model selection controls, context limits, response
latency, language coverage, voice handling, or guarantees about memory accuracy.

## Automations and proactive work

| ID | Public capability | Evidence and detail | Proposed Telegram equivalent |
| --- | --- | --- | --- |
| E-08 | Natural-language automation setup | Documented tour: describe the task, time, and destination without building a visual workflow. | Parse a message into a reviewable workflow definition. |
| E-09 | Scheduled execution | Documented: recurring outputs run on a schedule. | Persist timezone-aware schedules and unique scheduled occurrences. |
| E-10 | Change automations conversationally | Documented tour: ask again to modify the automation. | Reply with edits; show the changed schedule or behavior before saving. |
| E-11 | Stop automatic work conversationally | Documented tour: replying can turn off an automation. | Pause/cancel controls on each run and `/automations`. |
| E-12 | Suggest useful automations | Documented: observes work and suggests recurring tasks it could handle. | Suggestions restricted to explicitly monitored chats. |
| E-13 | Approve proposed automations | Documented: suggestions are not set up until the user agrees. | Approve, edit, reject, or dismiss a proposal. |
| E-14 | Remember rejected ideas | Demonstrated: a declined suggestion is not repeatedly proposed. | Store rejection scope, reason, and optional expiry. |
| E-15 | Periodic opportunity review | Documented FAQ: completing Smart/All onboarding adds a weekly review for useful work; editable/cancellable. | Separately opt into a weekly suggestion digest. |
| E-16 | Monitor busy channels | Documented tour: read discussion context to find issues requiring attention. | Monitor received group/topic messages with coverage disclosure. |
| E-17 | Decision and ownership triage | Demonstrated: distinguish pending approval and ownerless investigation from routine noise. | Digest of blockers, owners, age, and links to evidence. |
| E-18 | Reduce notification noise | Demonstrated: propose combining repeated CI failure pings into a summary. | Group related events from approved sources; verify bot-generated event visibility. |

Sources: [tour](https://agent.every.to/learn), [FAQ](https://agent.every.to/install/slack).
The approval promise primarily concerns proposed automations. Do not interpret it as
proof that every individual tool action requires confirmation: the same FAQ describes
automatic reading/joining and an onboarding-created review schedule.

## Concrete work examples

| ID | Example shown | What is evidenced | What remains unverified |
| --- | --- | --- | --- |
| E-19 | Engineering ship recap | Reuse last week's report structure. | Exact repository connector, metrics schema, and release detection. |
| E-20 | Open pull request digest | Scheduled recap delivered to an engineering channel. | GitHub/GitLab coverage, approval rules and filtering UI. |
| E-21 | Sales follow-ups | Chase unresolved follow-ups after demos. | CRM support, whether “chase” drafts or sends, and consent controls. |
| E-22 | Social content pack | Draft social content using a Figma file. | Figma authentication, supported file content and export formats. |
| E-23 | Support themes | Weekly aggregation delivered to the product team. | Ticketing integrations, tagging and deduplication. |
| E-24 | Stalled support triage | Identify unresolved approval or ownership problems. | Accuracy, escalation rules and assignment capabilities. |

Sources: [homepage examples](https://agent.every.to/), [tour](https://agent.every.to/learn),
[FAQ](https://agent.every.to/install/slack). These demonstrate use cases, not a complete
list of shipping connectors or action permissions.

## Onboarding and workspace reach

| ID | Documented behavior | Telegram design implication |
| --- | --- | --- |
| E-25 | Slack installation requires selecting a workspace and approving app permissions; page says marketplace approval is still under review. | Telegram onboarding needs its own bot/chat binding and admin verification. |
| E-26 | Offers a copyable request to the Slack administrator. | Provide an installation link and clear minimal permission instructions. |
| E-27 | Initial introduction arrives privately; no broad announcement unless requested. | Private onboarding after the person starts the bot. |
| E-28 | Initial reading begins after install, using public channels the installer belongs to. Reading can also join a channel. | No direct Bot API equivalent for discovering/joining a user's chats. |
| E-29 | Three reach modes: All public channels, Smart selection, Manual selection. | Start with explicit chat selection; implement monitoring settings within connected chats. |
| E-30 | Smart selection is the default and uses channel names/purposes; sensitive-topic avoidance is model judgment. | Prefer explicit deny rules and selection over inferred access. |
| E-31 | Abandoned setup continues after roughly ten minutes using Smart selection. | Proposed departure: incomplete setup stays inactive. |
| E-32 | Manual selection prevents self-joining and self-scheduling in software. | Default to manual activation and explicit workflow approval. |
| E-33 | All/Smart can join public channels without per-channel prompts; joins remain visible. | Group addition and linking require explicit authorized actions. |
| E-34 | Never self-joins private channels or externally shared channels; uncertain external status prevents joining. | Treat every connected group as a separate audience boundary. |
| E-35 | Teammates receive their own consent prompt before their channels/work are examined. | Personal connector and private-memory consent remains per user. |

Source: [installation FAQ](https://agent.every.to/install/slack). These are Every's
stated onboarding choices, not recommended defaults for our product.

## Authorization, integrations, files and dashboard

| ID | Public capability or boundary | Evidence strength / detail |
| --- | --- | --- |
| E-36 | Bot-only Slack permissions | Documented: no access through a person's Slack account. |
| E-37 | Private conversation membership checks | Documented: checks the requester's membership before accessing another private conversation and refuses on uncertainty. |
| E-38 | Automation actor identity | Documented: personal tasks use the creator's reach; team-owned tasks have narrower private-read authority outside their execution conversation. |
| E-39 | External shared-channel restriction | Documented: participates when invited, but cross-conversation requests about that channel are refused. |
| E-40 | Public-channel retrieval | Documented: requester need not belong to a public channel; private summaries may be returned elsewhere to an authorized requester. |
| E-41 | Private-by-default connections | Documented: owner can share an external app connection with selected people or the whole workspace. |
| E-42 | Delegated connector access | Documented: shared use acts through the connection owner's account. |
| E-43 | Connection usage log | Documented: workspace log records connection, actor and time; not the read/write content. |
| E-44 | Connected Google work | Policy-disclosed: Gmail, Calendar, Drive, Docs and Sheets data; reading, drafting, archiving, storing, deleting and summarizing are named across privacy/terms. |
| E-45 | Broader integration broker | Policy-disclosed: Composio handles long-tail integrations and grants. No complete public connector list was verified. |
| E-46 | Web reading and browser sessions | Policy-disclosed: Cloudflare renders requested public pages; Browserbase supports browsing tasks. No general autonomous browsing guarantee. |
| E-47 | Persistent opened files | Documented: files opened for work persist in a private workspace area across conversations until deletion is requested. |
| E-48 | Management dashboard | Documented sections: connections, automations, standing instructions, skills, generated work and workspace administration. Editing/versioning UI details unknown. |
| E-49 | Independent workspaces | Documented: separate channels, automations and billing; one account may link several workspaces. |
| E-50 | Chat use without an Every account | Documented: ordinary Slack interaction requires no separate Every account. |
| E-51 | No dedicated mobile app | Documented: chat and web dashboard are the surfaces. |

Sources: [FAQ](https://agent.every.to/install/slack), [privacy](https://agent.every.to/legal/privacy-policy),
[terms](https://agent.every.to/legal/terms-of-service). Connector operation categories in
legal text are not proof that each operation is generally available to every account.

## Data lifecycle and support

| ID | Public statement | Product significance |
| --- | --- | --- |
| E-52 | Copies conversation messages and removes that cache after 90 days via daily cleanup. | Establish a specific message-retention class. |
| E-53 | Cache includes shortened text, author identity, location and attachment metadata, not file bytes. | Separate message metadata from acquired file storage. |
| E-54 | Task-associated snippets and opened files are outside that 90-day cache rule. | “90-day retention” is not a blanket deletion promise. |
| E-55 | FAQ says there is no bulk history export or search index. | Distinguish task context from a company-wide knowledge search product. |
| E-56 | No internal dashboard/support tool for browsing workspace messages is described. | Restrict operational access; this does not prove zero infrastructure-level access. |
| E-57 | Policy names Anthropic conversation-state storage and other subprocessors; states no model training on this data. | Provider retention and training terms need independent decisions for our service. |
| E-58 | Removal deletes Slack credentials immediately, stops processing and starts workspace deletion within 14 business days. | Define uninstall, revocation and purge behavior explicitly. |
| E-59 | Workspace/person deletion requests are supported; deleting agent data does not remove Slack originals. | Offer deletion with clear boundaries for Telegram copies. |
| E-60 | Email support for setup, billing and failures; account not required to contact support. | Provide support with run IDs and minimal diagnostic data. |

Sources: [FAQ](https://agent.every.to/install/slack), [privacy](https://agent.every.to/legal/privacy-policy),
[support](https://agent.every.to/support). Privacy text has both broad retention language
and more specific Slack deletion rules; do not collapse them into one universal TTL.

## Pricing: unresolved conflict at the September review

The [October follow-up](#pricing-update) supersedes this historical pricing finding.

| Source | Public statement on research date |
| --- | --- |
| [Pricing page](https://agent.every.to/pricing) | Provider API token rates without markup; beta has no seats, tiers or platform fee. Workspace prepaid balance, manual top-ups, optional threshold-based refill and monthly cap. Admin sees balance, cycle spend and invoices. |
| [Installation FAQ](https://agent.every.to/install/slack) and [tour FAQ](https://agent.every.to/learn) | $15 funded usage per person, capped at $500 per workspace, initially no card. After personal allowance, requires individual Every membership or an admin-assigned team membership described as $30/person/month. Extra member usage draws from the workspace balance at API cost. |

These statements disagree about membership/seat costs. Both describe changeable beta
pricing. Do not combine them into an asserted price, use them for our margin forecast,
or assume the standalone pricing page supersedes the FAQ without vendor confirmation.
Our initial beta should expose usage and enforce budgets; commercial terms remain open.

## Important unknowns

1. Which connector operations are live, their OAuth scopes, and their plan eligibility.
2. Exact model/version selection, fallback behavior, context window and execution limits.
3. Memory storage, retrieval scope, conflict resolution and correction rollback.
4. Supported skill format, tool sandbox, skill review and publishing process.
5. Automation language, timezones, retries, missed runs, dependency chains and versioning.
6. How approval, scheduling and onboarding-created tasks interact in every case.
7. Dashboard roles, SSO, exports, API access, audit retention and access reviews.
8. File formats, quotas, malware handling, output artifacts and sharing controls.
9. Availability guarantees, scale limits, run cancellation and incident recovery.
10. Actual pricing and trial/membership treatment of multi-workspace users.

These are design questions for us, not negative findings about Every.

## Launch follow-up (2026-10-07)

Scope: the current [product page](https://every.to/agent), the
[October 6 launch announcement](https://every.to/on-every/introducing-the-every-agent),
and refreshed [pricing](https://agent.every.to/pricing) and
[installation FAQ](https://agent.every.to/install/slack). See source records E9–E12.
No account, Slack installation or authenticated product test was performed.
These are newly verified or newly emphasized claims; we cannot establish that
every capability was introduced on launch day.

### Current public evidence

| Finding | Evidence strength | Source |
| --- | --- | --- |
| Public launch on October 6; a shared company agent in Slack | Documented | [Announcement](https://every.to/on-every/introducing-the-every-agent) |
| Built-in skills; successful workflows can become team skills; corrections can persist | Documented | [Announcement](https://every.to/on-every/introducing-the-every-agent) |
| Frontier Alerts recommend developments relevant to current tools/workflows | Documented; relevance and frequency untested | [Announcement](https://every.to/on-every/introducing-the-every-agent) |
| Named business integrations and a claim of over 1,000 tools | Documented claim; operation-level availability unknown | [Announcement](https://every.to/on-every/introducing-the-every-agent) |
| Claude Managed Agents powers the shared agent | Documented; internal architecture unknown | [Announcement](https://every.to/on-every/introducing-the-every-agent) |
| Coding and PR creation for review; merged-PR reports; feedback saved to workflows | Coding documented, report and feedback examples demonstrated | [Product page](https://every.to/agent) |
| Temporary access requests and approval controls in task results | Demonstrated; exact grant lifecycle unknown | [Product page](https://every.to/agent) |
| Connections shared with selected teammates; opened files retained across conversations | Documented | [Installation FAQ](https://agent.every.to/install/slack) |

The change in emphasis is toward making one person's useful process reusable by
colleagues. That is our interpretation of the launch materials, not a claim that
the earlier product lacked team reuse. The September inventory already recorded
scheduling, corrections, shared learning, approvals and connector sharing.

### RepoDesk already has much of the foundation

The comparison uses the current working tree and
[implementation evidence](../implementation/implementation-status.md), including
October 5–6 entries. Some older design/roadmap passages still describe continuous
coding as planned; the newer implementation evidence takes precedence for this
research. Local implementation does not establish live pilot acceptance.

| Capability | Current RepoDesk evidence | Actual remaining opportunity |
| --- | --- | --- |
| Recurring work | Approved daily/weekly schedules, timezone handling, unique occurrences and lifecycle controls in [workflow services](../../src/workflows/service.ts) | Add useful repository inputs and templates; weekdays-only recurrence would need an extension beyond the current schema |
| Corrections and memory | Approved personal/workspace/workflow instructions; retained discussion summaries, decisions and todos | Connect feedback to skill drafts and evaluation examples; avoid describing basic memory as a missing feature |
| Skills | Admin create/import, publish, enable and rollback; `load_skill` in [agent tools](../../src/agent/tools.ts) | Conversational extraction and discovery; built-in tools currently offer instruction proposals, not skill-creation proposals |
| Coding collaboration | Durable tasks, product questions, bounded repair and same-task/PR continuation | Better handoff summaries and reusable engineering procedures |
| Task feedback | Readable progress, scoped status/cancellation and rich Telegram replies | Consistent outcome summaries linking changes, checks, remaining decisions and PRs |
| GitHub | App connection, verified user access, Code Truth, issue submission and coding tasks | General read-only issue/PR metadata and digests remain proposed |
| Media | Guarded images, text/code and selectable PDF input in [attachment support](../implementation/telegram-attachments.md) | Durable generated artifacts and selected documentation connectors |

The current skill Test action is a deterministic policy preview, as
[the catalog implementation](../../src/skills/catalog.ts) and
[skills design](../design/agent-skills.md) explain. It does not evaluate whether a
model follows the skill or produces a useful answer. A future quality evaluation
must be a separate, budgeted capability.

### Recommended additions

At the research date these were **our proposals**. The user subsequently authorized
R01–R03 on 2026-10-07; see their [local implementation plan](../implementation/team-workflows-plan.md).
Other items remain proposals. Order reflects
fit with the [GitHub product journey](../design/github-workflows.md), reuse of
existing infrastructure and likely reviewability. Effort is relative, not a date
commitment.

| ID | Priority / effort | Proposed addition | Useful Telegram request | Increment beyond current behavior |
| --- | --- | --- | --- | --- |
| R01 | Next / medium | GitHub status and repository digest | “Every morning, summarize yesterday's merged PRs and outstanding reviews in this topic.” | Authorized issue/PR metadata tools, freshness, paging and cited links, composed with existing schedules |
| R02 | Next / medium | Save a successful conversation as a skill | “Save this bug-triage process so the team can use it.” | Draft extraction with inputs, output conventions, examples, source references and requested tools; explicit publication by an authorized admin |
| R03 | Next / small–medium | Work handoff and unfinished-task brief | “Where did we leave off, and what needs my answer or review?” | Aggregate accessible durable tasks and retained discussion records into next actions across the user's permitted conversations |
| R04 | With R01/R02 / small–medium | Curated engineering skills | “Use our release-note format for this week's changes.” | Ready-to-use release notes, issue triage, source explanations and coding handoffs; tools still need independent grants |
| R05 | After R01 / medium | Proactive blocker and review follow-up | “Tell me when a PR has waited for review for two days.” | Opt-in observation, thresholds, suppression and quiet hours; extend [F07](../design/product-requirements.md#f07--observation-suggestions-and-blocker-triage-p1) |
| R06 | Later / medium–large | One documentation connector | “Use this approved specification to prepare the implementation task.” | Start with either Notion or Google Drive based on pilot demand; read-only selection, per-user access and provenance |
| R07 | Later / medium | Generated engineering artifacts | “Give me the implementation plan and test report as downloadable files.” | Tenant-scoped artifacts, source references, expiry and authorized downloads; current attachment input is not an output library |
| R08 | Later / medium | Workflow-relevant frontier alerts | “Which new model or tool is worth testing for our current tasks?” | Official release feeds, relevance to declared tools/skills, restrained cadence and links to evidence; no automatic model/configuration changes |

R01 is the clearest missing repository capability. R02 makes the existing skills
system easier to use. R03 can provide value from application records before new
connectors are available. R04 packages the first three into workflows people can
discover and repeat. Do not count separate templates as separate platform features.

### Concrete scope for the first additions

**R01 — begin with reads, then compose the report.** Support questions about open
PRs, merged PRs in a time window, pending review and issue status. Return repository,
item URL, retrieval time and coverage. Keep metadata facts separate from inferred
user impact; explaining a change may need additional authorized source/diff context.
Scheduling currently fixes source/destination to the execution chat/topic, so adding
repository inputs needs an explicit workflow scope contract. For a group digest,
authorize the audience as well as the task owner. Grant loss blocks future reads
and delivery. Partial paging or provider failure must appear as incomplete coverage,
not “no changes.” Unique occurrence and delivery controls must survive restarts.

**R02 — create a draft from a chosen successful run.** Extract a named procedure
and a sanitized example, show the scope and difference from an existing version,
then use the catalog's publication controls. Ordinary members can propose; admins
publish shared skills. Preserve original source references and exclude private
conversation content from shared examples unless sharing is authorized. A saved
skill never inherits the original user's credentials, repository grants or coding
authority. Keep an existing workflow's pinned version until an explicit upgrade.
Start with instruction skills and registered tools, not executable bundle generation.
Approved corrections can later propose a new draft plus a regression example;
evaluate usefulness separately from the existing policy preview.

**R03 — summarize state, not guessed agent internals.** Show the original goal,
last confirmed checkpoint, waiting question, next action, verification status and
PR link when present. Use app-managed task records and authorized discussion
summaries; do not scan developers' personal Codex/Claude directories. Existing
records can support a manual brief first, followed by an optional personal schedule.
Cross-topic aggregation needs an explicit read policy; group briefs must not include
private tasks. Every's session-log testimonial is a customer anecdote, not proof of
a general session-sync integration.

For acceptance, evaluate factual/source accuracy and digest usefulness for R01,
whether a colleague successfully reuses a skill for R02, and whether R03 identifies
the right next action. Include denied audiences, revoked access, duplicate events
and scheduling failures when these proposals become implementation work.

### Other ideas and tradeoffs

- Resource-specific access requests could improve denial handling later. RepoDesk
  already has workspace enrollment requests; the addition would be a repository/tool
  request with scope, expiry and an auditable decision. An app-level grant cannot
  bypass the person's GitHub permissions. This is separate from R01–R08.
- A consistent result summary can accompany R03/R04: what changed, evidence/checks,
  remaining questions and the artifact/PR link. Existing rich replies and progress
  controls provide the delivery foundation.
- Broad CRM, finance, hiring and purchasing integrations have weak fit with the
  current repository-focused pilot. Select the first documentation connector from
  actual demand instead of pursuing the advertised integration count.
- Automatic merging, deployment, external outreach and auto-installing tools would
  expand current authorization contracts. They are not implied by a shared skill or
  a competitor demonstration.
- Keep Pi plus the existing application services and Codex runner for these proposals.
  The competitor's runtime choice alone supplies no reason to migrate ours.
- Slack channel discovery/history behavior does not transfer to Telegram. Work from
  connected chats and delivered, retained messages; disclose missing coverage.

Recommended sequence: establish the live GitHub pilot; add R01 and a release-note
template; add R02 and correction-derived skill drafts; add R03; then evaluate R05
and one R06 connector. R03's app-record-only prototype can proceed independently
of the metadata tool. R07/R08 should follow evidence of repeated use.

### Pricing update

The current [product pricing section](https://every.to/agent#pricing) gives
$30/user/month or $24/user/month billed annually, plus provider token costs without
markup. The [pricing page](https://agent.every.to/pricing) now includes membership,
initial credits and workspace balance/refill rules. The September membership-versus-
usage-only conflict is therefore no longer the current finding.

This is a product-pricing observation, not a proposal for RepoDesk billing or a
vendor quote. We have not tested purchase flows or measured all-in cost.
