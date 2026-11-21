# Mingle and Orbital feature research

Research date: **2026-11-20**. Status: **research and proposed feature recommendations**,
not implemented Telo behavior or committed roadmap scope. Check
[implementation evidence](../implementation/implementation-status.md) for verified
Telo capabilities.

## Scope and evidence boundaries

This note reviews two public projects against Telo's current architecture and
product boundaries:

- **Mingle** — [github.com/earayu/Mingle](https://github.com/earayu/Mingle) and
  [mingle.build](https://mingle.build/)
- **Orbital** — [github.com/zqiren/Orbital](https://github.com/zqiren/Orbital) and
  [orbital.top](https://orbital.top/)

Findings about Mingle and Orbital are **Documented** from public GitHub pages and
product documentation retrieved via web search on **2026-11-20**. Neither project
was installed, executed, or audited at source-code depth; runtime reliability,
security posture, and connector completeness are unverified. Feature ideas for
Telo below are **Proposed**.

## Positioning comparison

| Project | Documented positioning | Core design center | Key contrast with Telo |
| --- | --- | --- | --- |
| **Mingle** | Local-first, zero-server companion that bridges existing subscribed coding harnesses (Claude Code, Codex, Cursor, OpenCode, Kimi Code, Qwen Code, DeepSeek) into everyday chat apps (WeChat, WeCom, Feishu, DingTalk, QQ, Slack, Discord, Telegram, iMessage) and GitHub `@`-mentions. | Personal local runtime, multi-harness reuse, multi-channel presence, unified personal memory. | Built for a single local user without a central multi-tenant server, workspace roles, or strict per-scope isolation. |
| **Orbital** | Local-first project control plane (*"Context is yours. Agents are replaceable."*), binding durable state, task queues, skills, memory files, budgets, and approvals to a project folder while delegating execution to interchangeable workers (Claude Code, Codex, Gemini CLI). | Project-bound control plane, interchangeable workers, structured file memory, task queue, unified Workbench inbox. | Built around local workspace directories, OS keychain credentials, and file-system watchers rather than a multi-member self-hosted server with tenant/actor authorization. |
| **Telo** | Self-hosted, multi-member Telegram assistant for GitHub organizations and personal repositories, backed by Pi, PostgreSQL, durable Codex tasks, Code Truth, Review Bot, scoped memory, and an authenticated web admin panel. | Multi-tenant server, strict actor/repository/destination authorization, durable execution and publication boundaries. | Already separates application control from Codex sessions, but currently binds coding execution to Codex CLI and lacks a cross-repo Workbench inbox, repo task queue, and automatic post-task engineering capture. |

## High-priority features to adapt for Telo

These proposals align closely with Telo's existing durable task, memory, and
authorization architecture.

### 1. Interchangeable coding workers and multi-harness failover (Orbital + Mingle)

- **Documented upstream pattern:**
  - Mingle abstracts multiple subscribed coding harnesses (Claude Code, Codex, Cursor,
    OpenCode, Kimi Code, Qwen Code, etc.) through an adapter layer (OAR) and surfaces
    remaining harness quotas in its console.
  - Orbital decouples project state from worker sessions so that if one worker (e.g.,
    Codex) hits a usage limit or stalls, another worker (e.g., Claude Code or Gemini CLI)
    can continue the same task from compiled project context.
- **Telo baseline:** [Continuous Codex collaboration](../design/codex-collaboration.md)
  already stores task identity, grants, input revisions, verification plans, and
  publication state in application services, while execution is currently bound to
  Codex CLI (`app-server`).
- **Proposed Telo adaptation:**
  - Introduce a pluggable **Coding Worker Adapter** interface behind the existing
    durable task engine, starting with **Claude Code** alongside **Codex**.
  - Reuse the existing credential-free verification plan, patch-integrity checks,
    and publication reservation rules across all workers.
  - Allow per-repository default worker selection and explicit maintainer failover to
    an alternate worker when an account hits rate/quota limits.
  - Surface worker authentication health and remaining quota visibility in the Admin
    Panel.

### 2. Per-repository sequential task queue with pause-to-steer and artifact carryover (Orbital)

- **Documented upstream pattern:** Orbital maintains a persistent per-project task
  queue (`queue.json`) supporting sequential execution, pinning urgent items to the
  front, pausing mid-item to chat and steer the agent, and carrying completed task
  artifacts forward to subsequent queued items.
- **Telo baseline:** Telo supports follow-up inputs on an active task/PR,
  but separate coding goals are launched individually without a repository-level
  ordered queue.
- **Proposed Telo adaptation:**
  - Add a **per-repository task queue** manageable from Telegram and the Admin Panel
    (enqueue, pin/reorder, pause queue, resume, cancel).
  - Pass verified summaries and branch/PR references from completed queue items as
    explicit read-only context to the next queued item, while preserving per-item
    actor authorization and current permission rechecks before each item starts.

### 3. Unified cross-repository Workbench / Action Inbox (Orbital)

- **Documented upstream pattern:** Orbital's **Workbench** provides a single
  cross-project feed of active tasks, finished replies, pending agent questions,
  and approval cards—plus a single quick-dispatch input box and mobile remote
  supervision with inline guidance on approval/rejection.
- **Telo baseline:** The Admin Panel focuses on configuration, logs, and audits,
  while the [Telegram task history Mini App](../implementation/telegram-mini-app.md)
  is currently read-only.
- **Proposed Telo adaptation:**
  - Add a permission-scoped **Workbench / Action Inbox** view in the Web Panel
    (and optionally evolve the Telegram Mini App) aggregating the current member's
    active tasks, pending Codex product questions, pending write approvals (issues,
    PRs, releases, Cloudflare changes), and ready-for-review PRs across connected
    repositories.
  - Support answering questions or approving/rejecting with an optional short
    steering note directly from the card, subject to the same server-side actor and
    revision checks as Telegram callbacks.

### 4. Post-task Process Capture and Learning Capture (Orbital)

- **Documented upstream pattern:** Orbital captures repeatable multi-step workflows
  as reusable skills (**Process Capture**, stored in `orbital/skills/`) and records
  project state, architectural rationale, and execution lessons in structured files
  (`PROJECT_STATE.md`, `DECISIONS.md`, `LESSONS.md`, plus per-worker memory files)
  compiled into fresh worker briefings on cold start (**Learning Capture**).
- **Telo baseline:** Telo implements
  [long-term conversation memory](../design/long-term-memory.md), source-grounded
  decision/preference memory, web-managed skills, and [Obsidian notes](../implementation/obsidian.md),
  but does not automatically distill build/test quirks or multi-step repair runs
  from completed Codex tasks into repository engineering memory or skill drafts.
- **Proposed Telo adaptation:**
  - **Learning Capture:** After a coding, investigation, or release task succeeds
    (especially after a verification failure and repair), propose candidate
    **repository lessons** (build/test quirks, environment prerequisites, module
    constraints) and **architectural decisions** for maintainer review. Approved
    entries compile into a bounded per-repository cold-start briefing for future
    coding tasks and Review Bot runs, with optional sync to the managed Obsidian
    vault.
  - **Process Capture:** Offer a one-step "Save as skill draft" flow from completed
    multi-step investigations, reports, or release preparations into the existing
    versioned [agent skills](../design/agent-skills.md) review workflow.

### 5. Per-repository autonomy presets and structured approval cards (Orbital)

- **Documented upstream pattern:** Orbital exposes clear autonomy presets
  (`Supervised`, `Check-in`, `Hands-off`) paired with tool/action interceptors that
  render structured approval cards displaying the exact tool name, arguments, and
  triggering context.
- **Telo baseline:** Governance and approval rules are strictly enforced in
  application services, but policy knobs are spread across separate plugin and
  workflow screens.
- **Proposed Telo adaptation:**
  - Provide intuitive per-repository **governance presets** (for example:
    `Supervised` for production repositories requiring confirmation before PR/issue
    writes, `Check-in` allowing autonomous PR creation while gating releases and
    external infrastructure edits) that map deterministically onto Telo's
    existing server-side policy checks without weakening authorization boundaries.

## Medium-priority extensions and ecosystem ideas

### 6. Local terminal to Telegram context handoff (Mingle)

- **Documented upstream pattern:** Mingle's Handoff panel packages ongoing local
  CLI session context (progress, preferences, decisions) into a handoff prompt so
  the chat agent can take over seamlessly.
- **Proposed Telo adaptation:** Provide an authenticated CLI or one-time
  handoff token flow that lets a verified workspace member transfer an active local
  branch goal, open questions, and confirmed decisions into a Telo private
  Topic or coding task (still bounded by the member's current GitHub write access
  and repository selection).

### 7. Native GitHub Issue `@`-mention triage and task kickoff (Mingle)

- **Documented upstream pattern:** Mingle bots respond to `@`-mentions directly
  inside both GitHub issues and pull requests.
- **Telo baseline:** [Review Bot](../implementation/review-bot.md) handles
  automatic PR reviews and explicitly addressed PR comments/fixes, but not
  general issue-comment `@`-mentions.
- **Proposed Telo adaptation:** Extend the existing verified-GitHub-identity
  webhook pipeline to handle `@bot` mentions in GitHub Issues for Code Truth
  investigation, reproduction analysis, and—for verified maintainers with write
  access—starting a linked coding task that reports back with a PR.

### 8. Budget-cap auto-pause and reset-cycle auto-resume (Orbital)

- **Documented upstream pattern:** Orbital allows per-project spending caps with
  configurable threshold behavior—either pausing execution and automatically
  resuming when the budget cycle resets, or hard-stopping—alongside model-level
  cost breakdowns.
- **Telo baseline:** Telo enforces per-run and workspace dollar budgets
  ([product requirements](../design/product-requirements.md#f11--usage-cost-controls-and-billing-p0-metering-p2-payments)),
  blocking new runs when exhausted.
- **Proposed Telo adaptation:** Add a configurable **pause-until-reset** mode
  for queued tasks and recurring workflows, with owner notification on pause and
  automatic resumption (after rechecking permissions) at the next daily/monthly
  budget window, plus per-repository and per-worker cost breakdowns.

### 9. Declarative GitHub event triggers unified with schedules (Orbital)

- **Documented upstream pattern:** Orbital surfaces time-based schedules and
  event-based triggers (file watchers) together in an Automations section beside
  the task queue.
- **Telo baseline:** Telo has cron-based workflows and GitHub webhook
  ingestion for notifications and Review Bot, but no general user-defined
  event-triggered workflow rules.
- **Proposed Telo adaptation:** Add declarative **GitHub event triggers**
  (e.g., CI failure on default branch -> read-only root-cause investigation;
  changes under `docs/` -> doc-drift check; specific issue label -> triage summary)
  managed alongside cron workflows under the same ownership, version pinning,
  pause/resume, and isolated-execution rules.

### 10. Unified team address book and future multi-channel adapters (Mingle)

- **Documented upstream pattern:** Mingle maintains a cross-platform address book
  linking a person's identities across chat apps, and exposes one agent across
  Slack, Discord, Feishu, WeCom, WeChat, Telegram, and iMessage.
- **Proposed Telo adaptation:**
  - Near term: enrich the Workspace Members view into a clearer **member identity
    directory** linking Telegram, verified GitHub, and Google identities with owned
    repositories/workflows for group handoffs and attribution.
  - Longer term (only if Telo expands beyond Telegram): abstract the Telegram
    ingress/delivery layer into a pluggable **Channel Adapter** interface (Slack,
    Discord, Feishu) while keeping Telo's multi-tenant PostgreSQL state and
    authorization services unchanged.

### 11. Remote POSIX SSH runner option (Mingle)

- **Documented upstream pattern:** Mingle can bootstrap a portable runtime on a
  remote POSIX host over the system SSH client / `ssh-agent` without requiring
  root privileges or storing raw SSH keys in app config.
- **Telo baseline:** Telo supports Docker, OpenSandbox, and Native VPS
  Codex runners.
- **Proposed Telo adaptation:** Low-priority optional runner target for teams
  with a dedicated remote build or GPU host, subject to the same process-group
  tracking, isolation caveats, and clean-environment rules as Native VPS.

## Patterns intentionally excluded (boundary conflicts)

1. **Unscoped cross-platform / cross-group global memory (Mingle):** Sharing
   context freely from a work group into a separate chat or platform violates
   Telo's tenant isolation, private-vs-group visibility separation, and
   per-repository read-grant enforcement.
2. **Direct host directory and OS keychain access (Orbital):** Telo is a
   shared self-hosted server; encrypted server-side credential storage,
   per-actor authorization, container isolation, and durable publication
   reservations must remain mandatory rather than delegating trust to local host
   state.

## Sources reviewed (2026-11-20)

- [Mingle GitHub repository](https://github.com/earayu/Mingle): README overview,
  supported harnesses (OAR), supported chat channels, GitHub `@`-mentions, remote
  POSIX SSH runner notes, and desktop/CLI distribution.
- [Mingle website](https://mingle.build/): unified memory, address book, Handoff
  mechanism, reminders/tasks, and local keystore claims.
- [Orbital GitHub repository](https://github.com/zqiren/Orbital): project-bound
  control plane architecture, interchangeable workers, file-based project/worker
  memory (`PROJECT_STATE.md`, `DECISIONS.md`, `LESSONS.md`), `queue.json`,
  triggers, and local/cloud relay supervision.
- [Orbital website](https://orbital.top/): Workbench feed, Process Capture,
  Learning Capture, autonomy presets, approval cards, and budget threshold
  pause/reset behavior.
