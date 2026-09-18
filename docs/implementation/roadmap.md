# Implementation roadmap

Status as of 2026-09-18. Only milestone 0 is implemented.

Use [the Pi + Docker implementation plan](bot-plan.md) for concrete work slices.
Pi is selected for AI; Docker replaces the original Cloudflare deployment proposal.
The admin web panel, first-run admin/bot setup and skill management are required
for P0 and share services with Telegram commands.

| Milestone | Deliverable | Dependencies | Exit criteria |
| --- | --- | --- | --- |
| 0 — Foundation | Git repo, Bun/Hono/Node scaffold, Docker image and Compose, code quality commands, source-linked docs | None | Local checks and Docker smoke test pass; implemented scope stated accurately. |
| 1 — Telegram transport | Webhook authentication, validated updates, durable inbox/outbox, private `/start` and `/help`, chat binding | Bot credentials and persistent storage design | Unauthorized updates rejected; duplicate updates create one job; crashes do not lose acknowledged events; group claiming verifies admin. |
| 1A — Admin foundation | First-run local admin, resumable setup, optional Telegram login, roles, configuration API and panel | Workspace identity and database | Config changes persist and are audited; cross-tenant access and stale writes are rejected. |
| 2 — First useful task | Pi runtime with bounded tools, received-message context, manual recap, source links, usage ledger | Model choice, workspace isolation, permitted test data | Repeatable evaluation cases pass; coverage gaps visible; budgets enforced; right chat/topic delivery. |
| 3 — Recurring recap | Workflow drafts, approval callbacks, schedule preview, pause/edit/resume, durable occurrence execution | Milestones 1–2 | Timezone/DST tests pass; duplicate triggers do not duplicate logical runs; revoked access blocks work. |
| 4 — Compound behavior | Explicit shared instructions, correction proposals, versions, run history, deletion | Stable workflow model | Next run adopts approved correction; private memory remains private; deletion survives retries. |
| 4A — Agent skills | Web catalog/editor/import, validated settings, versioned publication, runtime loading, enable/disable | Pi and workflow model | Skill changes work through the UI; permissions hold; runs pin versions and disabled skills block dependent work. |
| 5 — Team pilot readiness | Retention jobs, operator controls, diagnostics, failure recovery, review of permissions and costs | Milestones 1–4 | F01–F06 and F10–F13 P0 criteria pass; Telegram and admin-panel end-to-end pilot succeeds. |
| 6 — Connected team beta | One read-only connector, multi-chat workspace, file intake, blocker/follow-up templates | Pilot demand and OAuth design | Delegation and source/destination checks pass; connection revocation interrupts dependent jobs. |
| 7 — Proactive assistance | Explicit monitoring, suggestion digest, remembered rejection, noise controls | Measured context quality | Useful suggestions without automatic activation; no monitoring after revocation; notification budget enforced. |
| 8 — Expansion | Executable skill extensions, Mini App if needed, additional connectors, controlled writes, billing | Usage evidence and commercial decisions | Separate design/evaluation for each addition; payment policy verified before charging. |

## First implementation slice

Implement one private command end-to-end before introducing model orchestration:
authenticated update → durable acceptance → deduplicated dispatch → command result
→ rate-aware delivery → persisted outcome. Use a fake Telegram adapter in local
tests. A real bot token is needed only for the authorized integration check.

Then add one group recap path and measure whether it is useful. Avoid shipping a
generic tool marketplace, CRM outreach, browser automation and billing in the same slice.

## Pilot release checklist

- Enforce tenant/actor/source/destination authorization in code outside the model.
- Verify webhook secret handling and reject malformed/oversized input.
- Exercise retries, restart recovery, stale callbacks and scheduler duplication.
- Confirm messages and artifacts go to the intended chat and topic.
- Enforce per-run and workspace cost limits with concurrent-run tests.
- Validate history coverage, source links and honest partial-result behavior.
- Confirm monitoring consent, retention sweeps, unlink and deletion cancellation.
- Record provider/model data handling and operational support access.
- Make pending limitations visible in `/help` and the user guide.

No calendar estimates are assigned yet; connector selection and pilot group needs
will materially affect the later milestones.
