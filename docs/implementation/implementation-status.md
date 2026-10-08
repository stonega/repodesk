# Implementation evidence

## Codex follow-up intent routing, 2026-10-08

Ordinary messages in a private or linked-group Topic now enter Pi even when a
Codex task is working, waiting or ready for review. Pi chooses between answering
with permitted read tools, continuing clear changes to the matching task/PR, and
starting a separate coding goal. PR reviews and explanations no longer resume
Codex automatically. Metadata alone is not presented as a code review.

Direct ingress remains for explicit task controls, replies to the confirmed notice
for the current Codex question, and edits/duplicates of accepted task inputs.
Unanchored answers receive Pi intent handling. Explicit Pi continuations record
their task handoff so native Stop and completion notices follow the correct task.
Actor, workspace, bot, chat/Topic, source and repository boundaries remain checked.

Biome, strict TypeScript, production build and the full deterministic suite passed
with disposable PostgreSQL and loopback proxy bypass. Coverage includes private
and group Topics, ordinary/old-result replies, duplicate events, question/media
answers, task-input edits, original-wording continuation on the same PR, multiple
tasks and cancellation. These checks establish routing and authorization, not live
model intent accuracy. No dependency, migration, deployment or live external call
was added. See [routing contract](../design/codex-collaboration.md#task-lifecycle-and-conversation)
and [staging journey](../../examples/telegram-feedback.md).

## Codex PR readiness, 2026-10-08

Successful Reviewed and Direct coding publications now create PRs ready for review.
Verified same-PR follow-ups mark existing drafts ready before confirming success.
Readiness checks bind the PR to the configured repository, branch, base and verified
commit. Lost acknowledgements are not replayed; read-only recovery requires an open,
non-draft PR at that commit. Review Bot fixes retain their existing draft policy.
Settings, approval previews, task status, Telegram notices and current guides use
the updated publication contract.

Biome, strict TypeScript, build, **577 deterministic tests** with disposable PostgreSQL,
all **17 admin browser scenarios**, Docker job/supervisor builds, full fake-provider
Docker lifecycle smoke and Compose validation passed. Mobile settings were visually
checked. Localhost was excluded from the host proxy for local service tests. No live
GitHub, Telegram or model calls, or deployment, were performed.

## Review Bot, 2026-10-07

[Review Bot](review-bot.md) is implemented locally: selected-repository automatic
PR reviews, verified GitHub mentions, read-only answers, checked same-PR fixes,
immediate status, cancellation, question continuation and durable reconciliation.
Webhook secrets/receipts use migration `016_review_bot.sql`; task configuration and
records remain tenant-scoped. Repeated events, source/permission changes, stale
heads, branch rewinds and uncertain outcomes are covered deterministically.

Biome, strict TypeScript, build, **569 deterministic tests** with disposable
PostgreSQL and **97 browser scenarios** passed. App/job Docker builds, migration,
API health, fake-Git PR preparation, Node 24 Pi contract and Compose validation passed.
No live GitHub, Telegram or model call was part of these checks. The development
host's Codex command-sandbox probe failed at bubblewrap namespace/devpts setup;
live review acceptance requires a compatible runner. See the linked setup and
[acceptance journeys](../../examples/review-bot.md).

This dated log records local implementation and verification, including the P0
bot/admin/worker foundation and bounded GitHub paths. Some changes were deployed to
a local Podman stack, but the [primary GitHub journey](../design/github-workflows.md)
has not been validated end to end with live GitHub, model and Telegram operations or
accepted by a pilot team. Each entry states its own test scope and remaining gates.

## Implemented

### Parallel Codex task execution (2026-10-07)

Replaced the single global active-task guard with `CODEX_RUNNER_CONCURRENCY`
(default four, range 1–32), wired through Docker and Podman Compose. Capacity is
reserved before container launch, restored from durable records after restart and
shared across repositories/workspaces. Independent API-key tasks run Codex in
parallel; attempts for the same continuous task remain serialized. User-input and
authentication pauses still release capacity, while excess tasks use the existing
queued retry paths.

Tasks sharing one workspace's managed ChatGPT cache serialize implementation,
repair and auth resume to preserve refreshed credentials. Preparation, setup,
checks and publication can overlap; separate workspace caches run independently.
Queued repairs do not consume an attempt before they can launch. See the
[runner guide](codex-podman.md#lifecycle-and-recovery) for configuration and per-task
resource limits.

Validation: Biome, strict TypeScript, build and **517 deterministic tests across
62 files** passed with disposable PostgreSQL. Six added runner tests cover capacity,
duplicate starts, restart/cancellation, task and tenant isolation, credential-stream
ordering, auth resume and repair scheduling. App, task and supervisor Docker images
built; host/container Node runtime contracts and all three Compose configurations
passed. Docker and rootless Podman smoke verified two simultaneous implementation
containers, capacity rejection and supervisor restart, plus the existing task/auth/
publication lifecycle. External services were fake; no live account, model call,
GitHub write, Telegram send or deployment was performed. No dependency or migration
was added.

### Repository reports, conversation skill drafts and work handoffs (2026-10-07)

Implemented the [accepted R01–R03 plan](team-workflows-plan.md). GitHub reads use
repository-scoped Issues/Pull requests read tokens, bounded pages, canonical links,
retrieval times and merge-time windows. Repository schedules pin source IDs and
connection revision; private group reports require admin audience approval.
Previous complete local calendar days include 23/25-hour DST transitions.
Access changes block reads and queued delivery, including indirect evidence from
older assistant reports.

An owned successful assistant run can produce a sanitized skill proposal. Requester
approval creates a disabled admin-visible draft; existing admin publish/enable
controls make it reusable. Unpublished drafts depend on retained sources; published
procedures have an independent approved-instruction lifecycle. Handoffs batch-read
durable task inputs/context, preserve questions/checkpoints/verification uncertainty,
and include permitted discussion notes. Personal and group/topic boundaries remain
distinct. Added tool context is covered by a compaction regression fix and test.

Validation: Biome, strict TypeScript, build and **502 deterministic tests across 61
files** passed with disposable PostgreSQL. **19 browser scenarios** passed, including
two new desktop/mobile feature checks with visual inspection. The built host Node
runtime contract passed. Added 30 unit/integration tests and two browser scenarios;
these features add no dependency or SQL migration. The final pass includes concurrent
membership/GitHub account edits without reverting them. External services were fake; no deployment,
account connection, live Telegram send, model call or GitHub write was performed.
Live report usefulness, teammate reuse and handoff quality remain pilot checks in
[the runnable examples](../../examples/team-workflows.md).

### Telegram progress and cancellation feedback (2026-10-06)

Implemented the [friend beta feedback plan](telegram-feedback-plan.md). Telegram
uses readable task stages and actionable failures, with durable phase notices,
coalescing and suppression of obsolete progress. Status/cancellation target replies
or the current conversation, with authenticated selection for multiple tasks.
Queued selectors and actions recheck current permissions. Cancellation separates
stopping from confirmed termination; missing runner records and publication in
flight retain uncertainty. Native Stop and original-request cancellation reach a
linked coding task under existing permissions. Pi handoff responses and previews
cannot claim queued coding work is complete. Ordinary cancellation deliveries are
included in scoped admin run details. The Codex panel uses the same readable stages.

The 2026-10-07 follow-up adds inline Status/Cancel controls to coding notices and
long private queue notices, removing repeated command reminders. Longer stages
use short, natural follow-ups. Button taps bind to confirmed sent messages and
recheck current task permissions; acknowledgements clear the native spinner
silently. Local button delivery, routing, isolation, revocation and replay tests
passed as part of the **526-test** suite, alongside Biome, typecheck and build.
New button behavior still needs live Telegram acceptance.

The later 2026-10-07 correction makes routine progress edit the original task
message, including delayed and repeated repair stages. Necessary questions,
actionable blockers, requested receipts/status and final outcomes remain new
replies. Waiting/terminal states close the existing progress message. Durable edits
retain scope and bot checks, serialize, and retry known-message edits safely;
confirmed deleted messages can be replaced once. Unknown original sends are not
replayed. Verification guidance requires complete bounded commands or a repository
script and explains how to report an irreparable frozen-plan blocker. See the
[incident diagnosis](../../postmortem/2026-10-07-progress-flood-and-invalid-verification.md).
This correction is local; the diagnosed live task still has its old frozen plan.

Validation: Biome, strict TypeScript, build and **451 deterministic tests** passed
with disposable PostgreSQL; **25 affected browser scenarios** passed with desktop
and mobile inspection. Application/supervisor/job images built, Node runtime
contract and Compose validation passed, and deterministic container smoke covered
the runner lifecycle with fake external services. Fresh migration/API/worker smoke
passed. No new dependency or migration was added. Live Telegram/model/GitHub beta
acceptance and deployment remain separate steps; see the
[manual acceptance procedure](../../examples/telegram-feedback.md).

### Automatic Codex environment preparation and checks (2026-10-05)

Removed setup/check command configuration from both repository forms and the
execution contract. Codex prepares the environment and selects a bounded
verification plan from repository instructions. The runner captures the plan,
replays it without model/GitHub credentials and checks patch integrity. Repairs
retain the original commands; missing plans and failed checks block publication.
Migration 013 removes stored overrides and invalidates affected old grants.
Older client command fields are discarded rather than becoming hidden overrides.

Local validation before publication: Biome, TypeScript, build, 354 Bun tests,
23 browser tests, pinned CLI protocol, image builds, Node runtime contract,
Compose and real Podman smoke with fake external services passed. Live model
selection quality and the Telegram/GitHub pilot remain separate release gates.
The user requested proceeding to release without additional verification.

### Continuous Codex collaboration (2026-10-05)

Implemented the [accepted plan](codex-collaboration-plan.md) locally. Pi relays
original source messages; Codex interprets intent, makes technical decisions,
asks product questions, implements and repairs failed checks. Repository direct
policy is opt-in; existing settings retain reviewed approvals. The application
persists tenant-scoped inputs, grants, fenced attempts and delivery events, checks
authority again before execution/publication, and enforces cumulative budgets.
Telegram replies and Topic follow-ups continue one task and PR. Waiting releases
the runner; restarts reconstruct retained context. Ambiguous publication outcomes
are reconciled without replaying writes, and expired/deleted sources trigger
private-state erasure.

Validation: Biome, TypeScript, Bun build and **351 Bun tests** passed with disposable
PostgreSQL. All 19 browser tests passed, including reviewed defaults, direct
policy persistence and desktop/mobile layout. The pinned Codex 0.155.1 protocol passed
on the host and in the isolated job image with a local fake Responses provider.
Application, supervisor and job images built; the isolated Node runtime contract
and Compose configuration passed. Real rootless Podman smoke with fake external
services covered provider/device credentials, questions, checkpoint reconstruction,
bounded repair/exhaustion, fresh and same-PR publication, remote-head fencing,
cancellation and erasure. No live model call, Telegram message, GitHub write or
deployment was performed. The live pilot and semantic intent evaluation remain
release gates; see the plan for their acceptance journey.

### Release-driven VPS deployment (2026-10-05)

Added a stable GitHub Release workflow that reuses CI verification, builds the
release event's immutable commit and transfers its image over verified SSH.
The host script locks deployment, checks runtime secret access, stops writers,
validates a protected pre-migration backup, runs migrations and verifies both
container health and application readiness before recording success. Failed
cutovers stop writers and require deliberate schema-aware recovery.

Validation: Biome, TypeScript, Bun build and runtime contract passed; all **317
Bun tests** passed against disposable PostgreSQL, including seven deployment
tests. Actionlint, Bash syntax and Compose validation passed. The application
Docker image built and passed its isolated Node runtime contract. Disposable
Docker stacks passed a fresh install and an upgrade to a distinct image ID;
both app/worker changed images, database test data persisted, backups validated
and host `/readyz` returned HTTP 200. Temporary containers and volumes were
removed. No live VPS deployment, account connection, webhook registration or
message sending was performed. See [VPS setup](vps-deployment.md) for required
host provisioning and GitHub secrets.

### Local Codex runner reconciliation (2026-09-29)

The live Podman supervisor was healthy with no active coding containers. Two
earlier implementation jobs had failed and their work volumes remained within
the configured 24-hour retention period. The supervisor now removes a stale
credential-free export container before retrying a patch export, so an
interrupted read-only export can recover after a restart. Periodic timeout
reconciliation now records `coding_task_timeout` for the task status. The
running supervisor image was not replaced during this check.

Validation: Biome, TypeScript, Bun build, the 10 runner unit tests, coding
integration tests, Compose configuration and a real Podman smoke with fake Codex
and local Git passed. The full Bun suite reached 301 of 302 passes with a
reproducible timeout in the unrelated native Telegram Stop test; the coding
integration suite passed. The smoke resources were cleaned up.

### Codex local-only execution (2026-09-29)

Removed the GitHub Actions coding dispatcher, repository workflow template and
backend selector. New approvals run only through the local Podman supervisor.
Operators set local check commands for each coding repository; old Actions
configuration cannot authorize new tasks. Historical Actions tasks and links stay
visible, but the worker does not dispatch, poll or cancel them. Queued and
issue-created tasks are cancelled locally; tasks that may have started remotely
become unknown and require inspection in GitHub.

Validation: Biome, TypeScript, Bun build, all 301 Bun tests against disposable
PostgreSQL, Compose configuration, isolated app image build and Node runtime
contract passed. The coding panel browser flow passed in the full browser run.
That run stopped at a separate run-summary UI assertion after 15 passes; two
later tests did not run. No app service was redeployed or live coding task started.

### Overview run and workflow visibility (2026-09-28)

Overview count cards now open their corresponding member, assistant-run,
scheduled-workflow and Codex-task views. Counts match the records in those views.
Initially, unlinked deployment administrators could inspect only read-only run and
workflow metadata. As of 2026-10-06, the workspace deployment administrator and
eligible workspace owners/admins can read every retained run's request, result,
transcript and delivery text, including other users' private runs. Deployment
administrators need no linked Telegram identity for this view. Access remains
workspace-scoped; Telegram execution and mutation checks remain in effect.
Workflow content keeps its existing identity restrictions. The Codex task table
also shows a recorded thread ID when available.

Validation for the 2026-10-06 run-message change: Biome, TypeScript and build
passed; all 385 Bun tests passed against disposable PostgreSQL. The setup and
run-message browser checks passed for linked and unlinked administrators, with
mobile dialog inspection. Permission tests cover tenant boundaries, ordinary
members, revoked workspace admins and unchanged private-run cancellation checks.

Validation: Biome, TypeScript and build passed; all 301 Bun tests passed against
disposable PostgreSQL, and all 17 browser tests passed with fake external services.
The live Clawearn task check failures are documented in
[the incident record](../../postmortem/2026-09-28-clawearn-coding-checks.md).
Future failed local Codex tasks now retain their thread ID and a safe failure
stage when the job supplies one; the panel renders the stage in plain language.
The local Podman app, worker and Codex supervisor were rebuilt and restarted with
the verified images. The job image was prebuilt for future tasks. The protected,
verified pre-cutover archive is
`backups/repodesk-pre-overview-20260928T104445Z.dump`; prior images remain tagged
`rollback-pre-overview-20260928`. Compose validation, the isolated Node runtime
contract, app health and asset smoke, and real Podman success/failure smoke passed.
All three services became healthy, `/readyz` returned `ready`, and Telegram polling
reconnected. No live Telegram message or new paid Codex task was sent for this
release check. Historical failed tasks remain failed with their original generic
error code.

### Setup flow and panel model settings (2026-09-27)

The authenticated wizard now follows Workspace → Telegram → GitHub App → Enter
panel. It reuses guided App registration and repository connection, returning
GitHub callbacks to the wizard when started there. GitHub access can be finished
later from Plugins. Model credentials and explicit bot activation moved to the
operator's Model settings page; entering the panel leaves the bot inactive.

Validation: Biome, TypeScript and build passed; 296 Bun tests passed with an
isolated PostgreSQL test database, and all 16 browser tests passed. Browser tests
used fake Telegram, GitHub and model transports. This change was not deployed or
tested against live providers.

### Group names and local deployment (2026-09-21)

Group access cards show the Telegram group title above its numeric ID, with an ID
fallback for unknown titles. Linking and incoming group updates persist titles;
Recheck bot visibility also fetches the current title for existing bindings.
Inaccessible groups retain their last known title.

Validation: 236 deterministic tests with PostgreSQL, 16 browser checks, Biome,
TypeScript and build passed. Deployed app and worker to local Podman using
`localhost/deepx-agent:group-names-20260921` (`c8ef95b29cd6`), also tagged `local`.
Compose validation, migrations, isolated Node runtime and HTTP smoke checks passed.
Both live containers passed health checks; `/healthz` and `/readyz` returned 200,
Telegram polling connected, and the served admin bundle includes the new card UI.
PostgreSQL and Code Truth containers were preserved. Database backup:
`backups/deepx-before-group-names-20260921.dump` (archive verified). Rollback image:
`localhost/deepx-agent:before-group-names-20260921`.

### Core implementation

- Opt-in local Telegram long polling with durable per-bot offsets, single-receiver
  advisory locking, rate-limit backoff, cancellation and shared ingress/owner validation.
  Setup and readiness checks distinguish polling from the default webhook transport.

- Pi 0.85.1 with configurable OpenAI-compatible endpoints, custom model IDs and thinking levels, bounded sequential tools,
  fake-stream tests, cancellation, durable checkpoints and safe transcript recovery.
- PostgreSQL versioned migrations, tenant row locks, inbox deduplication, transactional
  outbox/pg-boss enqueue, fenced run leases and recovery after worker loss.
- One-use deployment claim, scrypt passwords, revocable sessions, CSRF/origin checks,
  encrypted write-only settings, resumable setup and verified Telegram identity links.
- Telegram webhook validation, command/reply routing, group-admin verification, explicit
  active membership policy, consented received-message collection and scoped sources.
- Manual requests/recaps, source-ID validation, usage reservations, cancellation,
  versioned instruction/workflow/skill snapshots and separate delivery outcomes.
- Canonically hashed approvals, daily/weekly recurrence with DST policy, unique
  occurrences under transaction locks, missed-run notices and workflow lifecycle controls.
- Approved corrections, personal/workspace/workflow instructions, forget/edit, skills
  catalog/import/drafts/settings/publication/enablement/rollback and deterministic tests.
- React Router admin screens for setup, settings, access, members, chats, workflows,
  skills, instructions, runs, usage, audit, privacy and operator controls.
- Retention/deletion tombstones, unknown-charge/delivery reconciliation, health/heartbeat,
  CI, pinned base images, local Docker checks and backup/restore automation.

## Validation evidence

- **48 Bun tests**: 26 local/unit tests plus 22 tests against real PostgreSQL 17.
- **3 Chromium browser tests**: first-claim/resume, write-only credentials, concurrent
  save conflict, skill publish/test/enable, workflow pause/audit, sign-in and mobile layout.
- TypeScript strict checking, Biome and production frontend/backend build.
- Docker Compose migration/API/worker/PostgreSQL health; `/readyz` and admin deep links.
- Container restart preserved a claimed deployment/workspace; a custom-format backup
  restored successfully into a disposable database with three migrations and the fixture.
- Pi contract in the built Node **v24.21.0** image: actual fake-provider tool flow,
  event ordering, bounded turns, cancellation and restored tool-result continuation.

The PostgreSQL tests found and fixed a canonicalization defect: JSONB's key ordering
must not change approval hashes. They also cover claim/approval/dispatch races,
rollback, independent connections, stale settings, revoked sessions, source isolation,
charge reservation races, duplicate workers, rate handling, unknown sends, deletion,
version pins and awaiting-approval worker release.

Run the exact commands in [setup](setup.md). Tests need no real Telegram/model secrets.
Browser artifacts are generated into ignored `test-results/`; they are not release assets.

## Deliberate implementation choices

The pilot uses typed workspace JSONB aggregates and short `SELECT FOR UPDATE`
transactions instead of a separate SQL table for every nested domain record. Relational
constraints cover global identity/binding/inbox/outbox uniqueness. See [architecture](../design/architecture.md)
for limits and the path to normalize high-volume records before scaling.

Skill/workflow editing uses labeled form controls validated by shared server schemas.
Skill testing is a deterministic policy/prompt preview. Live model-quality testing is
an explicit, separately capped operator evaluation; it has not been performed.
Optional Telegram web login remains deferred; verified Telegram linking plus local
account sessions is the implemented authentication path. Group migration suspends and
requires relinking rather than automatically authorizing a new chat.

### Readable admin interfaces (2026-09-21)

The remaining JSON displays and editors have been removed from setup, access
previews, approvals, workflows, skills, instructions, run details/recovery and
operator tools. Structured results use labeled details and lists; operator audit
and workspace status use tables. Explicit form controls retain hidden concurrency
versions and bound IDs, mask passwords, and preserve failed drafts. Approvals
refresh automatically after proposal creation. Copyable commands and Markdown
remain literal content; API serialization is unchanged.

Validation: lint, TypeScript, build, all 217 deterministic tests with PostgreSQL,
and all 14 browser tests passed. Browser checks include skill publication, workflow
payloads and version conflicts, modal locking, automatic proposal refresh,
cross-page JSON removal, and desktop/mobile layouts.

Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:readable-ui-20260921` (`99cb37e7d5df`). The built image passed
the isolated Node runtime contract and HTTP/UI smoke checks against disposable
PostgreSQL. Compose validation and migrations passed; both deployed containers
passed health checks, `/healthz` and `/readyz` returned 200, and the worker reported
`telegram_polling_connected`. Existing PostgreSQL and Code Truth containers were
preserved. The verified database backup is
`backups/deepx-before-readable-ui-20260921-160639.dump`; the previous image remains
tagged `localhost/deepx-agent:before-readable-ui-20260921` for rollback.

### Borderless icon buttons (2026-09-21)

All admin icon buttons are borderless, including destructive, sidebar and modal
actions. Hover backgrounds, keyboard focus outlines, 44px targets and disabled/busy
states remain. Lint, TypeScript, build, 217 deterministic tests and 14 browser tests
passed; browser style checks also verified normal, destructive, sidebar, disabled,
busy and hover states plus keyboard focus.

Deployed image `localhost/deepx-agent:borderless-icons-20260921` (`b1c0fbfc56d5`)
to the local Podman app and worker. Compose validation, isolated runtime contract
and HTTP smoke checks passed. Both containers are healthy, `/readyz` returned 200,
Telegram polling connected, and the live stylesheet contains the borderless rule.
No database schema changes were needed; PostgreSQL and Code Truth were preserved.
Verified backup: `backups/deepx-before-borderless-icons-20260921-164108.dump`.
Rollback image: `localhost/deepx-agent:before-borderless-icons-20260921`.

### Modal action layout (2026-09-21)

All create/edit dialogs now place Cancel immediately after their primary action
using the shared `ModalActions` row.
Nested dialogs retain independent cancellation, focus return and pending-save
locks. Lint, TypeScript, build, 217 deterministic tests and 14 browser tests passed;
desktop/mobile dialog screenshots were inspected. Deployed with the refresh
loading update below.

### Refresh loading feedback (2026-09-21)

Refresh controls now track data loading through completion or failure instead of
only the click callback. Operations waits for both health and setup requests;
session refresh also shows the shared rotating icon. Busy controls prevent repeat
clicks and respect reduced-motion preferences. Lint, TypeScript, build, all 217
deterministic tests and 15 browser tests passed, including delayed success/error
responses, actual rotation, reduced motion and combined refreshes.

Both updates were deployed to the local Podman app and worker on 2026-09-21 with
image `localhost/deepx-agent:modal-refresh-20260921` (`77333bd2bae8`). Compose
validation, the isolated runtime contract and HTTP/UI smoke checks passed. Both
containers passed health checks; `/healthz`, `/readyz` and updated UI assets returned
200, and the worker reported `telegram_polling_connected`. No schema changes were
needed; PostgreSQL and Code Truth were preserved. Verified database backup:
`backups/deepx-before-modal-refresh-20260921-165545.dump`. Rollback image:
`localhost/deepx-agent:before-modal-refresh-20260921`.

### Workspace settings heading (2026-09-21)

Workspace settings now places refresh at the top right and displays its saved
version as a badge after the page title. The former bottom version text and reload
control have been removed. Desktop/mobile screenshots were inspected; lint,
TypeScript, build, 217 deterministic tests and 15 browser tests passed, including
the badge updating after save. The refresh test now waits for sign-in completion
before navigation.

Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:settings-heading-20260921` (`e770fad107b0`). Compose validation,
the isolated runtime contract and HTTP/UI smoke checks passed. Both containers
passed health checks; `/healthz`, `/readyz` and updated UI assets returned 200,
and Telegram polling connected. No schema changes were needed; PostgreSQL and
Code Truth were preserved. Verified backup:
`backups/deepx-before-settings-heading-20260921-171210.dump`. Rollback image:
`localhost/deepx-agent:before-settings-heading-20260921`.

### Unified members and access (2026-09-21)

The sidebar now has one **Members & access** entry. Its searchable, paginated table
shows Telegram names/usernames and numeric IDs, role, membership and effective
access. Access requests share this page. As of 2026-10-07, all active members have
bot access; the whitelist, access mode and policy preview/apply controls and APIs
are removed. Old access-policy browser URLs redirect while preserving workspace
query parameters; search/pagination also retain those parameters. The member API
provides a membership revision for concurrent edits.

Profiles are optional fields in workspace JSON: trusted Telegram sender updates
refresh them, and approved requests populate them. Older approved requests provide
a read-time fallback until a fresh profile arrives. Removing a Telegram username
clears the displayed value, and changing roles preserves the profile. Authorization
continues to use numeric IDs; profiles never enroll users or change permissions.
No extra Telegram calls, dependency additions or schema migration are required.

Validation: lint, TypeScript, build, 235 deterministic tests and 16 browser tests
passed. Checks include duplicate events, tenant isolation, anonymous senders,
profile removal/fallback, member edits, mode changes, revocation, last-admin
protection and the legacy URL redirect. Desktop/mobile screenshots were inspected.
Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:members-access-20260921` (`5a9d0fc514dd`). Compose validation,
the isolated runtime contract and HTTP/UI smoke checks passed. Both containers
passed health checks; `/healthz`, `/readyz`, the members page and updated UI assets
returned 200, and the worker reported `telegram_polling_connected`. PostgreSQL and
Code Truth were preserved. Verified database backup:
`backups/deepx-before-members-access-20260921-173543.dump`. Rollback image:
`localhost/deepx-agent:before-members-access-20260921`.

## External release gates still required

Supply a dedicated staging bot/group, model account and spend cap, HTTPS host/domain,
protected secret/backup storage, retention agreement and support owner. Perform the
credentialed evaluation and complete the [staging demonstration](release-runbook.md).
The initial model is provisional until that evaluation passes. No claims about live
recap quality, real webhook delivery or pilot readiness follow from fake-provider tests.

## Model settings verification (2026-09-19)

Deterministic tests cover a local streaming Chat Completions server receiving the
custom endpoint, bearer key, model ID and all seven thinking choices. PostgreSQL
coverage verifies operator-only writes, version conflicts, encrypted/redacted keys,
retaining a key, requiring a new key when changing endpoints, and worker settings.
Browser coverage saves and reloads the custom model, URL and thinking selection.
Live provider capability/price validation remains pending.

## LLM extensions / plugins

Implemented: explicit Pi 0.85.1 extension-file loading for granted workspaces,
registered tools and the documented headless hooks, per-run factory state, limits,
configuration pinning and durable tool outcomes. Deterministic tests exercise loading
unchanged Pi files, vetoes, unsupported features, grants, revocation, collisions and
unknown outcomes. See [the compatibility contract](../design/llm-extensions.md).
Executable code is operator-reviewed and runs in-process. The Plugins panel manages
installed-file registrations, versions, tool/workspace grants and enable/disable/remove
actions. Settings, revisions and audits persist in PostgreSQL; workers recheck changes
between execution steps. Sandboxing, arbitrary external writes and web package/code
installation remain outside this implementation.

On 2026-09-29 the Plugins landing page was reorganized into compact Installed
and Markets cards. Code Truth, Codex and file plugin controls now open on
dedicated detail routes. Markets shows three dated picks from Pi's package
catalog with upstream links; packages are not installed from the panel and
compatibility is not asserted. Browser tests cover the catalog, detail
navigation, registration, revision conflicts and workspace isolation.

Verification on 2026-09-20: lint, typecheck and build passed; 90 deterministic tests
passed with isolated PostgreSQL and `NO_PROXY=localhost,127.0.0.1`. Both Compose
configurations validated. The Docker image passed the Pi extension runtime contract
on Node 24.21.0 with network access disabled, including legacy package aliases,
and returned HTTP 200 from `/healthz` with no configured live services.

Plugin UI verification on 2026-09-20: 96 tests passed against isolated PostgreSQL,
including operator/tenant/CSRF boundaries, stale revisions, preserved file hashes,
worker execution of saved plugins and mid-run revocation. All 5 browser tests passed,
including registration, editing, grants, toggles, removal, persistence, conflict handling
and desktop/mobile layouts. Lint, typecheck, build, both Compose configurations and
the Docker Node 24 extension runtime contract passed. The image serves `/admin/plugins`
and its plugin-management JavaScript bundle successfully without live services.

## Predefined local Code Truth verification (2026-09-20)

Implemented the private local MCP service from the sibling Code Truth core, a named
Pi extension with its companion skill, and the Plugins repository editor. The UI
supports GitHub URLs, network/branch mappings, per-repository workspace grants,
enable/disable, removal, and indexing status with commit provenance.

Verified locally:

- Biome, application and service TypeScript checks, and the application build pass.
- **125 deterministic tests pass**, including the original source-query tests, real
  CodeGraph indexing of a local archive fixture, authenticated HTTP MCP isolation,
  actual Pi factory/tool/schema execution with a fake model, source output, config
  digests, cancellation, operator/CSRF/grant/revision checks and tool collisions.
- **6 browser tests pass**, including repository configuration persistence, branches,
  grants, enable/disable, removal, unavailable/ready status rendering and responsive
  desktop/mobile checks. Ready browser status is a deterministic intercepted fixture;
  real service indexing is checked separately through MCP.
- Both Docker images build. The Code Truth container indexes and queries a local
  fixture through real CodeGraph and MCP with a read-only filesystem and no external
  network. The service entrypoint passes liveness and rejects unauthenticated
  management requests. The Node runtime extension contract also passes.
- Compose configuration validates with both Code Truth and file-extension overrides.

No real repository download, GitHub token, live LLM, Telegram call or production
rollout was used. [Setup](code-truth.md) explains service secrets, supported GitHub
repositories and separate local-index retention/cleanup.

## Independent workspace plugins (2026-09-20)

File plugins and Code Truth configuration now live on each workspace aggregate,
with independent revisions and workspace audit entries. The panel uses the selected
workspace and discards its local drafts when switching. Saving a workspace’s plugin
configuration does not revoke another workspace’s runs, including those owned by
the same operator. Executable plugin management remains operator-only.

Migration `006_workspace_plugins.sql` splits legacy operator registries by existing
grants, preserves pinned hashes and disabled entries, and removes the old deployment
registry. Apply migrations before starting the updated API and worker. The API now
uses `/api/admin/workspaces/:id/plugins` and its Code Truth subroutes.

Verification: Biome, TypeScript and build pass; **128 deterministic tests** pass with
isolated PostgreSQL, including migration, fallback behavior, cross-workspace access,
concurrent revision conflicts and same-owner runtime isolation. **7 browser tests**
pass, including independent plugin versions/repositories, draft reset on workspace
switch, and desktop/mobile layouts. No running application data was migrated.

## Workspace GitHub App connections (2026-09-20)

The Plugins panel now supports GitHub App authorization, installation and repository
selection, connection status, reconnect and workspace-only disconnect. OAuth uses
PKCE, one-use state and session/workspace binding. Temporary user credentials are
encrypted; ongoing Code Truth access uses short-lived, repository-restricted,
Contents-read installation tokens. Connection revisions invalidate pinned runs.
Explicit disconnect prevents legacy deployment-token fallback for that workspace.
See [registration and deployment setup](github-app.md).

Verification: Biome, both TypeScript checks and build pass. **133 deterministic
tests** pass against isolated PostgreSQL, including authorization boundaries,
forged selections, expiry/replay, token redaction, scoped JWT/token requests,
credential rotation and independent snapshot namespaces. **8 browser tests** pass,
including the callback returning to the original workspace, repository selection,
persistence, workspace switching, disconnect and mobile layout. GitHub HTTP calls
in these tests use deterministic fixtures; real App OAuth remains unverified until
the deployment has registered App credentials.

Both images built and passed isolated container smoke tests: Node runtime contracts,
application health/UI, and real CodeGraph indexing plus MCP query. Compose validates
with and without the GitHub App override. The local Podman stack was updated after
a verified database backup; migrations 006 and 007 are applied. App, worker,
PostgreSQL and Code Truth are healthy, and `/readyz` returns 200. Existing private
`devnet-develop` and `testnet-develop` indexes are ready using legacy credentials.
The new Connect button remains disabled until App credentials are configured.

## Guided GitHub App creation (2026-09-20)

The GitHub card now offers App Manifest registration for personal or organization
accounts. It preconfigures read-only source permissions and callbacks, asks the user
to confirm creation on GitHub, and exchanges the returned code server-side. The App
credentials are encrypted in an operator-scoped registry, reusable across that
operator's workspaces without automatically connecting them or granting repositories.
API and worker read saved credentials without restart. Existing environment/file App
configuration remains supported. Migration `008_github_app_registration.sql` adds
this registry and expiring, session-bound registration flows.

Verification: lint, TypeScript and build pass; **139 deterministic tests** and
**9 browser tests** pass, including ownership/CSRF boundaries, cancellation, expiry,
replay, session revocation, invalid conversion responses, concurrent creation,
credential redaction/persistence, worker access and complete create/connect/disconnect
browser flows. GitHub exchanges are fixtures; no real GitHub App was created by tests.
Mobile creation layout was inspected. The container passed the Node runtime contract
and health/UI smoke tests, and both Compose variants validate. The local Podman app
and worker run the tested image with migration 008 applied; health and readiness
return 200 and the served UI bundle includes the creation control.

GitHub Manifest correction (2026-09-20): GitHub rejected the local origin in the
inactive hook URL. The hook now uses a reserved public example URL, remains disabled,
and subscribes to no events; browser callbacks still use the deployment origin.
All 139 tests and 9 browser tests pass with regression assertions, along with lint,
typecheck, build, Compose validation and the container runtime smoke. App/worker were
updated. A real submission through the user's browser now advances past the prior
manifest error to GitHub's Confirm access (sudo authentication) page. Completing that
verification and creating the App remain user steps; no App was created by this check.
See [incident notes](../../postmortem/2026-09-20-github-manifest-localhost.md).

## Model-aware execution budgets (2026-09-20)

Workspace run/month budgets no longer have fixed pilot dollar ceilings. Output and
context limits come from bundled Pi catalog metadata or explicit operator overrides
for custom models. Workspace language and input/output budgets are automatic. Migration 010 removes
retired controls from current settings; historical run snapshots remain intact. Runtime checks happen before each reservation/dispatch,
using conservative UTF-8 byte estimates, and model capacity is pinned on runs.

Deterministic coverage includes custom-model capability requirements, higher output
budgets, oversized tool-context continuation, pre-dispatch rejection, zero-cost
reservations, field-level API validation, authorization and version conflicts. Browser
coverage verifies settings errors, saving above old caps and desktop/mobile layouts.
Provider capability values are not verified with live calls; large Telegram replies
still follow the existing delivery truncation. See [configuration](setup.md#model-capacity-and-workspace-budgets).

## Telegram access requests (2026-09-20)

Implemented unauthorized-user request buttons, scoped request links, deduplicated
pending requests and admin approval/rejection under Members. Approval atomically
creates/reactivates regular membership for the verified Telegram ID and queues
a confirmation with normal delivery authorization checks. Requests use workspace
JSONB; migration `009_access_requests.sql` scopes fixed access-help deliveries.

Deterministic PostgreSQL checks cover duplicate updates/requests, concurrent approvals,
CSRF/admin/tenant boundaries, stale decisions, rejection retry delay, revocation replay,
private/group routing, forged actors, deletion and retention. Telegram calls use test
transports; no live Telegram message or production migration was performed.

Verification: lint, strict typecheck and production build pass; **150 automated tests**
pass with isolated PostgreSQL, and all **11 browser tests** pass. Browser coverage
includes stale-policy recovery, approval/rejection, member-list refresh, persistence
and desktop/mobile layout. Both access-request screenshots were visually inspected.

## Local deployment update (2026-09-20)

Model calls per run accept integers from 1 to 20, default 3. Boundary tests reject
21, zero and fractional values. The current source passed Biome, TypeScript, build,
150 deterministic tests against disposable PostgreSQL, and 11 browser tests. The
Docker-format image passed the Node 24 runtime contract and isolated HTTP/UI smoke
checks. Compose configuration was validated with the existing Code Truth override.

The local app and worker were updated after a protected database backup and migrations;
both containers are healthy, `/healthz` returns `ok`, `/readyz` returns `ready`, and
Telegram polling reconnected. No model request was sent for deployment verification.
Custom model capability values must be configured before new model runs; service
readiness does not validate these provider limits.

## Automatic response settings (2026-09-20)

Reply language, Input byte budget and Output token budget have been removed from
workspace settings and their API output. Older clients' retired fields are discarded
on save. Migration 010 removes existing overrides and advances affected workspace
versions without changing historical run snapshots. No workspace language is injected
into the prompt; the model's response is returned in its chosen language.

Per-call output automatically fits the model's maximum, remaining context capacity
and remaining run/month USD budgets. Atomic reservations still enforce concurrent
budget limits. Tests cover removal, legacy migration/idempotency, preserving model
text, context/budget adaptation, zero-cost calls, and pre-dispatch budget denial.

Local verification: Biome, TypeScript, build, 154 deterministic tests and 11 browser
tests passed. Desktop/mobile settings and the Docker image were inspected. The local
app and worker were redeployed after a protected backup; migration 010 is applied,
no current workspace retains the retired controls, and liveness/readiness are healthy.

## Run deadline diagnosis (2026-09-20)

The executor now distinguishes deadline expiry (`run_timeout`) from cancellation
and worker shutdown (`worker_shutdown`), preserving the first abort source in logs
and run details. `RUN_TIMEOUT_SECONDS` defaults to 300 seconds and accepts 1–1800;
new run queue jobs get an additional 60 seconds for finalization. Migrations update
existing queue defaults. Conversation leases continue to renew while running.
Unknown reservations remain unchanged and terminal runs are not automatically replayed.
Deterministic regression tests cover timeout, shutdown, cancellation, retained
reservations, duplicate jobs, queue expiration and configuration validation.

## Paginated usage table deployment (2026-09-20)

Usage & budget now renders accounting attempts in a paginated table with status,
reserved/actual USD, model/run ID, dates, record counts and mobile table scrolling.
Local verification passed Biome, TypeScript, build, 159 deterministic tests and all
12 browser tests, including pagination, empty/error states, refresh and mobile layout.

The Podman Docker-format image `localhost/deepx-agent:usage-table-20260920`
(`b15143713176`) passed the isolated Node runtime contract and HTTP/UI smoke checks.
Compose configuration validated; a protected database backup was verified and the
migration command completed before app/worker replacement. Both containers, PostgreSQL
and Code Truth are healthy; liveness/readiness return 200, polling reconnected and
the served bundle includes the usage table. The previous image is retained as
`localhost/deepx-agent:before-usage-table-20260920` for rollback.

## Telegram GitHub issue submission (2026-09-20)

Implemented a built-in `propose_github_issue` tool for workspaces with a connected
GitHub installation. It shows the complete repository/title/body in Telegram and
requires the requesting actor's explicit approval before the application worker
creates an issue and returns its link. Repository selection, connection revision,
actor access, cancellation, expiry and pause controls are rechecked before sending.
Durable reservations prevent concurrent workers or restarts from replaying a POST;
ambiguous outcomes require checking GitHub before requesting another draft.

Guided App creation now requests Issues write permission. Existing Apps/installations
must approve that permission update on GitHub. Code Truth tokens remain Contents-read;
issue tokens are limited to Issues-write on the single approved repository. There is
no panel issue form and no new dependency or database migration.

Verification: Biome, TypeScript and build pass; **173 deterministic tests** pass with
isolated PostgreSQL and **12 browser tests** pass. New tests cover the real Pi factory,
complete approval previews, tenant/actor/repository boundaries, concurrent workers,
revocation during token minting, permission/error outcomes, ambiguous recovery and
workspace deletion. GitHub and Telegram calls use fixtures. No live issue was created,
no App permission was changed, and this change has not been deployed.

## Rich replies and native Stop (2026-09-20)

Implemented Bot API **10.3** rich model replies in private chats, groups and schedules,
with native headings, lists/tasks, quotes, code, dividers, compact aligned tables and
safe inline formatting. Private interactive replies stream with native Stop enabled;
partial drafts are not automatically saved. Previews are throttled, source-checked,
fenced and exclude thinking/tool arguments. A persisted bot/chat/topic/draft/fence
binding routes Stop independently of workspace selection, through authenticated,
deduplicated ingress. The run guard aborts generation, blocks pending publication and
keeps unknown provider reservations. Confirmed rich-send rejection falls back to text;
ambiguous sends are never blindly replayed.

No new dependency or SQL migration is required. Existing webhook subscriptions must
be explicitly re-registered to include the Stop update; polling subscribes after
worker restart. See [manual staging example](../../examples/telegram-streaming.md).

Verification: Biome, TypeScript, production build and the full deterministic suite
pass against disposable PostgreSQL. Coverage includes native block rendering,
preview timing/retries, duplicate/stale/cross-tenant Stop events, revoked access,
fencing, paused execution, provider cancellation/accounting, pending final delivery,
authenticated webhook handling and polling subscriptions. Telegram/model calls use
fixtures. Local deployment is recorded below; end-to-end live Telegram behavior
remains unverified.

## Internal model cost query (2026-09-20)

Implemented the skill-granted `query_model_cost` application tool: private-chat
queries for the actor's usage or owner/admin workspace totals, grouped by model
over today, this month or retained history using UTC. Settled costs, reservations
and unknown amounts remain distinct; workspace reports include the current monthly
budget. Reports use existing tenant accounting and do not call provider billing APIs.
Existing published skills need an explicit grant; new starter skills include it.
No dependency or migration is added. See [usage examples](../../examples/model-cost.md).

Verification: Biome, strict TypeScript and production build pass; **197 tests** pass
against disposable PostgreSQL. New coverage exercises UTC boundaries, zero costs,
unresolved charges, per-model totals, tenant/actor/admin/private-chat boundaries,
grants, cancellation, fencing, revocation, replay argument conflicts and a complete
fake-provider Pi execution with durable accounting and duplicate-run recovery.
Included in the local Podman deployment recorded below; live Telegram/model behavior
remains unverified.


## Local rich replies / Stop deployment (2026-09-20)

Updated the local Podman app and worker to image
`localhost/deepx-agent:rich-stop-20260920` (`484928d97634`), also tagged `:local`.
The image includes the current verified workspace source, including rich model
replies, private streaming and native Stop. The existing Code Truth service and
PostgreSQL volume were retained. Migration completed with all ten migrations applied.

Pre-release verification: lint, strict TypeScript, build and **197 deterministic
checks** passed; all **12 browser tests** passed against disposable PostgreSQL.
The Docker-format image passed the isolated Node 24 runtime contract and HTTP/UI
smoke checks, and the existing Compose configuration with Code Truth validated.
A protected custom-format database backup was created and its archive verified at
`backups/deepx-before-rich-stop-20260920T102943Z.dump` (mode 0600). No runs or sends
were active at replacement. The previous image is retained as
`localhost/deepx-agent:before-rich-stop-20260920` (`34c183fc43a4`) for rollback.

Both deployed containers are healthy and use the tested image. `/healthz` returns
`ok`, `/readyz` returns `ready`, and Telegram polling reconnected. The running worker
contains rich-send/draft support and the native Stop update subscription. This stack
uses polling, so no webhook registration was needed. No test Telegram message or
paid model request was sent for release verification. Temporary test containers
were removed; end-to-end Telegram rendering and Stop remain a user staging check.

## Codex implementation workflows (2026-09-21)

Local implementation adds workspace-scoped repository/base-branch/maintainer
configuration, actor-bound coding approvals, durable issue creation and Actions
dispatch, progress/PR reporting, cancellation requests and an admin task list.
The supplied repository workflow runs Codex and checks, then publishes a draft PR
from a fresh job. No live GitHub/Codex run has been performed; repository setup
and a staging run remain required. See [setup and recovery](codex-coding.md).

Validation: `bun run check`, `bun run typecheck`, `bun run build`, and Node runtime
contracts passed. `bun test` passed **211 tests** with PostgreSQL integration tests
enabled, including **14 coding-specific tests**. All **12 browser tests** passed,
including repository/maintainer configuration, edit cancellation and mobile layout.
The repository workflow template passed actionlint 1.7.12. External Codex execution,
GitHub publication and paid-provider billing were not exercised.

## Local native-streaming deployment (2026-09-21)

Updated the existing Podman app and worker to
`localhost/deepx-agent:native-stream-20260921` (`c44c74b5f22a`), also tagged `:local`.
Private requests now start with Telegram's native thinking draft, stream the answer,
and persist one final reply. Normal requests, recaps and one-off corrections no
longer send queue acknowledgements. This image contains the current workspace
source, including the Codex implementation described above.

Validation: all **214 tests** passed with PostgreSQL integration enabled, along with
lint, strict TypeScript and build checks. All **12 browser tests** passed against a
disposable database. The Docker-format image passed its isolated Node 24 runtime
contract and HTTP/UI smoke tests; the existing Compose configuration validated.

No runs or sends were active at replacement. The protected database backup is
`backups/deepx-before-native-stream-20260921.dump` (mode 0600; archive verified).
The previous image remains tagged `localhost/deepx-agent:before-native-stream-20260921`
(`484928d97634`). PostgreSQL storage and the running Code Truth service were retained.
The migration container exited successfully. Both app and worker are healthy,
`/healthz` reports `ok`, `/readyz` reports `ready`, and Telegram polling reconnected.
No test messages or paid model requests were sent; live rendering remains a staging
check. Temporary test containers were removed.

## Private conversation threads (2026-09-21)

Standalone private requests create user/workspace threads; replies to retained user
messages or delivered answers continue them. Thread sources are isolated and
refreshed at execution, with ordered runs and separate recovery transcripts. The
read-only `query_chat_history` tool searches owned private threads with bounded
excerpts, cursor pagination, retention and citation checks. Legacy records are not
inferred into threads. No SQL migration or new dependency is required.

Deterministic unit and isolated PostgreSQL tests cover reply mapping across restart,
duplicate ingress, cross-user/workspace denial, ordered execution, history citations
and retention. Live Telegram/model acceptance remains a staging check. See
[design](../design/private-threads.md) and [examples](../../examples/private-threads.md).

## Native private Topics (2026-09-22)

Private interactive requests now prefer Telegram's native `message_thread_id`
over reply anchors. Same-topic messages share a persisted workspace/user/chat/bot
thread without requiring Reply; different topics have separate default context.
Cross-topic and unavailable reply anchors do not switch the current topic. Outside
Topics, the existing reply-based fallback remains. Native mappings persist in
workspace JSONB without a SQL migration or new dependency; pre-upgrade threads
remain searchable but are not automatically merged into native topic history.
Help, design rules and manual examples now describe native Topics as the primary
conversation interface, with no parallel New/Recent conversation controls.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **247 tests**
passed with disposable PostgreSQL and fake external transports. The full test run
used `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL` and `bun test --timeout 30000`.
The initial focused run hit an existing streaming test's default five-second timeout;
that test and the full suite passed with local proxy bypass and the longer limit.
Coverage includes native topic continuation, conflicting reply anchors, user/bot/
workspace isolation, concurrent duplicate ingress, restart persistence, ordered
execution and failed predecessors, retained history, topic-preserving thinking/
streaming/final delivery, and native Stop isolation. No deployment or live Telegram
messages were performed for this change. See [examples](../../examples/private-threads.md).

## Discussion memory and Topic compaction (2026-09-22)

Native Topics now support internal discussion summaries, decisions, todos, source
links and overlapping relations through core Pi tools. Model policy continues
short follow-ups, answers clear topic changes without confirmation, and retrieves
older summaries/original excerpts when needed. Record updates are staged and commit
with a visible answer; they do not create approvals, persistent instructions or
external actions. Source hashes, retention and topic/actor scope guard reads,
updates and replay. The bounded catalog uses literal search and model semantic
judgment, without an embedding service or extra classifier call each turn.

Context places frozen summaries and growing history before changing metadata.
Stable hashed workspace/thread session keys support Pi/provider cache routing.
At 80% of available context after output reserve, bounded summary batches target
40% while keeping the two most recent runs. Summaries use the configured model with
no tools/extensions or previews and share run budgets, deadline and cancellation.
Separate durable checkpoints recover completed summaries without another model
call; unknown charges are not replayed. Original sources remain available under
retention, and edits/deletion invalidate derived memory. Provider cache token counts
are retained on each usage attempt, including compaction charges.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **261 tests**
passed. The full test run used `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL`
and `bun test --timeout 30000` with deterministic providers and disposable PostgreSQL. Tests
cover prefix stability, discussion updates/relations/retrieval, permissions and
replay, threshold compaction, accounting, invalid summaries, budget/cancellation/
source-removal failures, unknown outcomes, and checkpoint recovery. No dependency,
SQL migration, deployment, live Telegram send or paid model call is introduced by
local verification. Live summary fidelity, semantic recall and actual cache hit
rates remain evaluation work. See [design](../design/private-threads.md) and
[examples](../../examples/private-threads.md).

## Group conversations and natural follow-ups (2026-09-22)

Interactive group requests now keep per-user continuity scoped to workspace, bot,
group and native Topic (including topic zero). Replying to a confirmed retained bot
answer can join a public discussion. Group history retrieval cannot access private
chats or other topics. Discussion tools, frozen summaries, stable cache identities
and threshold compaction are reused. Manual recaps and schedules keep group coverage.

A plain received message can become a candidate only after that same user's recent
confirmed answer. Local filtering excludes other addressees, commands, stale messages,
anonymous identities and unauthorized users. A bounded tool-free Pi classifier must
return REPLY before ordinary generation. Classification has its own durable checkpoint
and usage purpose, shares budgets and cancellation, and remains silent on uncertainty
or failure. Ignored candidates are cleared from conversation history; ordinary
consented collection remains independent. No dependency or SQL migration was added.

Local tests cover user/topic/bot/workspace isolation, shared replies, discussion
retrieval, prefix stability, compaction, duplicate events, completed-checkpoint recovery,
source changes, revocation, budget/turn limits and unknown-charge recovery. Live
classifier precision, Telegram visibility and provider cache hit rates remain staging
evaluation work. No deployment, BotFather changes or live messages were performed.
See [design](../design/group-conversations.md) and [examples](../../examples/group-conversations.md).

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **278 tests**
across 36 files passed. The full suite used disposable PostgreSQL, fake Telegram/model
transports, `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL` and
`bun test --timeout 30000`. Additional gate cases verify that changing addressee,
cancellation and source removal during classification suppress the answer.

## Local Podman deployment (2026-09-22)

Updated the existing `deepx-code-telegram-bot` stack using `compose.yaml` plus
`examples/code-truth.compose.yaml`. App and worker now run image ID
`sha256:e0a006674e7a7c8b99c0f7f19ff7cc7927a79c0bf3086a1c0cdbc96821118071`,
tagged `localhost/deepx-agent:release-20260922-topics` and
`localhost/deepx-agent:local`. This includes native Topic memory, group conversation
continuity and natural follow-ups. Model configuration retains Chat Completions.
PostgreSQL and Code Truth containers were not recreated.

Release evidence: the unchanged source had passed all 278 unit/integration tests
and check/typecheck/build; all 16 browser tests passed before deployment. The image
passed the Node 24.21.0 / Pi 0.85.1 runtime contract with networking disabled, and
migration plus app/worker startup passed against a separate disposable database.
Compose configuration validation passed. The production database had no queued or
running assistant work or pending/sending deliveries at the pre-cutover check.

A protected pre-deployment PostgreSQL archive was created and its archive directory
validated at `backups/deepx-pre-topics-20260922T043308Z.dump` (ignored by Git).
Migration completed successfully; the schema remains at 10 applied migrations.
Previous image `c8ef95b29cd6a212750d60096d59198d5f27579895f3ff203a845ba98bbd4c29`
is retained as `localhost/deepx-agent:rollback-pre-topics-20260922`.

Post-deployment app and worker health checks passed; `http://127.0.0.1:3000/readyz`
returned `ready`, and the new worker logged `telegram_polling_connected` at
2026-09-22 04:34:06 UTC. Temporary browser/database/smoke containers were removed.
No manual Telegram test message or paid model evaluation was sent. Actual follow-up
classification quality and cache hit rates remain live acceptance work.

## Silent unsupported media deployment (2026-09-22)

Non-text requests no longer receive the text-only pilot warning. Unsupported media,
including captions, is silently ignored by the ask/recap handler.

Updated the existing Podman app and worker to
`localhost/deepx-agent:quiet-media-20260922`, also tagged `:local`, image
`3d4f7a5356e571af1d9a60d2c4924b195fcd2e9da63235e5a78bf311dc4f1df1`.
Lint, strict TypeScript and build passed, along with all 278 tests against disposable
PostgreSQL and all 16 browser tests. The Docker-format image passed the isolated
Node runtime contract, migration and HTTP/UI startup smoke checks. Compose validated.

No runs or deliveries were active at the pre-cutover check. The protected backup
`backups/deepx-pre-quiet-media-20260922T0704.dump` was created and its archive directory
verified. The prior image `82dc91185b8992898417447f20e792dd4a74cbc887d4054cfc7b71e74b3655be`
is retained as `localhost/deepx-agent:rollback-pre-quiet-media-20260922`.
Migration completed successfully; PostgreSQL and Code Truth were not recreated.

Both replaced containers are healthy, liveness/readiness return `ok`/`ready`, and
Telegram polling reconnected at 2026-09-22 07:05:11 UTC. The removed warning is absent
from the deployed worker bundle. Temporary test containers were removed. No manual
Telegram test message or paid model evaluation was sent.

## Local Codex Podman backend — 2026-09-22

- Added the optional `podman` coding backend alongside the existing GitHub Actions
  default, with panel selection and per-repository setup/check commands pinned to
  the maintainer approval. Provider settings follow the inspected device's custom
  Responses-provider configuration. Workspace operators can save, replace and remove
  API keys in the panel; keys are encrypted and redacted. The supervisor environment
  variable `CODEX_PROVIDER_API_KEY` remains an optional fallback.
- Added a trusted supervisor, per-task rootless containers/volumes, bounded execution,
  temporary model proxy credentials, separate preparation and publication, durable
  task state, cancellation, restart reconciliation and retention cleanup. Publication
  rechecks authorization after minting repository-scoped GitHub write credentials.
- Validation: full suite with isolated PostgreSQL **286 passed**; final focused
  coding/runner suite after recovery hardening **24 passed**; browser suite **16
  passed**. Biome, TypeScript and Bun build passed. All three Docker image targets
  built with Podman; the app served health/setup/assets successfully. The real
  Podman smoke passed with fake Codex and a local Git fixture. Merged Docker Compose
  configuration validated. Tests excluded this device's HTTP proxy for loopback
  requests. No live model call, GitHub publication or deployment was performed.
- Panel credential follow-up: save/replace/remove uses workspace-bound AES-256-GCM,
  redacted responses, revision invalidation and active-task cancellation. The runner
  retains an encrypted credential only while preparing/running. Validation: **292
  tests passed**, **16 browser tests passed**, and **11 focused coding integration
  tests passed** after adding key-rotation cancellation coverage. Biome, TypeScript,
  build, all three image targets, app health/assets smoke, real Podman smoke without
  an environment API key, and Compose validation passed. No deployment performed.
- Existing Telegram issue-to-PR semantics remain. Codex session files/thread IDs
  are retained, but continuing a completed task from Telegram is not exposed yet.
  Live custom-provider execution and GitHub publication remain staging gates.
  See [local runner setup and boundaries](codex-podman.md).

## Codex panel credentials deployment (2026-09-22)

Updated the existing Podman stack with `compose.yaml`,
`examples/code-truth.compose.yaml` and `deploy/codex/compose.yaml`. App and worker
run `localhost/deepx-agent:codex-panel-20260922` (also `:local`), image
`8eb16f6b41ffd6d5c553b3f41437b8408902270929c7bda3d17f27ed8163caee`.
The new healthy Codex supervisor uses image `0028cf13ee5f`; the prebuilt local job
image is `39beb8943be7`. Private deployment configuration now includes the Codex
overlay, a generated runner authentication token and the rootless Podman socket.
Provider API keys are configured through the workspace panel; no provider key was
copied from the host or configured as an environment fallback. Existing workspace
backend selections and plugin enablement were preserved.

Pre-cutover counts showed no queued/running runs, pending/sending deliveries or
active coding tasks. A protected database archive was created and validated at
`backups/deepx-pre-codex-panel-20260922T100107Z.dump`; the previous private environment
was also backed up. The old app image remains tagged
`localhost/deepx-agent:rollback-pre-codex-panel-20260922`. Migration completed.
PostgreSQL and Code Truth containers were not recreated.

The rebuilt app image matches the previously tested image, and its isolated Node
runtime contract passed. Compose validation and deployment health checks passed.
The app serves the API-key management bundle, the worker reaches the supervisor,
and the supervisor confirms rootless Podman access. `/readyz` returns HTTP 200
with `ready`; Telegram polling reconnected at 2026-09-22 10:02:32 UTC.
No manual Telegram message, live model test or GitHub publication was performed.

## Local-only Codex and workspace device sign-in (2026-09-29)

Removed the GitHub Actions coding backend from new settings and dispatch. Existing
Actions tasks stop locally with a migration status. The Podman supervisor remains
the sole coding execution path. Split local work into preparation, setup, Codex,
checks and publication phases; setup and checks receive neither model credentials
nor GitHub write tokens. Improved timeout, patch export and cleanup handling.

Added a per-workspace sign-in choice beside the custom provider API key in the
Codex panel. ChatGPT device-code login runs in the supervisor, displays the
OpenAI verification link and one-time code, and seals the account cache per
workspace. Only the Codex implementation container receives a temporary copy;
disconnect and workspace deletion remove the stored credential. Device-code
tasks require selected private repositories and verify current GitHub visibility
again before issue creation and before starting Codex. The custom provider mode
and its per-workspace API key remain available.

Biome, TypeScript, Bun build and Compose validation passed. Focused coding and
device tests passed, including real Podman smoke for both sign-in modes with a
fake Codex executable and local Git fixture. The full suite with loopback proxy
disabled had 307 passes and two unrelated native Telegram Stop failures; the
additional repository privacy regression test passed afterward. The coding
panel browser scenario passed in the full browser run, while a separate run
summary assertion failed. At this validation point, no live ChatGPT sign-in,
model call, GitHub write or deployment was performed; the existing Podman stack
still ran its prior `:local` images.

## Local-only Codex Podman deployment (2026-09-29)

Updated the existing local stack using `compose.yaml`,
`examples/code-truth.compose.yaml` and `deploy/codex/compose.yaml`. The app and
worker now run `localhost/deepx-agent:device-20260929` (also `:local`), image
`2232179827b4d0cd66236d3c0ef87dd54b5ad43aee8f6ba097f8dfe6962ba46a`.
The Codex supervisor runs `localhost/deepx-codex-supervisor:device-20260929`
(also `:local`), image
`20ab636b90bd51f847d64c5a8097b23830f0769ca0bf483019cd3539d9219cad`.
The prebuilt job image is `localhost/deepx-codex-job:device-20260929` (also
`:local`), image
`22b9810f7af650ceef9ebed5e9b23ca4d834fe80a2d634e9a5ae2b84c8e25551`.

Pre-cutover checks found no active runs, deliveries or Codex tasks. A protected
PostgreSQL archive was created and validated at
`backups/deepx-pre-local-device-20260929T071754Z.dump`. Previous app,
supervisor and job images are retained under `:rollback-pre-device-20260929`.
Migration completed without changes. PostgreSQL and Code Truth were not
recreated.

The three images built successfully. The exact job and supervisor images passed
the real Podman smoke with fake Codex for provider-key and device-code tasks;
the app image passed the isolated Node runtime contract. Merged Compose
configuration validated. After cutover, app, worker and supervisor are healthy;
`/readyz` returns HTTP 200, the served UI bundle includes both sign-in methods,
the worker can reach the authenticated device-status endpoint, and Telegram
polling reconnected. No live ChatGPT sign-in, model call or GitHub publication
was performed.

## Verified Telegram GitHub account linking — 2026-10-05

Added private `/github connect`, `/github sync` and `/github disconnect` controls for
eligible members. GitHub App OAuth uses PKCE and a one-use ten-minute flow; the
same Telegram sender confirms the stable GitHub identity before linking. Encrypted
user/refresh credentials stay outside workspace API responses. Permission snapshots
sync about every five minutes, intersect user access with workspace-selected repos,
and appear in Members & access. Linked users' reads/issues require read access;
coding also needs write/admin plus the existing maintainer grant. Missing, stale or
failed snapshots deny access; downgrades invalidate pending work. Automatic token
rotation is serialized and refresh failures clear grants. Existing unlinked members
retain the manually configured policy; mandatory linking is not enabled globally.

Apply migration `012_github_users.sql`. Documentation and a runnable Telegram command
example were added. Local verification passed **328 tests across 41 files** against
disposable PostgreSQL and **18 browser scenarios**, including member permission
display and search. The final focused linking/permission suite passed **11 tests**.
The build, strict typecheck and checks scoped to these changed files passed.
Repository-wide lint still reported issues in concurrently edited Codex collaboration
files; these edits were preserved. The final table-layout follow-up also passed three
focused browser scenarios. No deployment, account connection, live Telegram
message or GitHub write was performed. See [GitHub linking](github-app.md#connect-a-verified-telegram-members-github-account)
and [command examples](../../examples/github-user-linking.md).

## Admin site custom domain (2026-10-05)

Deployment operators can configure the admin panel hostname from **Site domain**.
The persisted deployment setting updates admin origin checks and GitHub/Telegram
callback generation in the app and worker without restarting. Domain changes are
versioned and audited atomically, expire pending GitHub connections and require
explicit webhook re-registration. The original environment address remains a
recovery origin. DNS/TLS/proxy provisioning and reachability remain external and
unverified; the panel provides instructions and callback URLs.

Validation: all 350 unit/integration tests passed with isolated PostgreSQL and
`NO_PROXY=localhost,127.0.0.1`; lint, strict type checking and build passed. The new
browser scenario passed on desktop and at 390px width, including invalid-hostname
errors, retained drafts, saving and restoring the default address. Domain-specific
coverage includes operator-only access, Origin/CSRF, normalization, persistence,
revision conflicts, audit deduplication, secure cookies, generated GitHub callbacks
(including Telegram linking), explicit webhook registration and removed-origin
rejection. Public DNS, certificate issuance and live provider changes were not run.

2026-10-07 card update: **Update connected services** groups GitHub App URLs into
labeled, copyable rows and separates Telegram guidance. Copy controls briefly show
a check on success and provide manual-copy guidance if clipboard access fails.
Long URLs wrap on narrow screens in both themes. Before settings load, labels stay
visible and copy controls remain disabled, including after a failed initial request.
Polling needs no webhook update; webhook mode retains its status and explicit
registration action. Deterministic browser coverage in
`tests/browser/connected-services.e2e.ts` checks copying, clipboard failure,
loading/retry, both Telegram modes, and light/dark layouts at 1280px and 390px.

## Codex device sign-in recovery (2026-10-05)

The configuration dialog now shows progress while starting device sign-in, bounds
the request to 20 seconds, and unlocks controls with an actionable error if it
stalls. **Recheck connection** checks runner availability and recovers a pending
login without closing the dialog or discarding unsaved configuration. Pending
status polling uses bounded, sequential requests and ignores results after its
owning effect has stopped.

Lint, strict typecheck and build passed. All **352 unit/integration tests** passed
against disposable PostgreSQL. Four deterministic browser scenarios passed:
unavailable-runner recovery with draft preservation, code display and polling to
connected, failed-login retry, and timeout followed by recovery of a pending code.
The live `dev.stonegate.me` configuration dialog was inspected and reported the
runner unavailable; no live account login, model call or deployment was performed.
Restoring that deployment's runner and applying this UI change remain outstanding.

## Codex repository access through the connected GitHub App (2026-10-06)

Both Codex model authentication methods now support selected public and private
repositories. The connected workspace GitHub App supplies fresh installation
tokens scoped to the repository and operation, including private checkout access.
ChatGPT account authentication no longer adds a repository-visibility restriction.
Maintainer grants, connected-repository checks, account sign-in, reviewed approvals,
explicit Direct execution policy and publication fencing remain enforced.

Removed the private-only checks during proposal, reviewed issue creation, runner
start and continuous-task authentication recovery. Updated panel guidance and
operator examples. Historical private-only behavior above describes older builds.

Validation: lint, strict typecheck and build passed. All 400 deterministic tests
passed against disposable PostgreSQL with loopback traffic excluded from the host
proxy. Coverage includes public/private reviewed and direct starts, scoped GitHub
credentials, denied GitHub access, duplicate dispatch, maintainer boundaries and
account recovery after repository visibility changes. No production configuration,
account connection, GitHub write, Telegram send or deployment was performed.

## Automatic repository metadata refresh (2026-10-06)

Manage GitHub and Codex repository lists refresh while visible and on return from
GitHub. Five-second polling uses Metadata-read installation tokens, matches saved
repositories by numeric ID, updates names/visibility and matching Code Truth URLs,
and removes IDs no longer accessible to the App. New IDs still require workspace
authorization/selection. Expanded lists, selected IDs and unsaved editor values
remain intact; concurrent settings edits retain their version-conflict protection.
Failures retain saved metadata with a notice, and delayed responses cannot undo
disconnect, reconnect or revoked ownership. Webhooks remain disabled; this is near
realtime polling while the panel is open.

Validation: `bun run check`, `bun run typecheck`, `bun test` (411 tests against
disposable PostgreSQL) and `bun run build` passed. All 26 focused browser scenarios
passed across repository refresh/search, Codex sign-in and loading states, including
rename/link updates, retained drafts and stale-save rejection. No dependency or
migration was added. No live GitHub call, Telegram send or deployment was performed.
See [behavior and limits](github-app.md#automatic-repository-updates) and the
[manual staging check](../../examples/github-repository-sync.md).

## Compact run history and pagination (2026-10-08)

The runs API now returns explicit summary fields and pagination metadata, with a
default page size of 25 and a validated maximum of 100. The panel fetches 25 items
per page and retrieves full messages, attempts and delivery records only through
the existing detail endpoint. Page transitions discard previous-page rows;
loading, retry, empty and out-of-range states are explicit. Detail/back navigation
and browser history preserve the list offset. Workspace read and mutation
permissions are unchanged. See [the API contract](../design/admin-panel.md) and
[runnable requests](../../examples/runs.http).

Compatibility: list items no longer contain full run records, and the default
page size changes from 100 to 25. Clients needing details must use the detail
endpoint; clients needing 100 summaries can specify `limit=100`. The workspace
is still loaded from its JSON database record; this reduces response size and
summary construction work, not database reads. Offset pages can shift when new
runs arrive or retention removes older runs; they are not a snapshot.

Verification: `bash scripts/verify-skills.sh quality` runs dependency preparation,
quality/type checks, deterministic PostgreSQL tests, the build and Node runtime
contract. `bash scripts/verify-skills.sh runs-browser` prepares its own database
and runs the runs/admin browser suites, including desktop/mobile pagination,
on-demand details, loading/error recovery and preserved navigation.

## Dedicated run detail pages (2026-10-06)

Compact run cards link to `/admin/runs/:runId?workspace=:workspaceId` instead of
opening a modal. The page retains messages, coverage, pinned versions, the model
attempt timeline, delivery evidence and existing authorized recovery/cancel/retry
controls. Back to Runs preserves the workspace and list offset. Direct visits and
refreshes fetch a single run independently of list pagination through
`GET /api/admin/workspaces/:id/runs/:run`; missing runs and failed loads show an
explicit error with navigation and retry controls. Access remains scoped to the
workspace, and unlinked deployment administrators retain read-only run access.
See [the runnable requests and page URL](../../examples/runs.http).

Validation: `bun run check`, `bun run typecheck`, `bun test` (415 tests against
disposable PostgreSQL) and `bun run build` passed, with the host HTTP proxy disabled
for local test fixtures. Four browser scenarios passed for desktop/mobile layouts,
keyboard navigation, direct visits, refresh, back navigation, pagination, load
recovery and switching to a missing run. Desktop and mobile screenshots were
reviewed. No dependency or migration was added.

### Bot access follows active membership (2026-10-07)

All active workspace members can use the bot. The Members & access page no longer
shows access modes, a whitelist column/toggle or policy preview/apply controls.
Roles, repository grants, workspace pause and member deactivation still apply to
requests, callbacks, queued work, schedules and delivery. Access-request approval
and owner verification enroll active members without a second access list.

Migration `015_remove_workspace_whitelist.sql` removes saved workspace policies
and preserves their concurrency revision as `memberVersion`. Active members
previously excluded by a whitelist now have bot access; listed non-members remain
non-members, and existing cancelled work/suspended schedules retain their state.
The member API returns a membership revision with searchable, paginated profiles;
retired access-policy API routes are unavailable. Old browser links still redirect.

Deterministic and PostgreSQL checks cover active/inactive/non-member and role
boundaries, revocation of runs/approvals/schedules/delivery, stale edits, last-admin
protection, access-request replay, repeated migration and retired APIs. All 17 admin
browser tests passed, including membership deactivation/reactivation across reload,
removed controls, Telegram profiles, desktop/mobile layouts and setup enrollment.
Lint, TypeScript and production build passed. See [membership and access](../design/access-control.md).
