# Autonomous Skill Extraction and Scope Classification

Status: **Implemented locally** (2026-11-21). See
[implementation evidence](../implementation/implementation-status.md) for verified
scope and test results.

## Product principles

1. **Minimal review, AI-first autonomy:** Instruction skills are procedural memory
   and never grant tools, credentials, or external write authority. Rather than
   gating every extracted skill behind manual drafts and multi-step approval queues,
   RepoDesk runs deterministic server-side safety rails and activates extracted
   skills automatically (`enabled: true`), relying on post-hoc exception management
   (edit, reclassify, disable, archive) when an admin wants to intervene.
2. **Two-tier classification (`Global` vs `Project`):**
   - **Global (`scope: { kind: "global" }`)**: Reusable cross-project workflows,
     reporting formats, triage playbooks, and universal engineering rules usable
     anywhere in the workspace.
   - **Project-specific (`scope: { kind: "project", repositoryId, repository? }`)**:
     Bound to a connected GitHub repository's numeric ID (surviving renames).
     Applies only when working in that repository's context (repository-bound
     groups, selected/targeted repositories, workflows, Codex tasks, and Review Bot)
     and enforces current repository read access.
3. **Audience targeting (`chat` | `coding` | `all`):** Skills declare whether they
   apply to interactive Pi chat/workflows (`chat`), Codex/Review Bot runs (`coding`),
   or both (`all`).

## Extraction pipeline

`SkillExtractionService` (`src/skills/extraction-service.ts`) mirrors
`MemoryService`'s durable, lease-fenced background architecture and runs on an
independent worker timer (`src/jobs/queue.ts`) without sending unsolicited Telegram
messages.

### Signal gates (zero-cost filtering)

Before invoking any model, deterministic gates in `src/skills/extractor.ts` and
`src/skills/extraction-planner.ts` filter out noise:

1. **Completed/review-ready Codex tasks (`coding_task`, highest priority):** Tasks
   in `review` state with non-removed content and substantive results—especially
   multi-attempt repair runs (`attempts > 1`), `investigation`/`release` objectives,
   or verified command outputs.
2. **Completed multi-step Missions (`mission`):** Missions with multiple artifacts,
   child coding tasks, wakeup continuations, or substantial outcomes.
3. **Idle high-signal conversations (`conversation`):** Idle threads (10 min
   default) with at least two user and two assistant turns plus tool usage,
   `load_skill` usage, or explicit refinement/procedure cues. Threads containing
   private Browser runs are excluded.
4. **Direct conversational saves (`save_skill`):** Users can still ask Pi in chat
   to remember a workflow or project rule directly; `save_skill` creates or updates
   an enabled skill immediately without Telegram approval buttons.

### Autonomous decision & self-evolution

The extractor inspects the current workspace skill catalog (slug, name,
description, scope, audience, editability) and any admin-suppressed topics, then
returns strict JSON choosing:

- `noop` — one-off details or suppressed topics (silently skipped).
- `create` — creates and atomically publishes & enables a new `auto` skill.
- `update` — appends a new immutable version to an existing editable skill while
  preserving existing workflow version pins and never re-enabling a skill an admin
  explicitly disabled.

### Deterministic safety rails

- **Zero privilege escalation:** Auto-extracted skills are restricted to safe
  non-escalating tools (`read_chat_context`, `read_instructions`, `load_skill`,
  `query_chat_history`, `query_work_handoff`).
- **Secret & prompt-injection rejection:** Rejects private keys, API keys, bot
  tokens, binary content, and prompt-injection/override phrases; strips
  `[source:...]` citations and redacts sensitive patterns.
- **Deterministic scope guard:** If a coding task or repository-bound source
  references repository-specific paths, build/test commands, or the repository name,
  RepoDesk deterministically keeps it `project`-scoped even if the model proposed
  `global`.
- **Protected skill preservation:** Automatic updates never overwrite `preset` or
  `githubSource`-managed skills.
- **Suppression memory:** Disabling or archiving an auto-extracted skill records a
  suppression entry (slug + normalized title in that scope) so the extractor does
  not regenerate the same skill.
- **Capacity & usage metering:** Caps active auto-extracted skills at 50 (within
  the 100-skill workspace limit) and meters all extraction calls under
  `sourceKind: "skill_extract"` in `model_usage_events`.

## Runtime consumption

1. **Scoped run pinning (`src/workspaces/service.ts`):** Interactive runs pin only
   enabled `chat`/`all` skills matching `global` or the run's active repository IDs
   (after checking current repository read access).
2. **Progressive disclosure (`src/agent/context.ts`):** When a workspace grows
   beyond 3 skills or includes auto/project skills, interactive runs inject compact
   index entries (`id`, `slug`, `name`, `description`, `scope`, `audience`,
   `loadOnDemand: true`) instead of full bodies. Pi loads full instructions on
   demand via `load_skill` (which rechecks project access and increments usage
   counters). Built-in presets and explicitly pinned workflow skills remain inline.
3. **Codex & Review Bot cold-start briefing (`src/skills/coding-briefing.ts`):**
   Enabled `coding`/`all` skills for the target `repositoryId` (project skills
   prioritized ahead of global coding skills) are compiled within a byte cap into
   the `DevelopmentRun.memory` briefing for Codex tasks and Review Bot runs.
