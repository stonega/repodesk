# Every Agent: detailed public feature inventory

Reviewed **2026-09-18**. See the [source register](../reference/sources.md) for methods
and limitations. “Documented” means publicly claimed, not tested by us. Telegram
equivalents below are proposed, not features of Every or this scaffold.

## Product model

Every Agent is a beta AI coworker embedded in Slack. Its target champion is someone
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

## Pricing: unresolved conflict

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
