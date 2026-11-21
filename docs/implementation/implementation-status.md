# Implementation evidence

Historical verification logs are archived by month to keep this active status ledger concise:

- [October 2026 archive](archive/implementation-status-2026-10.md) (125 entries)
- [September 2026 baseline archive](archive/implementation-status-2026-09.md) (32 entries)

## Accurate token estimation, native multi-turn context, resilient compaction and Model usage analytics (2026-11-21)

Fixed token budget distortion, compaction fragility, context/prompt packing, and added source-complete Model usage analytics with zero new runtime dependencies:

1. **Accurate token estimation & compaction window fallback (`src/agent/tokens.ts`, `src/agent/runtime.ts`, `src/agent/compaction.ts`)**:
   - Replaced raw `Buffer.byteLength(JSON.stringify(...))` token estimation with a deterministic, zero-dependency mixed ASCII/code/CJK token estimator (`estimateTextTokens`, `estimateValueTokens`, `estimateContextTokens`), eliminating the 2–4× English/Chinese overestimation in budget reservations, `maxTokens` clamping, and compaction triggers while retaining conservative vision image allowance.
   - Added `contextWindowKnown` to `selectedModel()` and `effectiveCompactionWindow()` fallback (`DEFAULT_COMPACTION_CONTEXT_WINDOW = 128_000`) in `compactionPlan()` so custom models with unknown context windows still trigger compaction instead of using `Number.MAX_SAFE_INTEGER`.
2. **Fault-tolerant compaction (`src/agent/compaction.ts`)**:
   - Added `sanitizeCompactionSummary()` and `truncateUtf8Safe()` so invalid `[source:...]` citations are stripped and oversized summaries are safely truncated at UTF-8 code-point and citation boundaries instead of hard-failing with `compaction_invalid_summary`. Empty/unusable first-pass outputs retry once with explicit corrective guidance before failing closed.
3. **Native multi-turn context & structured system prompts (`src/agent/context.ts`, `src/agent/routing-prompt.ts`, `src/agent/runtime.ts`, `src/jobs/execute.ts`)**:
   - Split `buildContext()` into append-only native alternating `user`/`assistant` `historyMessages` (preceded by frozen memory/summary reference blocks when present) and an unescaped current-turn `prompt` with tail `<runtime_context>` metadata, improving multi-turn/code comprehension and prompt-cache prefix stability without polluting `run.transcript`.
   - Reorganized `src/agent/routing-prompt.ts` into concise Markdown sections with scannable bullets while preserving all security/confidentiality and behavioral invariants.
4. **Source-complete Model usage ledger & dedicated Admin Panel page (`migrations/030_model_usage.sql`, `src/usage/model-usage.ts`, `src/admin/routes/model-usage.ts`, `web/pages/model-usage.tsx`, `web/usage-charts.tsx`)**:
   - Added tenant-scoped `model_usage_events` table with historical backfill covering every model invocation source (`chat`, `workflow`, `mission`, `compaction`, `followup`, `research_subagent`, `memory_extract`, `memory_consolidate`, `self_check`, `coding_task`, `coding_conversation`, `review_bot`), capturing full token breakdowns (uncached input, cache read, cache write, output, reasoning), estimated input tokens, latency, tool calls, stop reasons, provider/model identity, USD spend, and explicit source links.
   - Extended `PiRunner`, `Executor`, `MemoryService`, `SelfCheckService`, Codex (`src/coding/local/conversation.ts`, `supervisor.ts`, `executor.ts`, `conversation-executor.ts`), `ReviewExecutor`, and `Store.save()` to capture and persist complete source-attributed usage and `pricingUnknown` flags, with workspace deletion cleanup.
   - Added `/admin/model-usage` ("Model usage") with time-range & source/model/status filters, 6 KPI summary cards (including estimator calibration ratio and prompt-cache savings), interactive SVG charts (stacked token timeline, dual USD spend & cache hit-rate trend, source attribution donut, model stacked bars, token composition bar, actor breakdown), and a paginated source-attributed ledger with record detail modal.

Local verification on Bun 1.4.4, Node 22.22.3, and disposable PostgreSQL 17:

- `bun run check` (only the nine pre-existing incident-script warnings), `bun run typecheck`, `bun run build`, and `bun run test:runtime` (16 injected + 16 configured startup cases, **zero external startup calls**) pass.
- Full unit suite: **976 passed, 9 Docker-gated skips, 0 failures** across 125 files (5,815 assertions), including new `tests/unit/tokens-and-compaction.test.ts` and `tests/unit/model-usage.test.ts`.
- Selected PostgreSQL integration suites (`model-usage`, `topic-memory`, `workspace-records`, `team-workflows`, `agent-orchestration`): **42 passed, 0 failures** (287 assertions), verifying migration `030_model_usage.sql`, all 12 source kinds, reconciliation, API filtering, tenant isolation, and workspace deletion erasure.
- Selected Playwright browser suites (`tests/browser/model-usage.e2e.ts` and `tests/browser/loading.e2e.ts`): **20 passed, 0 failures** across 1280px desktop and 390px mobile in light and dark themes; rendered screenshots were visually inspected and refined (donut breakdown wrapping, ledger header wrapping, and non-breaking table cells). This is bounded selection covering the new Model usage page and shared loading/usage layout, not a full browser suite run.
- Live Telegram rendering, live upstream provider caching/token behavior, container image builds, and production deployment remain outside this local verification.

## Agent orchestration, autonomy presets, proactive automations and repo queues (2026-11-20)

All four phases of [Agent Orchestration, Autonomy, and Proactive Scheduling](../design/agent-orchestration.md)
and the [implementation plan](agent-orchestration-plan.md) are implemented locally without adding runtime
dependencies:

1. **Phase 1 — Execution core & routing**:
   - Added explicit read-only tool concurrency metadata (`src/agent/tool-metadata.ts`) with a bounded
     AbortSignal-aware semaphore (default concurrency `4`) and fail-closed sequential defaults for
     mutating and non-builtin tools across `PiRunner`, `ExtensionHost`, `applicationTools`, `searchTool`,
     and `webReaderTool`.
   - Added the bounded depth-1 read-only research subagent (`delegate_research` in
     `src/agent/subagent.ts`), enforcing `maxTurns=6`, `maxTools=12`, read-only `subagentSafe` tool
     allowlisting, prepended confidentiality boundaries, and parent run/workspace USD budget settlement
     without polluting `run.transcript`.
   - Refactored `src/agent/context.ts` onto layered prompt builders in `src/agent/routing-prompt.ts`
     while preserving prompt-confidentiality precedence and all existing workflow/group/coding invariants.
2. **Phase 2 — Durable missions, continuation wakeups and autonomy presets (`027_agent_orchestration.sql`)**:
   - Added tenant-scoped `workspace_missions` and `workspace_mission_waits` tables plus `workspace_runs.mission_id`.
   - Implemented `manage_mission`, `schedule_mission_followup` (bounded autonomous 1m–72h delayed checks,
     max 3 per mission, no extra confirmation required), and parallel read-only `inspect_missions`
     (`src/orchestration/`), plus event-driven continuation wakeups (`resolveMissionWait`, `tickMissions`)
     covering timers, decided approvals, terminal/review coding tasks, and GitHub webhook events with
     `all`/`any` join barriers, wakeup limits, unchanged-timer circuit breakers, and full re-authorization.
   - Removed the unconditional `codingTaskId` reply truncation for mission-attached runs so Pi can
     deliver concise natural acknowledgements while background steps proceed silently.
   - Added deterministic server-enforced autonomy policy (`src/autonomy/policy.ts`, `Supervised` default
     and `Check-in` workspace/per-repository overrides) enabling routine non-destructive L1/L2 writes
     with audit trails while immutably gating all L3 high-impact/destructive actions (PR merge/close,
     GitHub releases/tags, deletions, permission/autonomy edits).
3. **Phase 3 — Proactive automations & silent Watchers (`028_automations_triggers.sql`)**:
   - Extended `recurrenceSchema` and `src/workflows/schedule.ts` to support `once`, `daily`, `weekly`,
     `weekdays`, `monthly` (`1..28` or `"last"`), and `interval` (with optional quiet hours), preserving
     DST safety and legacy `daily`/`weekly` compatibility.
   - Added `report_watcher_result` and `deliveryMode: "on_condition"` Watcher execution with silent
     healthy runs (`run.silent`) and deduplicated alert cooldowns (`workspace_automation_events`).
   - Added event-triggered automations (`src/workflows/events.ts`) wired into verified GitHub webhook
     ingress (`check_suite_failed`, `issue_opened`, `issue_labeled`, `pull_request_opened`,
     `pull_request_ready`) and mission `github_event` wakeups.
4. **Phase 4 — Per-repository task queues, cross-repo coordination & worker adapter seam (`029_repo_queue.sql`)**:
   - Added `workspace_repo_queues` and `workspace_repo_queue_items` (`src/coding/queue.ts`) supporting
     sequential per-repository serialization, `pin`, `pause`/`resume`, `cancel`, fresh permission checks
     on promotion, and scope-isolated verified artifact carryover.
   - Added `dispatchCrossRepoMission` (`src/orchestration/cross-repo.ts`) for parallel `all`-join fan-out
     and dependent repository chains, plus `CodingWorkerAdapter` / `CodingWorkerRegistry`
     (`src/coding/worker-adapter.ts`) decoupling orchestration from Codex CLI.
   - Added Admin Panel **Missions & Orchestration** (`web/pages/missions.tsx`,
     `src/admin/routes/orchestration.ts`) and upgraded **Workflows** summary/editor cards
     (`web/workflow-summary.tsx`, `web/form-fields.ts`, `web/pages/workflows-skills.tsx`), following
     [UI design rules](../design/ui-rules.md).

Local verification on Bun 1.4.4, Node 22.22.3, and disposable PostgreSQL 17:

- `bun run check` (only the nine pre-existing incident-script warnings), `bun run typecheck`,
  `bun run build`, and `bun run test:runtime` (16 injected + 16 configured startup cases including
  `delegate_research`, `manage_mission`, `schedule_mission_followup`, and `inspect_missions`, with
  **zero external startup calls**) pass.
- Full unit suite: **950 passed, 9 Docker-image-gated skips, 0 failures** across 123 files
  (5,599 assertions).
- Full PostgreSQL integration suite: **804 passed, 0 failures** across 58 files (7,173 assertions),
  including new `tests/integration/agent-orchestration.test.ts` covering migrations `027`–`029`,
  multi-wait `all`-join wakeups, timer ticks, event dedupe/cooldown, repo queue carryover, and
  cross-repo dispatch.
- Selected Playwright browser suite (`tests/browser/agent-orchestration.e2e.ts` and
  `tests/browser/team-workflows.e2e.ts`): **19 passed, 0 failures** at 1280px desktop and 390px
  mobile in light and dark themes; rendered desktop and mobile screenshots were visually inspected
  and refined (`data-table-scroll` and non-wrapping `.pill`). This is bounded selection covering the
  changed Missions/Autonomy/Queues and Workflows surfaces, not a full browser suite run.
- Live Telegram rendering, real model multi-step behavior, live GitHub webhook delivery, container
  image build, and production deployment remain outside this local verification. See
  [user guide](../user/agent-orchestration.md) and [runnable examples](../../examples/agent-orchestration.md).

## Core storage split, modularization and slim runtime image (2026-11-20)

Four structural refactors were applied locally without changing external API or UI contracts:

1. **Relational workspace records and incremental outbox (`026_workspace_records.sql`)**:
   Moved `messages`, `runs`, `deliveries` and `audit` out of `workspaces.data` JSONB into
   indexed, tenant-scoped relational tables (`workspace_messages`, `workspace_runs`,
   `workspace_deliveries`, `workspace_audit`) with `ON DELETE CASCADE`, order-preserving
   `seq`, and indexed lookup columns (`status`, `state`, `run_id`, `draft_id`/`draft_bot_id`).
   `Store` performs transaction-locked delta syncs (`FOR UPDATE` on the matching SQL client)
   and enqueues only newly queued runs and newly pending deliveries to `outbox`, while
   preserving compatibility with raw inline JSONB fixtures and encrypted private browser records.
2. **Delivery policy decoupling and named composition dependencies**:
   Extracted domain delivery authorization and lifecycle hooks into
   `src/jobs/delivery-policies.ts` (`deliveryKind`, `DeliveryPolicyRegistry`,
   `defaultDeliveryPolicies`) with per-check deployment caching, removing subsystem imports
   from `DeliveryWorker`. Added typed named dependency objects (`AppDependencies`,
   `WorkerDependencies`, `PluginServiceDependencies`, `AdminRoutesOptions`) across
   `src/server.ts`, `src/worker.ts`, `src/agent/plugin-runtime.ts`, `src/app.ts` and
   `scripts/fixtures/plugin-startup.ts`, with backward-compatible overloads for existing callers.
3. **Oversized file modularization**:
   Split `src/admin/routes.ts` (2,335 → 123 lines) into six Hono sub-routers under
   `src/admin/routes/` while preserving middleware ordering. Split `web/app.tsx`
   (4,733 → 743 lines) into `web/admin-shared.tsx` and six page modules under `web/pages/`.
4. **Opt-in transcription Docker runtime and status archiving**:
   Switched the default `app` Dockerfile target to slim Node 24 (`runtime-base`, ~465 MiB)
   without Python/PyTorch, exposing `app-transcription` and `compose.transcription.yaml` for
   opt-in local Qwen3-ASR. Archived September and October 2026 verification logs into
   `docs/implementation/archive/` and updated affected relative links (`broken=0` across `docs/`).

Local validation on Bun 1.4.4, Node 22.22.3, Podman 6.2.0 and disposable PostgreSQL 17:

- `bun run check` (only the nine pre-existing incident-script warnings), `bun run typecheck`,
  `bun run build`, and `bun run test:runtime` (16 injected + 16 configured startup cases,
  zero external calls) pass.
- Unit suite: **932 passed, 9 Docker-image-gated skips, 0 failures** across 118 files
  (including new `tests/unit/delivery-policies.test.ts`; `tests/unit/browser-release.test.ts`
  verified with `GIT_CONFIG_GLOBAL=/dev/null` in the sandbox).
- PostgreSQL integration suite: **796 passed, 1 initial failure** in `telegram-reactions.test.ts`
  (exposing an unlocked-save snapshot diff bug in `Store.save`), followed by **69/69 passing**
  across `telegram-reactions.test.ts`, `workspace-records.test.ts` and `system.test.ts` after
  scoping snapshot diffs strictly to transaction-locked `FOR UPDATE` clients.
- Selected Playwright browser suite (7 files covering all split `web/pages/` modules):
  **64 passed, 1 pre-existing failure, 9 skipped-after-serial-failure** (`admin.e2e.ts:1554`
  expects `default_events` without `"issues"`, which was added in an earlier commit `eaf3145`).
  This is selected browser coverage, not a full suite pass.
- Container checks: `docker compose config --quiet` passes for both `compose.yaml` and
  `compose.yaml + compose.transcription.yaml`. The slim `app` target built and passed its
  offline Node 24.21.0 `dist/runtime-contract.js` check (`--network none`, size 487,689,472 bytes).
  The opt-in `app-transcription` image build and live deployments were not executed.

## Codex Telegram message actions (2026-11-17)

Codex task acknowledgements, progress edits, questions, blockers, status replies
and outcomes omit inline Status/Cancel. View conversation remains available;
confirmed PR messages retain Review/Merge. Ordinary chat, explicit task commands,
authorized task selectors and native streaming Stop retain their behavior.
Delivery also strips these controls from retained queued intents and retries.
The existing durable cleanup removes older delivered keyboards after a confirmed
update, preserving text and URL links; authenticated legacy callbacks remain
supported until their stored controls are revoked.

The focused feedback/development selection passed **33 tests**, covering task
states, delayed progress, repair edits, legacy queue/retry behavior, duplicate and
concurrent delivery, PR links, cleanup recovery and authorization boundaries.
Lint (nine existing incident-script warnings), strict TypeScript, build and the
Node runtime contract passed. The full Bun suite passed against disposable
PostgreSQL: **1,758 passed, nine Docker-gated skips, zero failures across 179 files**.

Browser selection relative to starting commit
`89fdee187032a95049b0713ab2a8194e32eaa0e8`: no browser cases selected because this
change affects native Telegram keyboards and backend delivery only; web source,
dependencies and configuration are unchanged. No previous browser results are
claimed as new evidence. Native Telegram desktop/mobile rendering remains
unverified. No live Telegram messages, deployment or external account changes
were performed. This entry records local verification before commit and push.

## Plugin notification events (2026-11-14)

GitHub repository plugins can declare `notifications.publish` and named events.
A successful private tool result can return bounded, typed notification candidates;
the host validates the complete result, current capability grant and source pins,
then records a deduplicated personal Telegram delivery. Candidates cannot choose
an actor or chat. Another member's subscriptions never receive the invoking
member's source results. Group invocations do not publish these events.

The SDK exports candidate types and generated `NotificationEvent` names. Manifest,
result and capability validation, the private supervisor and the portable
SDK/schema/CLI template share the additive preview API 1 contract. Older hosts
reject the new capability before execution. The `repository-alerts` example reads
current GitHub counters and reports an observed threshold without inventing its
historical crossing time. This profile adds no plugin timer, autonomous poller,
public plugin webhook or Telegram credential access.

Members manage their own subscriptions through `manage_plugin_notifications` in a
current private text request or through the package details' Notifications card.
Saved values remain separate from New/Edit dialogs. Revisions and installation
generations reject stale edits; removed event names are discarded from upgraded
editor drafts. Pending saves lock dismissal and preserve failed drafts. Pausing,
deleting, losing source access or changing installation/configuration/grants fences
older deliveries. Uninstall explicitly pauses subscriptions so reinstalling
identical bytes cannot revive them. Receipts in migration
`025_plugin_notifications.sql` contain event hashes rather than text; the shared
worker purges them after 30 days and on workspace deletion. Existing Telegram
retry/unknown-outcome handling applies.

Final combined-source checks passed: lint (nine existing incident-script warnings),
strict root and new-example TypeScript, build, Node runtime contract, and the full
Bun suite (**1,755 passed, nine Docker-gated skips, zero failures across 179 files**).
The job-image and package production-composition suite was separately run with the
immutable image below: **21 passed, zero failures**, including all gated sandbox
checks and the new candidate-event case. The pinned Bun 1.3.14 portable template
passed from an independent directory. The bundled Code Truth catalog regenerated
without a diff and the real-index/MCP/commit-provenance service smoke passed.

**42 distinct selected browser cases passed** across seven files. The final fresh
13-case run covers GitHub notification management, plugin event subscriptions,
upgrade-event recovery and the full package install/configuration/rollback flow.
The 29 unchanged GitHub permissions/repository refresh, catalog and version/update
cases from the first phase are reused; their code/dependencies/configuration did
not change. This is bounded selection, not a full browser-suite claim. Desktop
1280px and mobile 390px saved summaries, editors, retained errors and control
placement were inspected. Earlier runs made during active edits/builds and their
intermediate failures are superseded by the stable-source passing runs.

Local validation artifacts (not production release images):

- App: `sha256:928bf9ac9c02ca6fb39648ec48442f29372e182b570c29ce6031e92ef21c3851`.
  Its isolated Node 24.21.0 contract passed 16 ordinary and 16 configured startup
  cases with **zero external startup calls**, including a granted notification
  producer and both management tools.
- Plugin job: `sha256:ee899c297120a1dbc972f01d501f81d9f6dd9f9c5ee13c15ee8a8df2a896a637`.
- Plugin supervisor: `sha256:593b59dea019e90d0623f8619f7768bb01132258e3c27c8799dfbc91ebf76dbe`.
  Its isolated authenticated health smoke returned protocol 1, HTTP 200 with the
  synthetic token and HTTP 403 without it. Docker execution/broker behavior was
  tested separately through the exact job-image suite.

Compose configuration validated with an empty environment file and synthetic
password. This entry records local verification before commit and push. No production deployment,
account connection, webhook registration, live model/provider event or Telegram
send was performed. Live model intent, real provider events and native Telegram
rendering remain acceptance gates. See [contracts and boundaries](plugin-notifications.md)
and the [author guide](../user/plugin-development.md#publish-opt-in-notification-events).

## Personal GitHub notifications (2026-11-14)

Members can subscribe to new PRs and issues in connected repositories through a
current private Telegram text request or **Plugins → GitHub notifications**. Each
member manages only their own repository/event subscriptions. New/Edit use shared
modal controls; saved summaries remain read-only. Pause, resume and deletion fence
queued recipients and deliveries. Notifications use the private main chat, include
Draft labels and links, and require no model, Code Truth, Codex or Review Bot run.
Natural-language subscription management uses the ordinary chat model.

The shared GitHub ingress validates raw-body HMAC signatures and persists bounded,
tenant-scoped event metadata with delivery/semantic deduplication. Worker
transactions create normal outbox-backed Telegram intents. Current membership,
repository scope, bot identity, subscription revision and linked-user read access
are checked before delivery. App lifecycle revocation pauses affected subscriptions;
refresh/reconnection and explicit resume are required. Removed permissions and
reactivation cannot revive cancelled intents. Repository renames retain numeric
identity. Processed payloads are erased immediately; 30-day event retention also
runs while a workspace is paused. Workspace deletion removes subscription and
receipt state.

Migration `024_github_notifications.sql` adds event receipts and durable App webhook
recovery state. New GitHub App manifests include `issues`; existing Apps must add
it manually. The notification Delivery card exposes the URL and an operator-only
shared secret editor, compatible with Review Bot's encrypted storage. Saving a
secret does not update GitHub. A separate bounded recovery loop checks App delivery
history every five minutes, with cursor pagination, three attempts per GUID and
three redelivery requests per check within a three-day window. Telegram uncertain
sends retain the existing unknown-outcome policy and are not automatically replayed.

Final frozen-source validation on Bun 1.4.4, Node 22.22.3 and disposable PostgreSQL
17 passed: `bun run check` (nine existing incident-script warnings),
`bun run typecheck`, `bun test` (**1,744 passed, eight Docker-gated skips, zero
failures across 178 files**), `bun run build` and `bun run test:runtime`.
All 13 notification integration tests passed. The production-factory contract
passed 16 ordinary and 16 configured startup cases with **zero external startup
calls**. Earlier runs performed while fixes were still being made are superseded
by the final complete run; an intermediate Codex test timeout did not recur.

**33 distinct selected browser cases passed** across notification management,
GitHub repository refresh, Review Bot/Codex configuration, plugin catalog and
application version/update flows. The notification suites were repeated after
scoped visual adjustments; unchanged related results were reused. Desktop 1280px
and mobile 390px saved/empty, editor, pending and error layouts were inspected,
including light/dark styling and right-aligned mobile management actions. Baseline
`f615f56588f3b33afe6e4488553a8369fa03b23c` has documented group-feedback verification;
only instructions and package version differ between it and the starting release
`c81cbf6d470f85353590958df82f13d1933ccfd1`. No dependency change intervenes.
This is selected browser coverage, not a full browser-suite pass.

See [implementation contracts and selection](github-notifications.md),
[the standalone user guide](../user/github-notifications.md) and
[the acceptance journey](../../examples/github-notifications.md).
These checks record local verification before commit and push. No production change,
account connection, webhook registration, live GitHub/model call or Telegram send
was performed. Live event delivery and native Telegram rendering remain acceptance
gates. The pre-existing `CLAUDE.md` deletion was preserved.

## Repository-bound group feedback (2026-11-13)

Workspace managers can bind one selected public GitHub repository from a group's
Edit dialog. Saved rows show the repository; all participants and Topics inherit
it, including new Topics. Personal repository selections and stale picker callbacks
cannot override the target. Bindings pin the bot, installation, connection and
repository generations, with optimistic revisions and an audit trail. Replacing,
removing or relinking a binding fences older runs/tasks; unchanged saves preserve
work. An unavailable optional repository permits a new ordinary conversation with
truthful unavailable context, while repository work requires a current binding.

Actionable bugs and feature requests enter read-only Codex investigation and risk
assessment. Current active membership and the requester's verified GitHub write
access remain mandatory. The structured allow/clarify/reject decision pins the
consumed input revision and exact authenticated evidence before implementation or
publication authority. Rejection stops without a write grant; missing, malformed
or stale assessments fail closed. Clarifications, answers after implementation
questions and later requirements repeat intake. New inputs during work prevent an
older patch from publishing. Checked changes follow existing PR publication and
human merge approval. No dependency or SQL migration is added.

The applicable UI acceptance criteria are saved text separate from modal editing,
shared dropdowns and controls, retained drafts on errors, pending dismissal locks,
Save/Cancel ordering, focus return and container spacing. Desktop 1280px and mobile
390px screenshots were inspected across both themes, including saved summaries,
editor errors, loading, empty, pending and unavailable bindings. All **41 selected
browser tests passed** in `group-repository.e2e.ts`, `group-links.e2e.ts` and
`groups-members.e2e.ts`. Selection starts from freshly fetched, clean shared main
`7d0beb6a71b778bb32b4d5f3e8ffef93395bf268`; these suites cover the changed group
editor, linking/collection controls, member page, routing, loading and workspace
isolation. No earlier browser results are reused, and this is not a full browser
suite run. Intermediate failures exposed focus restoration and test assumptions
about the old collection-to-Cancel tab order; both are corrected in the passing run.

Validation on Bun 1.4.4, Node 22.22.3 and disposable PostgreSQL 17 passed:
`bun run check` (nine existing incident-script warnings), `bun run typecheck`,
`bun test` (**1,731 passed, eight Docker-gated skips, zero failures**),
`bun run build` and `bun run test:runtime`. The full deterministic run includes
the unavailable-binding greeting regression. The bundled Code Truth catalog was
regenerated without a diff; its local service smoke passed real indexing, MCP
and commit provenance. The Node
production-factory contract passed all 16 startup cases with zero external calls.
Implementation was verified on `feat/group-repository-feedback`. No application release
image, production change, GitHub write, Telegram send or live model acceptance was
performed. Semantic risk quality and native Telegram rendering remain live gates;
model assessment does not prove universal detection of harmful suggestions.
Deploy app/worker, supervisor and job builds together for the feedback protocol.

See [group behavior](../design/group-conversations.md#repository-feedback-groups),
[the user guide](../user/groups.md#bind-a-repository-for-feedback) and the
[acceptance journey and HTTP requests](../../examples/telegram-group-feedback.md).

## Chatbot prompt confidentiality (2026-11-13)

Private, group and scheduled runs now prepend shared security instructions before
personality, approved instructions and pinned skills. The prompt covers direct,
partial and transformed extraction, authority impersonation, injected reference
content and disclosure through tools or delegated tasks. It permits high-level
capability explanations, authorized inspection of user-managed instructions/skills
and analysis of suspicious content, and directs the model to continue separable
legitimate work after declining extraction. Application authorization is unchanged.

Four deterministic regressions check prompt ordering across all three run types
and preservation of suspicious source text as reference data. These checks verify
assembly and do not demonstrate live-model resistance to every injection.

Verification uses an isolated `569f754` snapshot plus this patch, Bun 1.3.14 and
disposable PostgreSQL. Lint (nine existing incident-script warnings), strict
types, build and the Node runtime contract pass, including zero external startup
calls. The full test run records **1,715 passes, eight Docker-gated skips and one
template import error** because the template's separately declared SDK dependency
was not installed in the snapshot. After a frozen-lockfile install scoped to
`templates/plugin`, that test and the four prompt regressions pass (**five tests**).
The full suite is not repeated after template-only dependency preparation;
application source and root dependencies remain unchanged. This is not a single
successful full-suite run.

Change selection starts from clean, freshly fetched main `44f32bd`; concurrent
GitHub plugin work subsequently advances this checkout to `569f754`, preserving
the prompt edits. This task changes only chatbot prompt text, deterministic
context tests and documentation. No browser test is selected for the prompt
change and no pre-change test result is reused; browser coverage for the separate
plugin work belongs to its verification ledger. Live model behavior, Telegram
delivery and deployment remain unverified for the prompt change.

## GitHub repository plugin preview (2026-11-13)

Implemented locally on the Pi 1.5.2 source: versioned manifest/semantic validation,
source-only author SDK and portable template/CLI, immutable GitHub source preview,
tenant artifact cache, disabled-by-default install/update/rollback, settings/grants,
encrypted scoped HTTP bindings, static Pi adapters and a private Docker supervisor
with bounded per-call jobs. The app and worker share the existing `pluginRuntime`
composition; optional services/credentials remain lazy during registration.

The final full suite passes **1,712 tests across 175 files** with eight Docker-gated
cases covered separately by **19 exact-image tests**. Lint (nine pre-existing
incident-script warnings), strict types, production build, template verification,
**24 distinct selected browser scenarios**, local/exact-app runtime contracts,
exact-supervisor smoke, storage initialization and the opt-in Compose validation
pass. See [source/image identities and verification scope](github-plugins-verification.md).

This is an opt-in read-only preview, not stable SDK 1 or a production release.
Official template/npm publication, two independently authored remote repositories,
real GitHub/Telegram/service pilot and target-host recovery drills remain open
release gates. No live account connection, message or deployment is performed.
See [delivery ledger](github-plugins-plan.md),
[developer guide](../user/plugin-development.md) and
[operator guide](../user/plugin-administration.md).

## Pi 1.5.2 dependency upgrade (2026-11-13)

The npm `latest` tags for `@earendil-works/pi-agent-core`, `pi-ai` and
`pi-coding-agent` resolve to **1.5.2**. All three direct dependencies and the Bun
lockfile move together from 0.85.1. See the upstream
[agent](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/CHANGELOG.md),
[AI](https://github.com/earendil-works/pi/blob/v1.5.2/packages/ai/CHANGELOG.md) and
[extension](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md)
changelogs for the intervening changes.

The adapter uses Pi's `finishTurn` boundary in place of `shouldStopAfterTurn`,
retaining hard exits, cancellation, limits and queued-input handling. Provider
fixtures read prompts and tools from normalized transcript system messages.
The headless `context` hook continues to receive only conversational messages;
application-owned system instructions and granted tools remain outside its
replacement list. User-start hooks include `messageType: "user"`. The new nested
tool APIs remain unsupported rather than bypassing application execution guards.
Persisted Browser wait results use Pi's JSON-compatible details type. The runtime
contract reports Pi's installed version instead of a hardcoded historical value.

New deterministic regressions verify prompt/tool preservation across context
replacement and denial of nested tool access. Existing extension, steering,
pause/resume, cancellation, permission and duplicate-event coverage remains in
the verification scope. Tool schemas remain TypeBox-built JSON Schema; Pi 1.5
now validates these through Pi Schema. No migration or new application-owned
dependency is added.

The Pi upgrade's complete run passes **1,651 tests across 167 files** with Bun
1.3.14 and disposable PostgreSQL. Frozen-lockfile installation, Biome (nine existing
warnings in the incident diagnostic script), root and Code Truth strict typechecks, the
production build and **70 selected browser scenarios** pass. Local Node 22.22.3
and the built application image on Node 24.21.0 pass the runtime contract,
including **16 injected and 16 configured production-startup cases with zero
external startup calls** after the concurrent composition cleanup described below.
The image contract runs with networking disabled; its image ID is
`sha256:b66aee4f42235e5158bd33326447ba8562f8d943efad392bf4e0b20b84a1d45f`.
`docker compose config --quiet` also passes.

Concurrent cleanup changed server/worker plugin wiring and startup fixtures
during the final full run. Its 1,651-test total covers the Pi upgrade before
those changes, not the entire combined checkout. The combined checkout subsequently
passes fresh lint, types, build, both startup tests, the local runtime contract
and the rebuilt image's offline contract. The full suite is not repeated for that
separate cleanup; its remaining validation belongs to that workstream.

Browser selection compares the local candidate with clean main `4bde2fc`, whose
runtime source is the previously verified `c3473d9`; the later baseline commits
contain documentation only. Selected files are `model-providers.e2e.ts`,
`plugins-catalog.e2e.ts`, `skill-management.e2e.ts`, `team-workflows.e2e.ts` and
`browser.e2e.ts`, covering model/catalog settings, extension configuration,
skills, schedule controls and Browser continuation consumers. No earlier test
result from the baseline is reused. Candidate browser and image results remain
valid after the service-test fixture correction because their runtime source,
dependencies and configuration are unchanged. The later composition cleanup
gets the fresh image checks above; browser-facing code and fixtures remain unchanged.
Other browser flows, live
model/Telegram behavior and deployment remain outside this local verification.

## Authenticated repository statistics for schedules (2026-11-13)

The existing `query_github_metadata` tool now accepts `kind: repository` to read
current stars, forks and notification subscribers through the connected GitHub
App. Tokens request only Metadata read permission for the selected repository.
Responses verify repository identity and safe nonnegative counters and include
a canonical URL and retrieval time. Existing actor, repository, workflow-source
and delivery checks remain enforced. Instructions name this query for ordinary
requests and schedules; a current total does not establish a historical delta.
No dependency, SQL migration, browser policy or UI change was added.

Validation with Bun 1.3.14 and disposable PostgreSQL passes all **27 new
regressions**, lint, strict types, build and the Node runtime contract, including
**16 production-startup cases with zero external startup calls**. The full run
completed with **1,644 passes and one failure across 167 files**. Its unchanged
native-runtime supervisor test reported `coding_runner_unavailable`; all six
native-runtime tests pass on an isolated retry. This is not a full-suite pass.
Lint retains nine existing warnings in the unrelated incident diagnostic script.

Change selection uses baseline `0424ce9`: only the GitHub API/tool path, its
bundled instructions, startup assertions, deterministic tests and documentation
changed. No browser test is selected because browser-facing UI, routes,
dependencies, configuration and fixtures are unchanged; no prior browser result
is reused. The production-composition regression exercises scheduled private
Topics, an ordinary member, dispatch/execution/delivery duplicates, Store restart
and revoked delivery access with fake GitHub, model and Telegram transports.
Native Telegram/model acceptance remains unverified. The later operator-authorized
VPS deployment and live authenticated read are recorded below; the initial local
verification did not send messages, mutate schedules or replay historical runs.
See [the incident](../../postmortem/2026-11-13-scheduled-github-repository-statistics.md)
and [runnable examples](../../examples/team-workflows.md#current-repository-stars-forks-and-watchers).

PR integration follow-up: CI quality, container verification and browser shard 1
pass on `0b50795`. Browser shard 2 records 206 passes and four failures in the
unchanged preset-card test: its total expanded-height cap excludes the documented
exception for complete long instructions. Preset data and UI source match main.
The regression now checks compact settings and wrapped tools separately from
complete, vertically and horizontally unclipped instruction text, while retaining
keyboard, toggle/error and editor-boundary checks. All nine focused preset
browser scenarios pass; expanded widget previews were inspected at 1280px and
375px in light/dark themes. Main independently corrected the same test in
`5b77390`; integration preserves that newer test unchanged. No product UI or
preference rule was changed. The final merged source subsequently passed complete
[Verify run 43367444453](https://github.com/stonega/repodesk/actions/runs/43367444453):
**1,616 deterministic tests and 450 browser scenarios**, quality/types/build,
runtime and container checks. The earlier failing browser run remains a failure.

Operator-authorized VPS bundle `1794550454130-92998264` deploys that immutable
main source `c3473d9aaf4c3382e09a7dc98c8a988c04da5362`, replacing the v0.1.49
source that predates this fix. The exact images pass the offline startup contract,
Code Truth, Compose readiness, migration rerun and disposable backup/restore.
A read-only production probe through the current schedule's authorization and
`GitHubMetadata.repository` returns live GitHub totals. The schedule remains
active, version 1, at 08:00 Asia/Taipei; no model call, manual Telegram send,
schedule mutation or historical replay is used. Package version remains v0.1.49;
no new stable release is published. See [deployment evidence](vps-deployment.md#scheduled-github-statistics-deployed-2026-11-13).

## Repository tasks, release effects and preference memory (2026-11-12)

The existing continuous task engine now supports investigation and release
objectives. Pi preserves original requests; Codex reads repository instructions
and prepares/checks work; application services retain authorization, waits and
external effects. Tasks survive process exit and reconstruction. A release may
produce a verified empty patch, wait for its exact PR/commit/CI, and continue
without keeping Codex running. New objectives require supervisor protocol v1.

Trusted credential-free export reads actual guide/asset files, with path and size
bounds and SHA-256 digests. Migration 023 adds a tenant-scoped release action
ledger. Tags, GitHub Releases and assets use exact target/payload checks,
reservations and readback; uncertain writes cannot be blindly replayed. Current
version/channel decisions fence earlier requests and draft-PR instructions.
Preparation-only requests and unsupported registry/deployment procedures never
gain release authority. Confirmed partial effects survive failure and Stop.

Source-linked decision cases and revisioned preferences retain authors, scope,
applicability and exceptions. Explicit mutation uses current human text;
tool-free extraction can only infer candidates. Optional Pi/Codex packs recheck
source dependencies and revisions. Correction/forgetting invalidates delayed
output, transcripts and runner checkpoints before fresh execution. Retention
removes memory/release content while retaining content-free replay tombstones.
Investigation/release objectives, preference derivation and Pi/Codex preference
recall default to enabled, per the owner's 2026-11-12 instruction. Missing settings
on existing workspaces use these defaults; explicit disables remain effective. No dependency
or separately deployed service was added.

Validation after integrating the scheduled private widget changes from main:
**1,618 tests across 166 files pass** with Bun 1.3.14 and isolated PostgreSQL.
Biome, strict TypeScript and the production build pass; Biome retains
nine existing warnings in the unrelated incident diagnostic script. Targeted
regressions additionally exercise enabled defaults for missing/legacy settings,
preserved explicit disables, transitive Pi/task memory invalidation, speaker/bot
boundaries and JSONB-stable configuration replay. Default-enabled production
startup remains covered by all 16 cases with zero external requests. Twelve existing
Codex runtime browser scenarios pass at desktop/mobile widths.

The application image passes the 16-case production factory contract with zero
external startup calls. Docker job/supervisor smoke passes the real pinned CLI
sandbox and OCR probes plus fake-service release export, empty-patch verification,
restart, erasure and existing coding/auth/publication journeys. App/worker HTTP
readiness, repeated migrations, backup/restore, Compose configuration and the
regenerated Code Truth catalog/service smoke also pass.

See [implementation and operations](repository-tasks.md),
[release requests](../user/repository-tasks.md),
[preference controls](../user/preference-memory.md) and
[deterministic examples](../../examples/repository-tasks.md).
Live model interpretation, Telegram/GitHub pilot acceptance and production
rollout remain P5 gates. No deployment, real release, account connection or live
model/Telegram request was performed in this implementation.

## Scheduled private Telegram widgets (2026-11-12)

Scheduled answers can now stage and deliver HTML widgets to their saved private
chat or private Topic. New private occurrences pin the enabled built-in widget
preset alongside the selected procedure; saved workflow versions and old run pins
remain unchanged. Known unchanged presets upgrade once while preserving custom
content, disablement and immutable history. Application guidance overrides the
obsolete schedule restriction in old widget pins and distinguishes local policy
errors from Telegram API rejections.

The tool requires the current active workflow version, owner and exact saved
private destination. It binds the deployment bot when first staged, rechecks it
on replay, revision, publication and delivery, and preserves the existing safe
caption fallback and uncertain-delivery rules. Group widgets remain denied;
free-form workflows retain their original cost-query access and cannot acquire
write capabilities from presentation support. No dependency or migration was added.

Validation: all **1,569 tests across 163 files** pass with disposable PostgreSQL
and Bun 1.3.14, including **60 focused widget/workflow tests**.
Coverage follows dispatch, application tools, Executor, Store restart and durable
DeliveryWorker, including ordinary members, both private destination types,
selected/old skill versions, duplicate events, changed workflows, bot rotation,
Topic-preserving caption fallback and uncertain sends. Biome, strict TypeScript,
production build and the 16-case offline Node startup contract pass with zero
external startup calls. No live Telegram/model call or deployment was performed.
See [implementation](telegram-widgets.md) and the
[incident analysis](../../postmortem/2026-11-12-scheduled-private-widgets.md).

## Outstanding branch consolidation (2026-11-12)

The outstanding local and remote branch histories, the three local-main commits
and the previously uncommitted workspace changes are consolidated on main.
All original branch tips are ancestors of the integration result. Equivalent
patches and superseded deployment snapshots retain the later implementation;
the download investigation remains available beside current chat diagnostics as
`deploy/browser-operator/download-diagnostic.py`. Local backup references preserve
the original workspace snapshot.

Validation: **1,554 tests across 163 files pass** with Bun 1.3.14 and isolated
PostgreSQL, using the CI 30-second timeout. Biome, strict TypeScript, production
build and the Node runtime contract pass. **36 browser scenarios** pass for
workflow ownership, Code Truth saved summaries/modal editors and native runtime
settings at desktop/mobile widths; screenshots were inspected. The built Docker
image passes all 16 integration-startup cases with zero external startup calls,
migration and app/worker HTTP readiness checks; Compose configuration and changed
Python syntax also pass. No production cutover or live Telegram/model request was
performed during this consolidation.

## Scoped repository schedules (2026-11-12)

Unrelated repository metadata changes no longer suspend a report or cancel its
queued run and pending output. Read scopes and fresh permission snapshots check
the connection generation and selected repositories' change revisions. Removed
IDs retain revocation tombstones; current membership, repository permissions and
group-publication checks remain enforced. Coding/verified write actions retain
their current-global-revision permission-sync requirement.

Confirmed permission losses target affected assistant work and dependent output,
while connection/identity changes retain full actor revocation. Unknown historical
provenance remains conservative. Suspensions now have specific saved causes,
timestamped audit entries and safe runtime diagnostics with tenant/run context.

Lint, strict types, builds and the offline runtime contract pass. All **1,500 main
tests** and **1,503 preserved-production tests** pass with Bun 1.3.14 and isolated
PostgreSQL. Regression coverage includes ordinary-member schedules, unrelated and
selected repository removal, revoked/stale access, connection/owner changes,
restart, duplicate dispatch and dependent output. No dependency or migration was
added. See [the incident record](../../postmortem/2026-11-12-workflow-global-repository-revision.md).

Deployed as bundle `1794469596569-79773357` over the preserved production source.
Exact-image startup/Compose/restore checks and all 55 deployed artifacts verify;
all five services are healthy. The reported Wallshader schedule was revalidated
and restored to active, next due November 13 at 08:00 Asia/Taipei. Its cancelled
occurrence was not replayed. See [deployment evidence](vps-deployment.md#scoped-repository-schedule-fix-deployed-2026-11-12).

## Optional Nowledge Mem plugin (2026-11-12)

**Plugins → Nowledge Mem** now configures an optional built-in adapter for one
member's private Telegram memory list/search/read and exact-content saves to a
selected Mem Space. The operator's modal discovers Space names, stores the API key
encrypted, shows saved summaries and provides an independent title switch.
The headless adapter uses the documented REST API; it does not install the terminal
Pi package, inject remote Rules or automatically capture chat transcripts.

Every tool checks current tenant/member, private destination, interactive run,
fence, bot identity and plugin revision. External saves require a direct current
human command such as `Save to Nowledge Mem: text`; forwarded commands cannot
provide consent. Durable receipts prevent duplicate sends and leave unknown write
outcomes reserved. Private evidence is rechecked transitively for retained answers,
handoffs and delivery. Missing Mem infrastructure cannot block unrelated chat.

Validation: `bun run check`, `bun run typecheck`, `bun test` and `bun run build`
pass, with **1,477 deterministic tests** using disposable PostgreSQL. Coverage
includes the production Pi factory, configuration authorization, concurrent saves
and receipt recovery. The packaged Node runtime contract passes all 16 combined
production startup cases with zero external startup calls.
Six focused browser scenarios pass at 1280px/390px, including both themes for
Nowledge Mem, with saved/editor, loading/empty, pending and error screenshots
visually reviewed. See [upstream review, setup and boundaries](nowledge-mem.md).
Live Mem/Telegram acceptance requires operator-provided credentials. No external
account connection, live memory save or deployment was performed.

## Missing token prices count as zero (2026-11-11)

The operator requested zero-dollar accounting for missing token prices. Pi uses
each available input, output and cache rate independently, defaulting missing
rates to zero. Chat, background memory and admin self-check calls allow finite
and zero-dollar budgets and record settled costs with token counts. Historical
unpriced calls without reconciled costs count as zero for remaining budgets,
Telegram cost queries, `/usage`, the Usage API and saved usage displays.
Known prices and operator-reconciled charges continue to count toward budgets.

The deterministic production-path regression exercises Executor, Pi, PostgreSQL
accounting and durable delivery with finite/zero budgets, historical unpriced
usage and duplicate execution. Memory and admin self-check regressions cover
zero-dollar settlement. The full suite passed **1,412 tests across 151 files**,
and the final focused memory/self-check run passed all **22 tests**. Biome,
strict TypeScript, build and the 16-case Node startup contract passed with zero
external startup calls. Two browser regressions passed at 1280px and 390px, with
the advanced editor, saved model summary and historical zero-cost Usage records
visually inspected. No dependency or SQL migration was added.

The authorized VPS rollout deployed source `af5171554df3488563af403f47f58d21e30f3986`
in bundle `1794367751621-08425833`, based on the previous production source
`ac7abf1`. That exact release passed **1,482 tests across 158 files** and the
two focused browser scenarios. The pinned Bun 1.3.14 build image also passed all
50 pricing/limits/cost-summary unit tests. Exact-image startup, CPU speech imports,
Code Truth smoke, Compose configuration/readiness, migration rerun and disposable
backup/restore checks passed. All 55 running artifacts and public/loopback assets
verify. Public health and readiness return HTTP 200. All five services are healthy.
The verified pre-cutover backup is `backups/pre-release-1794367751621-08425833.dump`
(165,882 bytes). The protected release directory retains the source, checksums,
quality logs and deployment receipt.

## Member invitation dialog (2026-11-11)

**Groups & Members → Members → New** now opens **Add member** with Telegram
invite instructions and the shared group-link dialog's copyable value layout.
The manual creation fields and Save membership action are removed from New;
existing members retain role, active membership and GitHub editing in **Edit**.
Pending access requests and their approval/rejection actions remain on the page.

Invites retain automatic ten-second refresh, the accessible circular countdown,
one-second copy feedback and 24-hour copied-link validity. Refresh failures keep
the current URL and offer Retry inside the dialog. Initial loading and missing-bot
states keep the layout visible; background refresh preserves copy-button focus.
The remaining Access requests card uses balanced container spacing.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **1,462**
deterministic tests passed with disposable PostgreSQL. **89 focused browser
scenarios** passed across invites, member/GitHub editing, groups, shared URL copying
and administration. Desktop (1280px) and mobile (390px) screenshots were inspected
in both themes, with loading, refresh, error, missing-bot and pending-approval
states also reviewed. No live Telegram/GitHub action or deployment was performed.

## Optional native VPS Codex runner (2026-11-11)

Codex runtime selection now includes **Native VPS**, alongside Docker (the default)
and OpenSandbox. The operator-only saved summary/modal retains revision, readiness,
audit and retained-task gates. The native driver runs the installed CLI through
`app-server` in a dedicated non-root Linux service, with explicit host enablement,
private per-task paths and fresh phase environments. No host account cache is
imported. Workspace authentication, current repository grants, continuous task
state, fixed verification, publication reservations and erasure keep their existing
application contracts. Host execution is for trusted repositories: task directories
and clean environments do not provide tenant, filesystem, network or resource
isolation. Container supervisors cannot pass native readiness.

Native process groups persist boot/start identities before execution begins.
Restart inspection does not launch work again, Stop fences reused PIDs, and phase
cleanup waits for tracked group processes to stop. Uncertain process identities
fail closed. The service and Docker-app connection examples are under
`deploy/codex/native*`; automatic VPS release deployment still selects Docker.
See [native setup](codex-runner.md#native-vps-installed-codex-cli).

Local verification includes **90 focused tests** through runtime, supervisor,
HTTP authorization and account contracts, including an actual job entrypoint with
fake installed CLI, local Git patch checks and export. **12 browser tests** pass;
desktop/mobile and both themes were visually inspected for saved/editor,
pending/error and unavailable states. Biome, strict TypeScript, build, Node runtime
contract, Docker supervisor build/image contract and Compose validation pass.
The full PostgreSQL suite recorded **1,460 passes and one unrelated failure** in
the scheduled personality policy assertion (`tests/unit/soul.test.ts`), in an area
already modified before this task. Real VPS service installation, native account
sign-in and a live model/GitHub task remain acceptance checks. No deployment,
account connection or external message was performed.

## Isolated workflow execution context (2026-11-11)

Scheduled and manual run-now invocations now receive a dedicated execution prompt
with the pinned workflow ID/version and saved task/format. Recent setup messages,
conversation summaries, schedule-comparison records and historical attachments
are not automatically included in that model input. Approved instructions and
pinned skills remain subject to application policy. Chat recaps can explicitly
read their frozen, authorized source snapshot through `read_chat_context`, which
marks the result as historical reference. Retention and source revocation still
apply; no additional history, integration access or write authority is granted.

The production factory exposes only read-only application tools for workflow
invocations. A separate check against the persisted workflow marker rejects
management tools before cached-result replay, even when an older published skill
grants those tools or a stale tool reference is invoked. Current integration
authorization checks continue to govern integration tools. This prevents an
invocation from creating/editing another workflow or persisting instructions,
skills, memory or conversation controls in response to setup history.

Deterministic coverage includes private/group setup history and legacy summaries,
explicit recap reads with and without a skill pin, denied legacy grants and
cached management outcomes, plus scheduler → Executor → Pi → Store → delivery
with duplicate ticks/execution and one unchanged workflow. Fake model and
Telegram transports make no live calls. This change remains local pending rollout;
no deployment or live schedule invocation was performed.

Validation passes **1,462 deterministic tests across 153 files**, including 95
focused context/policy/system checks. Biome, strict TypeScript, build and the Node
runtime contract pass, including 16 startup cases with zero external startup
calls. An unrelated native-runtime test failed once in the broad run; its isolated
suite and the complete rerun passed. No dependency or migration was added. Real
model task selection and live Telegram rendering remain pilot checks.

## Conversational Telegram controls deployed (2026-11-11)

Bundle `1794386364054-96360541` deploys production source
`41b179b93d88411437aab6c39cdb86dc45341c62` with main feature `bf644bb978827ed20066f6581d0c1a133eee11fd`.
The existing runtime fixes, configuration, credentials, mounts and database are
preserved. All five services are healthy; protected backup/restore, exact-image
checks, 55 artifact hashes and public readiness verify.
The production source passed 1,496 tests across 159 files;
read-only live Telegram verification confirms all three published command scopes
are empty. Native rendering and real-model intent selection remain acceptance
checks. See [deployment evidence](vps-deployment.md#conversational-telegram-controls-deployed-2026-11-11).

## Owner-only workflow editing (2026-11-11)

The current owner can update an existing schedule through Telegram or the web
panel. The user explicitly extended owner-only definition edits to panel
administrators and deployment operators. Panel Save now rejects another owner's
or an unlinked identity's edit before mutation, including through the shared
proposal service. Authenticated list/detail projections expose `canEdit` only
for the active linked owner; cards/details hide Edit otherwise. Saved details
stay readable, and the owner editor retains modal display separation, pending
locks, version checks and failed drafts. Ownership-denied saves explain the
identity requirement. Existing administrator inspection and lifecycle controls
remain separate from definition editing.

The Telegram path reuses one workflow identity and its history; workspace
owner/admin roles do not bypass its ownership check. Deterministic regressions
cover ordinary members, workspace admins/owners, unlinked panel accounts,
direct API attempts, unchanged state/audit on denial and successful own edits.
UI coverage checks lists/details and retained denied drafts at 1280px and 390px,
with owner restrictions in both themes. This change is local pending rollout;
no deployment, live model call or Telegram message was performed.

Validation passes **1,448 deterministic tests across 152 files** and **35 admin
and workflow browser scenarios**. The final workflow render pass also passes all
18 scenarios. Desktop/mobile owner and non-owner summaries, editors,
loading/empty/read errors, pending saves and retained denied/conflicting drafts
were visually inspected; owner restrictions were inspected in both themes.
Biome, strict TypeScript, build and the Node runtime contract pass, including 16
startup cases with zero external startup calls. No dependency or migration was
added. The panel's workspace authority and its linked editor identity remain
separate, so an authorized operator linked to an ordinary active member can edit
that member's own workflow without borrowing another member's identity.

## Telegram features through ordinary chat (2026-11-11)

The worker removes the previously published default, private-chat and group-chat
command lists instead of publishing new slash-command menus. Cleanup retains
credential-rotation checks, cancellation and Telegram retry backoff. Legacy typed
handlers and platform-generated Start/deep-link payloads remain compatible.

Executor exposes `manage_telegram` for explicit current conversational requests:
repository pickers, personal GitHub/Google connections, task status/cancellation,
workflow management, saved instructions, usage, settings and privacy. The adapter
uses the existing handlers under the workspace transaction, binds the actual
requester and retained message, rejects scheduled/forwarded/unconsumed requests,
and checkpoints tool arguments/results to deduplicate retries. Private account
boundaries, administrator roles and approval/account-confirmation gates remain.
Control messages keep their original Topic. Status/cancellation does not select
the helper run itself; a direct “Please stop” also cancels without a model call.

Help and recovery text use ordinary requests. Members without a selected workspace
receive membership-scoped selection buttons. Administrators can request a native
group-invitation link rather than type the linking command. Telegram supplies its
payload; the existing token, membership and group-administrator checks still apply.
See [chat request examples](../user/commands.md), [UI preference](../design/ui-rules.md#telegram-features-use-ordinary-chat)
and [manual acceptance](../../examples/telegram-chat-controls.md).

Local verification: the full PostgreSQL-backed suite passed **1,442 tests across
152 files**, followed by **214 focused tests across six files** after the direct-stop
change. Follow-up coverage includes ordinary ingress → Executor →
durable picker delivery/callback, account identity/Topic, duplicate/conflicting
calls, revoked/private/admin boundaries, workspace selection and direct stopping.
Biome, strict TypeScript, build and the Node runtime contract pass, including
16 integration-startup cases with zero external startup calls. Tests use fake
models/providers/Telegram transports. The initial implementation made no live account/message action; the subsequently
authorized deployment and read-only menu verification are recorded above. Real-model intent selection and native desktop/mobile menu and
button rendering remain live acceptance checks; deployment of the updated worker
is required to clear a running bot's existing menu.

## Telegram workflow revisions and duplicate repair (2026-11-11)

The Telegram schedule tool now accepts an existing workflow ID and expected
version for explicit revisions. Scoped context supplies owner/version metadata;
the prompt uses in-place updates for requested changes. The service checks
ownership, current chat/Topic, version and permissions, retains one workflow and
its spec history, and cancels queued old work/output in the same transaction.
Paused workflows stay paused. Durable confirmations identify updates and keep
the existing interruption/replay protection.

The reported production duplicate was repaired separately through the existing
workflow lifecycle service: the old text report is deleted, and the Widget report
remains active at 08:00 Asia/Taipei, next due 2026-11-12T00:00:00Z. The general
code correction remains local pending rollout. No Telegram message or live model
call was made. See the [incident and repair evidence](../../postmortem/2026-11-11-workflow-replacement-duplicate.md).

All **1,443 deterministic tests across 152 files** pass. Focused validation passes
all 82 schedule/context/system checks, including the
production Executor/Pi/Store/DeliveryWorker path, repeated execution and scheduler
ticks, old-output cancellation, paused updates and rejected stale, deleted,
other-owner, other-workspace, other-chat/Topic, historical and denied-source
requests without partial changes. Biome, strict TypeScript, build and the Node
runtime contract pass, including 16 startup cases with zero external startup
calls. An initial full run hit the independent plain-Stop control regression;
that suite passed in isolation and the full rerun passed. No dependency or
migration was added.

## Immediate workflow activation deployed (2026-11-11)

Authorized bundle `1794371404708-33447708` deploys source `d1ee70db29d5114764f9027796f03a28f79417d0`
with main commits `776d96c` and `dffb66b`. The preserved production snapshot passed
1,487 tests across 158 files, 29 browser scenarios, all required quality checks
and exact-image startup/Compose/restore checks. All five services are healthy;
55 artifacts and current HTML asset URLs verify; the known Cloudflare bare alias
is recorded separately. Existing
configuration, credentials, mounts and PostgreSQL are preserved. The protected
backup archive verifies. See [deployment evidence](vps-deployment.md#immediate-schedules-and-workflow-owners-deployed-2026-11-11).

## Immediate schedules and owner profiles (2026-11-11)

Explicit Telegram schedule requests now activate immediately, without requester
or administrator approval. The existing `propose_workflow` tool name is retained
for compatibility; its description and required `requestQuote` document the new
behavior. Creation requires a current interactive request, its exact quoted text,
current membership and destination/repository permissions. Old conversation data,
scheduled runs and unconsumed input cannot authorize another schedule.

The tool commits an activation marker with the workflow. Pi stops after that
effect, and Executor publishes one application-owned confirmation in the original
chat/Topic, with recurrence, timezone, destination and upcoming times. Interrupted
execution recovers the committed outcome without another model call or tool
replay. Duplicate tool IDs bind to the same arguments; conflicting replays fail.
Activation content is removed with derived run content and retention. Internal
authorization/version audit records remain; there is no pending human decision.

Workflow list/detail APIs project the same workspace's saved owner name, username
and Telegram ID. Cards reuse the shared identity component and fall back to the
numeric identity when profile fields are unavailable. Panel Save applies exact
edits directly, retaining paused state, version checks and execution ownership.
Workflow proposals no longer appear in the panel approval list. Cards show only
the lifecycle action appropriate to their current state; New remains absent.

Legacy repeated Telegram approval controls report their saved decision without
changing it. Private confirmations preserve the original Topic. Rejected controls
have specific recovery messages and safe workspace/run diagnostics. See the
[VPS investigation](../../postmortem/2026-11-11-workflow-approval-feedback.md): the
reported schedule was active; older logs do not establish the exact later error.

Verification: **1,422 deterministic tests across 151 files**, **29 admin/workflow
browser scenarios**, Biome, strict TypeScript, build and the Node runtime contract
pass, including 16 integration-startup cases with zero external startup calls.
The final focused activation/recovery and agent checks pass. Desktop/mobile
saved summaries, missing profiles, loading/empty states and pending/failed editors
were visually inspected; owner summaries were checked in both themes. Initial
broad checks hit disposable-database setup timeouts; isolated reruns with test-only
storage settings pass. No dependency or migration was added. The initial VPS investigation was
read-only; the subsequently authorized rollout is recorded above.

The isolated upstream commit preparation additionally passed **1,445 tests across
153 files**, lint, strict types, build and the Node runtime contract. Deployment
uses a separately verified snapshot based on the current production source.

## Standard text for private Topic recovery (2026-11-10)

The explicitly opted-in main-chat recovery now uses `sendMessage` with existing
text entities, including links. The user confirmed a plain main-chat diagnostic
visible; this change chooses that transport for recovery without attributing the
native Topic outage to rich formatting. The decision is persisted before sending
and applies to rich intents queued by an older worker. Native Topic routing and
ordinary rich replies keep their existing behavior. See
[the recovery contract](telegram-topic-fallback.md).

All 1,479 deterministic tests, lint, types, build and exact-image runtime/Compose/
restore checks pass. Release `1794305442311-77002991` is deployed. A saved answer's
standard-text main-chat delivery is API-confirmed without rerunning its model;
its user-visible acceptance is pending. The independent plain diagnostic is
user-confirmed visible. Native Topic restoration remains blocked externally.

## Scoped private Topic delivery recovery (2026-11-10)

Ordinary run results/failures can recover from a confirmed Telegram 400
`message thread not found` into the same member's main private chat, after explicit
member consent recorded by the host operator. Default routing stays Topic-bound.
Bot-bound consent and current access are rechecked after worker restart; unknown
sends are never replayed. Delivery receipts preserve the logical Topic and record
the actual send destination. See [operation and boundaries](telegram-topic-fallback.md).

All 1,478 deterministic tests, lint, types, build, offline runtime and exact-image
Compose/restore checks pass. Release `1794301988625-49496411` is deployed; Telegram
accepted the existing saved answer in the opted-in main private chat (HTTP 200),
with its original logical Topic preserved and actual destination recorded. The
original Topic remains rejected; missing upstream input is not recovered.

## Incoming Telegram rich-message text (2026-11-10)

Normalize displayed incoming rich-message content before the webhook/polling
schema strips unknown fields. Private Topic paragraphs, formatted text, edits and
replied-to references use the existing bounded text/entity route. Legacy text and
captions take precedence. Hidden URLs, buttons, widgets and quoted commands or
mentions grant no additional authority. Membership, audience, provenance and
duplicate-update checks remain enforced. Production-composition regressions cover
authenticated rich input through deterministic execution and Topic delivery,
including duplicates and inactive members. Native Telegram confirmation remains
pending; see the [incident record](../../postmortem/2026-11-10-telegram-rich-input.md).

## Proactive Telegram widget selection (2026-11-11)

The default Telegram widgets preset and eligible private-run prompt now direct
the model to choose useful visual comparisons, diagrams, local calculators and
scenario exploration without an explicit widget request. Simple answers and
text-only requests use text; rendering instructions load only after selection.
Current run restrictions, private bot-thread identity and the pinned skill's
tool/guide availability gate the reminder. Existing delivery permissions remain.

Unchanged application-owned original presets receive one new immutable snapshot
on workspace read and persist it on the next change. Updates preserve IDs,
disablement, full catalogs and old run/workflow pins; custom collisions, edited
instructions, imported skills and archived/deleting records are left intact.
See [implementation details](telegram-widgets.md) and the expanded
[manual selection scenarios](../../examples/telegram-widgets.md).

Validation: all **1,417 tests across 151 files** passed with disposable PostgreSQL,
including all 19 focused widget tests, production Store upgrade/restart and
ordinary cost-question ingress/executor coverage. The larger pinned instructions
required more headroom in two compaction fixtures; both still assert initial
compaction and no immediate repeat after a completed batch. Repository-wide
Biome, strict TypeScript, build and the Node runtime contract passed, with 16
startup cases and zero external startup calls. Tests use fake models and Telegram
transports; real-model selection and native rendering remain staging checks. No
deployment or live Telegram/model call was performed.

## GitHub fixes continue the original Telegram coding task (2026-11-01)

Confirmed PR publication now records an installation/repository/PR/branch binding.
With Review Bot requests and fixes enabled, an explicit fix from the original
requester's verified GitHub account appends a deduplicated input revision to the
same durable development task. Codex intake determines its implementation grant;
the existing attempt fences, verification and same-PR publication rules apply.
Read-only comments, other collaborators and unbound historical PRs retain Review
Bot routing. A stopped bound task cannot be revived through GitHub.

GitHub inputs retain their author, full-body fingerprint, fix-policy revision and
expiry separately from Telegram messages. Source reads happen outside workspace
transactions; current membership, fix policy and Review Bot routing ownership are
checked again at execution/publication. Changed, inaccessible or foreign-PR
sources stop work; transient source failures retry the same task without duplicate
execution. Inline replies supply their parent review as reference data. No private
Telegram result or question is automatically posted to GitHub. Status, delivery
and Mini App history retain the original Telegram audience, and source erasure
removes the external inputs with the task. No dependency or SQL migration was added.
Publication also requires the current work phase: a previous revision's grant
cannot publish a new follow-up while its intake is still pending.

The deterministic journey covers Telegram task creation and confirmed publication,
signed GitHub follow-up, executor reconstruction, same-PR update, original-audience
delivery intents, Pi task context and the Mini App history API. It also covers
duplicates, revoked sources/permissions, policy changes during source verification,
routing ownership changes, outages, inline references, fallback routing and erasure.
Validation on an isolated commit snapshot excluding unrelated working changes
passed Biome, strict TypeScript, build, **1,373 tests across 148 files** with
disposable PostgreSQL and a 15-second deadline, including **40 Review Bot
integration tests**. The built Node runtime contract passed all 16 plugin-startup
cases with zero external startup calls. Documentation links and whitespace checks
passed.
Live model interpretation, webhook delivery and native Telegram acceptance remain
pilot checks. See [the repeatable journey](../../examples/cross-channel-coding.md).

## Telegram bot token format errors provide recovery guidance (2026-11-10)

Bot-token format validation now belongs to the credentials field schema, keeping
the `botToken` issue path through the production API error handler. HTTP 400
retains the `invalid_request` code and includes a safe message asking for a token
from `@BotFather`, with a numeric-ID/colon example. The shared web client displays
that message in the Telegram setup form and Manage Telegram bot dialog without
the raw field name. Neither the API nor its error message echoes the submitted
credential. Existing empty/omitted-token retention and the 200-character limit
remain supported; well-formed values still require upstream identity verification.

Production-composition regressions prove malformed values make no Telegram calls,
leave deployment state and credential audit records unchanged, and preserve the
operator permission check. Browser coverage verifies readable messages, retained
drafts, unlocked recovery controls and successful correction in both flows. Their
error states were visually inspected at 1280px and 390px; the saved bot summary
remains unchanged while an invalid replacement is rejected.

Validation: lint, strict TypeScript, build, the Node runtime contract (16 startup
cases, zero external startup calls), all **1,409 deterministic tests across 151
files**, and the focused first-visit browser journey pass. No dependency or SQL
migration was added. This correction is local; it has not been deployed to the VPS.

## Telegram widget tool and bundled preset (2026-11-10)

Added `send_telegram_widget` and the default-enabled, read-only **Telegram widgets**
preset, with a bundled `SKILL.md` and supporting rendering guide. Existing tenants
receive the preset without changing current run pins, disabled records or slug
collisions. The tool stages one self-contained presentation for a private chat or
Topic; only a successful answer atomically publishes its durable delivery.
Groups, schedules, shared widgets, wallet operations and widget-to-bot queries
are outside this implementation. Local controls can explore a chart or estimate.

Delivery rechecks audience, source permissions, bot identity and skill grants;
confirmed Telegram rejections fall back to a useful caption while unknown sends
remain unreplayed. HTML follows existing private Browser encryption and source
erasure. See [implementation and verification](telegram-widgets.md) and
[conversation examples](../../examples/telegram-widgets.md).

Validation: Biome, strict TypeScript, build, skill validation and the Node runtime
contract passed. All 15 focused widget/preset tests and all 13 browser scenarios
passed; desktop/mobile preset, pending/error and local widget example screenshots
were inspected in light/dark themes. The exact Docker image passed its 16-case
startup contract with zero external startup calls, migrations, API health/readiness,
admin HTTP and worker-heartbeat smoke checks; Compose configuration validated.
The final full suite recorded 1,406 passes and one unrelated intermittent Git
index mismatch in `codex-job-command.test.ts`; its four tests passed immediately
in isolation. That file was not changed. Native Telegram desktop/mobile rendering
and real-model widget quality remain staging checks. No production deployment or
live Telegram message was performed.

Commit-only verification based on upstream `a8dba53` excludes unrelated local
edits and passes all **1,438 deterministic tests across 153 files**, Biome,
strict TypeScript, build, the 16-case offline Node runtime contract and all
**13 widget/preset browser scenarios**. The upstream Git fixture correction
also removes the intermittent index mismatch seen in the earlier working-tree run.

## Provider save errors distinguish HTML gateway responses (2026-11-09)

The admin request client now retains the HTTP status when a response cannot be
parsed as JSON. Malformed success responses show an unexpected-response error;
HTML 502/503/504 pages outside provider saves use a temporary RepoDesk server error.
Provider-save gateway errors now identify the model fetch and suggest checking
the API base URL and network access from the RepoDesk server. JSON discovery
failures use the same recovery guidance; API-key rejection keeps its specific text.
This wording follows the user's subsequent request to improve the dialog error.
Provider New/Edit dialogs retain drafts, unlock their controls after failure and
keep explicit retry behavior. Session expiry and request cancellation retain
their existing behavior.

Malformed upstream model JSON now produces `model_discovery_invalid`, and runtime
logs preserve allowlisted discovery codes without response bodies or credentials.
Production-composition regressions cover HTML model responses, safe JSON errors,
operator-owned state preservation and sanitized diagnostic codes. The model-list
Bearer header, trailing-slash normalization and optional anonymous New API pricing
remain unchanged and match the current official endpoint documentation.

Validation: lint, strict TypeScript, the production build, the Node runtime
contract and all 1,424 deterministic tests passed with disposable PostgreSQL.
All 35 provider/session-expiry browser scenarios passed, including readable
gateway/discovery errors, distinct key rejection and retained drafts on retry.
Saved summaries and New/Edit pending/error states were inspected at 1280px
and 390px, including mobile scrolling to Save/Cancel and successful draft recovery.

VPS follow-up reproduced Node `UND_ERR_CONNECT_TIMEOUT` from the running app
container with the user-supplied key, before an HTTP response. The host also
could not reach the provider's agreed DNS address, 114.55.242.113, on ports 80/443,
while GitHub and Cloudflare connectivity worked. App health/readiness remained
successful, with zero container restarts. Local authenticated discovery through
the workstation proxy returned 200 and 14 models. A provider filtering/routing
cause remains unconfirmed; a reachable endpoint or approved proxy is needed.
The VPS outbound IPv4 address was verified as 169.58.58.71. Follow-up validation
passed 21 focused metadata/provider tests (including connect-timeout New/Edit
failures), lint, strict types and the build.
See the [incident record](../../postmortem/2026-11-09-model-provider-html-gateway.md).
The subsequent operator-authorized deployment installed bundle
`1794210552528-53347667` from production-based snapshot `44a76df`. It preserves
existing production fixes and runtime dependencies. All 1,432 deterministic tests,
35 browser scenarios, exact-image startup and disposable Compose/restore checks
passed; the protected backup and 51 deployed artifacts verified. Services are
healthy and configuration, credentials and persistent mounts are preserved.
See the [deployment record](vps-deployment.md#provider-error-dialog-deployment-2026-11-09).
No network settings changed, and no model inference, account connection or manual
Telegram send was performed.

## Scheduled workflows omit web creation (2026-11-05)

Removed the Add workflow action, creation dialog and creation-only state from
Scheduled workflows. Existing saved summaries, details, modal editing, approvals
and lifecycle controls remain available. New schedules can still be proposed
through Telegram or the API. The heading has no empty action wrapper.

Validation: lint, strict TypeScript, the production build and all 1,392 deterministic
tests passed with disposable PostgreSQL. All 25 workflow and admin browser scenarios
passed. Desktop (1280px) and mobile (390px) screenshots
were inspected for populated, loading, empty and failed lists, plus editing,
pending saves and retained drafts after save failures.

## Browser thread recovery and stable worker readiness deployed (2026-11-05)

Release `41965848447-1`, source `726a45ab26885f17bd0236c967a87461f820f0f3`,
is verified on the VPS. Browser expiry feedback and authenticated retries retain
the original task while requiring fresh decisions. An independent, serialized
five-second worker heartbeat prevents slow maintenance from falsely marking the
worker unavailable; shutdown drains the heartbeat and removes its record.
The new production-composition readiness regression fails before the correction
and passes afterward, including unavailable readiness after shutdown.

Lint, strict types, build, all 1,431 deterministic tests across 154 files and the
Node runtime contract pass. Exact-image startup reports 16 cases with zero
external startup calls. Compose, CPU speech, offline Code Truth, migration and
backup/restore checks pass. All 51 deployed artifacts match, app/worker/runner and
Code Truth are healthy, and eight post-cutover samples retain ready status with
heartbeat age 2.61–4.51 seconds. Configuration, secrets and persistent state are
preserved. No dependency or SQL migration was added. See the
[incident and rollout evidence](../../postmortem/2026-11-05-browser-approval-expiry.md).

## Browser status and continuation retain the original task (2026-11-04)

Short private status/continue controls use current task state, and concurrent
Browser observers cannot acquire, navigate, refill or create another approval in
the same Topic. Explicit continuation of expired Pi work retains the original
run and transcript with current authorization and fresh decisions. Wait notices
name their kind, safe website and operation; terminal Browser waits get a durable
explanation. Status delivery refreshes its facts and obsolete notices are fenced.
Confirmed-safe transport retries refresh both status text and the Browser link;
continuation checkpoints retain the current goal and the attributed human input.
The final send check durably refreshes requested replies after task transitions
and cancels them after revocation, with attempt and audience ownership preserved.

Denied-origin recovery preserves the session and unavailable receipts without
replaying effects. Download status requires a saved nonempty file with a matching
size; partial/oversized copies are removed. Three incident regressions fail on
the previous `main`; production-composition, scope and real-DOM/file cases cover
the correction. See [implementation and release limits](browser.md#paused-task-coordination-and-recovery-2026-11-04)
and the [incident](../../postmortem/2026-11-04-browser-task-contention.md).
No VPS change, Telegram message or historical task replay was performed.

Validation passes lint, strict TypeScript, build, all 1,423 deterministic tests
across 151 files, the 16-case Node startup contract with zero external startup
calls, and 17 focused browser scenarios including desktop/mobile states and
native recovery/download cases. Code Truth catalog regeneration and its service
smoke pass without a catalog diff. No dependency or SQL migration was added.
Native Telegram rendering, the exact packaged headed-host smoke and coordinated
VPS deployment remain release checks.

## Browser approvals confirm continuation in Telegram (2026-11-04)

Successful Browser approvals and secure-input completion queue one short Telegram
confirmation in the originating user's chat/Topic when the task can continue.
Pi, authorized file plugins and Codex retain their existing task and context.
The confirmation is atomic with the saved continuation and deduplicated by request;
delivery rechecks authorization and suppresses stale notices after another wait,
completion or cancellation. Failed/uncertain Browser operations do not claim
success. See [Browser implementation](browser.md#telegram-continuation-confirmation-2026-11-04).

Lint, strict TypeScript, build, the Node runtime contract and all 1,392 deterministic
tests across 149 files pass with disposable PostgreSQL and a 15-second deadline.
The 21 focused Browser integration tests pass. No dependency or SQL migration was
added. Production deployment and native Telegram desktop/mobile rendering remain
unverified for this change.

## Browser chat repair on VPS (2026-11-02)

Release `41406054824-1` deploys the confirmed YouTube redirect-consent correction,
partitioned-cookie compatibility and cancellable Code Truth initialization wait.
The original public URL reports its missing consent origin while retaining the
session; a synthetic grant then permits navigation/read. Current-authority source
reading of street-polls succeeds. The historical Telegram run and its website
grants were not rewritten or replayed.

The release snapshot passes 1,380 tests; the isolated main repair passes 1,383,
with lint/types/build and the 16-case offline Node startup contract. Exact VPS
images, native redirect/cookie/routine-action/submission gates, public assets,
backup and existing API/worker Browser connections pass. Real website consent and
cookie choices remain member decisions. See [deployment evidence](vps-deployment.md)
and the [incident](../../postmortem/2026-11-02-browser-partitioned-cookie.md).

## Ordinary assistant runs have no total execution deadline (2026-11-02)

The 300-second executor deadline and `RUN_TIMEOUT_SECONDS` setting are removed;
older environment values are ignored. Queue wakeups are acknowledged before
execution, so pg-boss dispatch expiry no longer bounds assistant runtime. Three
local execution slots, renewable fenced leases, cancellation, authorization,
spending budgets and shutdown interruption remain. The durable outbox recovers
acknowledged wakeups after a crash; uncertain provider attempts stop for
reconciliation. Historical terminal runs are not automatically retried.

Deterministic regressions cover long analysis, duplicate dispatch, live leases,
acknowledgement/claim crashes, unknown provider usage, concurrency, cancellation,
revocation and shutdown through the production dispatch/Executor composition.
Biome, strict TypeScript, build and **1,352 tests across 144 files** passed with
disposable PostgreSQL and a 15-second test deadline. All seven new dispatch/run
regressions passed. The built Node runtime and exact Docker image passed all 16
plugin-startup cases with zero external startup calls. Compose configuration,
image migrations, HTTP health/readiness/admin checks, worker heartbeat and clean
app/worker shutdown passed. The authorized VPS rollout used isolated snapshot
`14d28d0` on the previous production source, with 1,354 passing tests across 147
files. Bundle `1793607782072-26985359` passed backup, checkpoint, exact-image,
51-artifact and public HTTP verification; existing Browser code and persistent
state are preserved. Historical failed runs were not replayed. See the
[incident](../../postmortem/2026-11-02-assistant-run-timeout.md).

## Remembered Browser websites and Pi-led execution (2026-11-01)

Site consent now persists per exact HTTP(S) origin in the encrypted member/workspace
profile, independently of tasks and temporary control leases. The member page
labels consent **Allow website**, shows **Allowed websites** as saved summaries,
and supports revocation. Approval saves immediately; closing and service
reconstruction retain the choice. Revocation atomically removes consent, cancels
pending re-grants and fences current work. Legacy temporary grants and already
approved legacy requests retain their old scope/expiry. Membership, consumer/plugin
authorization, configuration generation and profile epochs remain current checks.

Pi's conversation and tool guidance keep website work in the originating run.
Host inspection allows ordinary fills, native link navigation and focus keys on
remembered sites. External effects retain explicit page-bound approval; buttons,
Enter, pointer clicks and uncertain controls conservatively wait. Link navigation
bypasses unreviewed page click handlers. Auto-saving fields require the explicit
external-effect flag; arbitrary application behavior cannot be inferred from DOM
inspection alone. Codex can still use Browser inside authorized coding work.

Validation in the full development workspace: lint, strict TypeScript, build and
the Node runtime contract pass,
including 16 startup cases with zero external calls. **1,378 deterministic tests
across 148 files** pass on disposable PostgreSQL with the default deadline.
**15 browser scenarios** pass: 12 desktop/mobile UI journeys and three real-DOM
interaction tests. Saved/empty/loading, pending/error revocation and both themes
were visually inspected. The bundled Code Truth catalog was regenerated without
a content diff and its service smoke passed. The current native package also
passes the real headed-host smoke, including automatic routine operations and
blocked unapproved submission, on the previously provisioned test runtime (the
fresh Debian download stalled). This consent follow-up adds no dependency or SQL
migration beyond the Browser baseline below. The coordinated application/native protocol is deployed; the latest repair is
`41406054824-1`, as recorded above. Live Telegram/model/site-account acceptance
remains separate from synthetic deployment probes. See [implementation details](browser.md).

Commit-only validation on `main` excludes unrelated working changes and passes
1,363 deterministic tests, lint, strict types, build, 17 Browser/catalog scenarios
and the offline Node 24 application-image runtime contract. The source commit
includes the Browser baseline needed on `main`; no production deployment was run.
