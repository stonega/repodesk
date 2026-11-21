# Agent Orchestration Implementation Plan

Status: **Implemented locally (Phases 1–4, 2026-11-20)**. Delivery plan and ledger for
[Agent Orchestration, Autonomy, and Proactive Scheduling](../design/agent-orchestration.md).
Check [implementation evidence](implementation-status.md) for verified checks and
remaining live acceptance gates.

## Engineering constraints (apply to all phases)

- Maintain TypeScript strict mode, Biome formatting/linting, and existing standalone
  architecture (`src/`, `web/`, `migrations/`, `tests/`).
- No new runtime dependencies unless strictly justified and documented.
- Register all new built-in orchestration tools in
  `scripts/fixtures/plugin-startup.ts`; `bun run test:runtime` and offline container
  `dist/runtime-contract.js` must pass with **zero external startup calls**.
- Every phase must pass `bun run check`, `bun run typecheck`, `bun test`,
  `bun run build`, and `bun run test:runtime` (plus Playwright browser tests for
  phases touching `web/`).
- Update `docs/implementation/implementation-status.md`, `docs/user/`, and
  `examples/` as each phase lands.

---

## Phase 1: Execution Core — Read Concurrency, Research Subagent, and Prompt Routing

**Goal:** Faster evidence gathering, clean context isolation for deep research, and
sharper tool selection without changing database schema or existing approval flows.

### Backend changes

1. **Tool execution metadata & parallel read barrier (`src/agent/runtime.ts`, `src/agent/tools.ts`, plugin extensions):**
   - Extend tool definitions with `concurrency?: "parallel" | "sequential"` and
     `readOnly?: boolean`, `subagentSafe?: boolean`.
   - Implement bounded parallel batching in `PiRunner` (concurrency cap `4`) for
     contiguous `parallel` read-only tool calls while enforcing sequential barriers
     for any `sequential` tool, preserving deterministic checkpoint ordering, abort
     propagation, fence checks, and extension hooks.
   - Annotate built-in read-only tools across `src/agent/tools.ts`, `src/github/`,
     `src/code-truth/`, `src/obsidian/`, `src/web-reader/`, `src/search/`,
     `src/cloudflare/`, `src/google/`, `src/search-console/`, and `src/nowledge-mem/`.
2. **Controlled read-only Research Subagent (`src/agent/subagent.ts`, `src/agent/tools.ts`, `src/jobs/execute.ts`):**
   - Implement `delegate_research` supporting 1–3 concurrent bounded sub-tasks per call.
   - Enforce depth = 1, read-only `subagentSafe` tool allowlist, inherited tenant/actor/
     chat/topic/group-repository scope, per-subagent turn/tool caps (`6` turns, `12`
     tools), shared parent USD budget reservation/settlement, and structured provenance
     output tagged as untrusted reference data.
   - Persist subagent execution summaries and token/cost accounting on the parent run.
3. **Prompt & routing refactor (`src/agent/context.ts`, `src/agent/routing-prompt.ts`):**
   - Extract layered system prompt assembly: thin core orchestrator rubric + security
     policy + enabled-capability summary, while keeping domain-heavy guidance scoped
     to relevant tool descriptions / pinned skills.
   - Ensure prompt confidentiality rules remain prepended first across interactive,
     workflow, and subagent runs.
4. **Startup contract fixture (`scripts/fixtures/plugin-startup.ts`):**
   - Cover `delegate_research` registration and zero external startup calls across
     ordinary and configured workspaces.

### Verification gates (Phase 1)

- Unit & integration tests (`tests/unit/parallel-tools.test.ts`,
  `tests/unit/research-subagent.test.ts`, `tests/integration/orchestration-core.test.ts`):
  - Contiguous read-only calls run concurrently and checkpoint in deterministic order;
    a write/dispatch tool acts as a strict sequential barrier.
  - Subagent cannot spawn nested subagents, cannot invoke write/delivery/coding tools,
    cannot cross private-vs-group or tenant boundaries, and settles cost into parent
    run/workspace budgets.
  - Cancellation (`AbortSignal`) and fence revocation abort in-flight parallel reads
    and subagents immediately.
  - Existing prompt confidentiality and context tests continue passing.

---

## Phase 2: Durable Mission Engine, Event-Driven Continuation, and Autonomy Policy

**Goal:** Enable invisible multi-step orchestration across Pi, Codex, Browser,
approvals, and bounded autonomous delayed checks, governed by server-enforced
`Supervised` vs `Check-in` autonomy presets.

### Database migration (`migrations/027_agent_orchestration.sql`)

- Create `workspace_missions` (tenant-scoped, indexed by `(workspace_id, status)`,
  `(workspace_id, chat_id, topic_id, status)`, `(workspace_id, actor)`).
- Create `workspace_mission_waits` (tenant-scoped, indexed by `(workspace_id, mission_id)`,
  `(workspace_id, kind, target_id)` where `status = 'pending'`, and `(due_at)` where
  `kind = 'timer' AND status = 'pending'`).
- Add `mission_id` and `trigger_kind` columns/fields on `workspace_runs` (or JSONB
  metadata + indexed `mission_id` column).
- Store workspace default autonomy (`autonomy.defaultMode`, `autonomy.revision`,
  `autonomy.repositoryOverrides`) in workspace configuration aggregate with optimistic
  revision tracking.

### Backend changes

1. **Autonomy Policy Engine (`src/autonomy/policy.ts`, `src/autonomy/types.ts`):**
   - Deterministic `ActionClass` registry (`L0`, `L1_L2`, `L3`) and `evaluateAutonomy(w, actor, action, repositoryId?)`.
   - Immutable L3 gate enforcement (Merge PR, Close PR, Release/Tag publication,
     deletions, permission/autonomy changes) that can never be bypassed.
   - Wire `Check-in` automatic execution (with audit + actor/GitHub write permission
     checks) into:
     - Codex PR publication (`src/coding/tasks.ts` / `publication.ts`),
     - GitHub issue create/comment (`src/github/issues.ts` / `extension.ts`),
     - Obsidian writes inside mission continuations (`src/obsidian/service.ts`),
     - Non-destructive Cloudflare actions (`src/cloudflare/service.ts`).
   - Preserve `Supervised` as default for all existing workspaces.
2. **Mission & Continuation Engine (`src/orchestration/missions.ts`, `src/orchestration/store.ts`, `src/orchestration/wakeup.ts`, `src/orchestration/tools.ts`):**
   - Tools exposed to Pi:
     - `manage_mission` (create/update/attach/complete/cancel background mission + scratchpad artifacts),
     - `schedule_mission_followup` (bounded autonomous one-shot timer wait, 1m–72h, max 3 per mission, no extra user confirmation required),
     - `inspect_missions` (read-only status query for on-demand progress checks).
   - Remove the unconditional `codingTaskId` reply truncation in `src/jobs/execute.ts`:
     allow Pi to emit a concise natural receipt when dispatching a mission-linked task
     and suppress noisy routine child progress messages when the mission owns synthesis.
   - Hook completion/resolution wakeup triggers into:
     - `src/coding/tasks.ts` (task completed / review / failed / waiting),
     - `src/workflows/service.ts` (`decide` approval resolution),
     - `src/browser/pause.ts` (browser pause resumed),
     - `src/jobs/queue.ts` (worker timer sweep for due `workspace_mission_waits` + stale wait recovery),
     - `src/github/webhooks.ts` (matching `check_suite` / PR status event for watched PRs).
   - Enforce re-authorization on every wakeup (active member, bot ID, group repo binding,
     current autonomy policy downgrade check, fence, max wakeups = 8, USD budgets).
3. **Admin API & UI (`src/admin/routes/orchestration.ts`, `web/pages/missions.tsx`, Workspace Settings & GitHub Repo cards):**
   - Endpoints for autonomy presets (`GET/PATCH /autonomy`, repo override) and
     missions (`GET /missions`, `GET /missions/:id`, `POST /missions/:id/cancel`).
   - Admin Panel UI strictly following `docs/design/ui-rules.md`:
     - Saved read-only summary + Edit modal for Workspace Default Autonomy and
       per-repository autonomy override.
     - Missions list & detail view with status pills, waiting conditions, spent USD,
       and Cancel confirmation modal.

### Verification gates (Phase 2)

- Unit & PostgreSQL integration tests:
  - End-to-end multi-step mission: Pi reads → dispatches Codex → Codex finishes →
    auto-wakeup → `Check-in` auto-writes Obsidian / Draft PR → schedules delayed check
    → timer fires → final synthesized reply delivered once.
  - `Supervised` approval pause & resume: L1/L2 pauses for approval → user approves →
    mission automatically wakes and finishes remaining steps.
  - L3 hard gate test: even under `Check-in`, Merge PR / Release / Delete / Autonomy
    change ALWAYS requires approval and fails closed if bypassed.
  - Policy downgrade mid-mission, actor revocation, duplicate webhook/timer events,
    worker crash/restart recovery, wakeup-limit circuit breaker, and private-vs-group
    isolation.
- Playwright browser tests (`tests/e2e/autonomy-missions.e2e.ts`):
  - Desktop `1280px` & mobile `390px`, light & dark themes: saved summary vs modal
    editor, pending lock, error draft retention, focus return, mission detail & cancel.

---

## Phase 3: Proactive Scheduling — One-Shot, Flexible Recurrence, Watchers, and Event Triggers

**Goal:** Upgrade `workflows` into a complete proactive Automation engine supporting
one-shot reminders, flexible schedules, silent-if-OK Watchers, and GitHub/plugin event
triggers.

### Database migration (`migrations/028_automations_triggers.sql`)

- Create `workspace_automation_events` (dedupe & cooldown ledger for event triggers
  and Watcher `dedupeKey` alerts, 30-day retention sweep).
- Extend `WorkflowSpec` schema (`src/domain.ts`) with backward-compatible defaults:
  - `trigger`:
    - `kind: "schedule"` (supports `once`, `daily`, `weekly`, `weekdays`, `monthly`,
      `interval`), or
    - `kind: "github_event"` (repositoryIds, event type, optional branch/label filter,
      cooldownMinutes), or
    - `kind: "plugin_event"` (plugin generation/id, event names, cooldownMinutes).
  - `deliveryMode`: `"always"` (default) | `"on_condition"`.
  - `watcherAction`: `"notify_only"` (default) | `"investigate_readonly"`.
- Maintain full read/write compatibility with legacy `recurrence: { frequency: "daily" | "weekly" }`
  records.

### Backend changes

1. **Schedule computation (`src/workflows/schedule.ts`):**
   - Implement `once`, `weekdays`, `monthly` (including `"last"` day handling), and
     `interval` (with optional quiet-hour window) using `Temporal`, preserving DST
     safety.
2. **Watcher silent execution (`src/agent/tools.ts`, `src/jobs/execute.ts`, `src/workflows/service.ts`):**
   - Add `report_watcher_result` tool to `workflowTools` when
     `deliveryMode === "on_condition"`.
   - Suppress Telegram delivery cleanly when `notify: false` or when `dedupeKey` is
     within cooldown; record structured audit entry (`run.silent`).
   - Support bounded L0 `investigate_readonly` kickoff from Watcher alert into a
     Mission that delivers the synthesized root-cause report.
3. **Event trigger dispatcher (`src/workflows/events.ts`, `src/github/webhooks.ts`, `src/plugins/notifications.ts`):**
   - Evaluate matching active event-triggered automations inside the webhook/plugin
     ingestion transaction with dedupe, cooldown, active owner check, and repository
     permission verification before enqueueing a workflow run.
4. **Natural-language creation (`src/agent/tools.ts`):**
   - Upgrade `propose_workflow` (keeping existing call compatibility) so users can
     naturally request one-shot reminders, weekday/monthly/interval jobs, silent
     watchers, and GitHub/plugin event automations.
5. **Admin Panel UI (`web/pages/workflows-skills.tsx`, `web/workflow-summary.tsx`, `web/form-fields.ts`):**
   - Update saved workflow summary cards and New/Edit modal to configure trigger type,
     schedule/event fields, delivery mode (`Always` vs `Watcher`), and cooldown, using
     shared `Select` and modal patterns per `docs/design/ui-rules.md`.

### Verification gates (Phase 3)

- Unit & PostgreSQL integration tests:
  - `once` fires once and marks completed; `weekdays`, `monthly` (Feb 28/29 & `"last"`),
    `interval`, and DST transitions compute accurately.
  - Watcher `notify: false` produces zero Telegram deliveries and records silent audit;
    `notify: true` respects `dedupeKey` cooldown; `investigate_readonly` dispatches L0
    investigation without ever granting write permission.
  - GitHub webhook (`check_suite_failed`, `issue_labeled`, `pull_request_opened`) and
    plugin events trigger matching automations with deduplication, revoked-member
    blocking, and workspace pause handling.
- Playwright browser tests (`tests/e2e/automations-triggers.e2e.ts`):
  - Saved summary & modal editing for one-shot, recurring, watcher, and event-triggered
    automations at `1280px` & `390px` in light/dark themes.

---

## Phase 4: Per-Repository Task Queue, Cross-Repo Coordination, and Worker Adapter Seam

**Goal:** Eliminate same-repository task collisions, enable multi-goal queuing with
verified artifact carryover, coordinate cross-repository parent-child missions, and
decouple worker execution behind a clean adapter interface.

### Database migration (`migrations/029_repo_queue.sql`)

- Create `workspace_repo_queues` (`workspace_id`, `repository_id`, `paused`,
  `concurrency`, `revision`, `updated_at`).
- Create `workspace_repo_queue_items` (`workspace_id`, `id`, `repository_id`,
  `mission_id`, `coding_task_id`, `actor`, `chat_id`, `topic_id`, `priority`,
  `position`, `status`, `carryover_enabled`, `carryover_source_task_id`,
  `created_at`, `started_at`, `finished_at`).

### Backend changes

1. **Repository Queue Manager (`src/coding/queue.ts`, `src/coding/tasks.ts`, `src/jobs/queue.ts`):**
   - Route new coding tasks through `workspace_repo_queue_items` when another task is
     active on the same repository (or queue is paused).
   - Implement atomic promotion on task completion/cancellation/failure, `pin`,
     `reorder`, `pause`, `resume`, and `cancel`, with fresh actor/GitHub write access
     and group-binding verification on promotion.
   - Implement verified artifact carryover: pass bounded read-only summary + commit
     SHA + branch + PR link from the previous succeeded item in the same scope
     (strictly respecting private-vs-group isolation).
2. **Cross-repository Mission coordination (`src/orchestration/cross-repo.ts`, `src/orchestration/tools.ts`):**
   - Allow a Mission to dispatch parallel fan-out tasks across distinct repositories
     (`join_mode: "all"`) or dependent chains (Repo A completion automatically supplies
     commit-pinned `reference-sources` to Repo B).
3. **Coding Worker Adapter seam (`src/coding/worker-adapter.ts`):**
   - Extract `CodingWorkerAdapter` interface from Codex-specific invocation plumbing
     and wrap the existing local/Docker/OpenSandbox Codex runner as the default
     `codex` adapter, establishing a clean boundary for future alternate workers
     (e.g., Claude Code).
4. **Admin Panel UI (`web/pages/missions.tsx` or dedicated Queues card, `src/admin/routes/orchestration.ts`):**
   - Display per-repository queues with active item, ordered queued items, single
     opposite-state **Pause/Resume queue** button, **Pin**, and **Cancel** actions.

### Verification gates (Phase 4)

- Unit & PostgreSQL integration tests:
  - Same-repo sequential serialization, pin-to-front ordering, pause/resume, cancel,
    revoked-actor skipping on promotion, and private-vs-group carryover isolation.
  - Cross-repo parallel fan-out (`all` join) and dependent chain (Repo A → commit-pinned
    reference → Repo B) through full production composition.
  - Exact Docker image build + offline `dist/runtime-contract.js` check (zero external
    startup calls) + `docker compose config --quiet`.
- Playwright browser tests (`tests/e2e/repo-queues.e2e.ts`):
  - Queue pause/resume, pin, cancel, empty/loading/error states at `1280px` & `390px`
    in light/dark themes.

---

## Delivery ledger & release gates

| Phase | Migrations | Core deliverables | Key automated gates |
| :--- | :--- | :--- | :--- |
| **Phase 1** | None | Parallel read tools, `delegate_research` subagent, layered prompt routing | Unit + PG integration + `test:runtime` |
| **Phase 2** | `027_agent_orchestration.sql` | Durable Missions, Continuation wakeups, autonomous timers, Autonomy Policy (`Supervised`/`Check-in`), Admin UI | Unit + PG integration + `test:runtime` + Playwright |
| **Phase 3** | `028_automations_triggers.sql` | `once`/flexible schedules, Watcher silent-if-OK mode, GitHub/plugin event triggers, Automations UI | Unit + PG integration + `test:runtime` + Playwright |
| **Phase 4** | `029_repo_queue.sql` | Per-repo task queue + carryover, cross-repo coordination, `CodingWorkerAdapter` seam, Queues UI | Full `bun test` + exact image `runtime-contract` + Playwright |

Live Telegram rendering, real model multi-step behavior, live GitHub webhook delivery,
and production cutover remain explicit live acceptance gates outside local
deterministic verification.
