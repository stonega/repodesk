# Agent Orchestration, Autonomy, and Automations

RepoDesk can coordinate multi-step work across read-only tools, isolated research
subagents, durable background missions, per-repository task queues, and proactive
time or event automations—while preserving workspace isolation and mandatory human
approval for high-impact actions.

## Parallel reads and research subagents

- Independent read-only queries (GitHub metadata and diffs, Code Truth, web search
  and page reads, Obsidian notes, Google Workspace, Search Console, Cloudflare
  reads, and memory/history queries) execute concurrently up to a bounded limit.
- Complex cross-repository or multi-source questions can delegate 1 to 3 bounded,
  read-only research subagents in isolated contexts so the main conversation stays
  concise. Subagents inherit your exact permissions, cannot write or dispatch code
  changes, and count toward your run and workspace budgets.

## Background missions and automatic continuation

- For multi-step goals (for example: gather evidence, run a coding task, record
  notes, and verify CI), RepoDesk tracks progress in a durable background **Mission**
  and resumes automatically when awaited coding tasks, approvals, timers, or GitHub
  events complete.
- Routine intermediate steps stay quiet in Telegram so you receive the final
  synthesized outcome, or an explicit prompt only when human input or approval is
  needed.
- Within an active mission, RepoDesk can schedule up to 3 bounded one-shot delayed
  follow-up checks (1 minute to 72 hours) automatically without extra confirmation.
- Inspect active missions, pending waits, verified artifacts, and cancel actions
  anytime from **Missions** in the Admin Panel or by asking in chat.

## Autonomy presets (`Supervised` vs `Check-in`)

Workspace owners and admins configure autonomy from **Missions → Autonomy policy**:

- **Supervised (default):** Read-only operations and bounded research run
  automatically; external writes require explicit human approval.
- **Check-in:** Routine non-destructive writes authorized for your account (such as
  GitHub issues, PR creation from verified patches, Obsidian notes, and
  non-destructive Cloudflare changes) run automatically with full audit entries.
- **Per-repository overrides:** Each connected GitHub repository can inherit the
  workspace default or override it to `Supervised` or `Check-in`.
- **Immutable L3 approval gates:** Merging or closing PRs, publishing GitHub
  Releases or tags, deleting resources, and modifying permissions or autonomy
  policies **always** require explicit human approval in every mode.

## Upgraded automations and silent Watchers

Automations under **Workflows** (and natural-language scheduling in Telegram) now
support:

- **One-shot (`once`):** Run once at a specified ISO timestamp and mark completed.
- **Flexible recurrence:** `daily`, `weekly`, `weekdays` (Mon–Fri), `monthly`
  (day 1–28 or `last`), and `interval` (15–1440 minutes, with optional quiet hours).
- **Silent Watcher mode (`on_condition`):** Check conditions quietly and skip
  Telegram delivery when everything is healthy, alerting only when a condition
  matches (with per-alert deduplication cooldown).
- **Event triggers:** Trigger workflows from verified GitHub webhooks
  (`check_suite_failed`, `issue_opened`, `issue_labeled`, `pull_request_opened`,
  `pull_request_ready`) or installed plugin events with semantic deduplication and
  cooldowns.

## Per-repository task queues

From **Missions → Repository task queues**, admins can inspect active and queued
tasks per repository, **Pause** or **Resume** a queue, **Pin** an urgent queued
item to the front, or **Cancel** an item. When a queued item is promoted, verified
branch/PR summaries from the preceding completed item in the same visibility scope
can carry over automatically as read-only context.
