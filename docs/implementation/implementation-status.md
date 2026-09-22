# Implementation evidence — 2026-09-18

The repository now contains the local P0 bot/admin/worker implementation. It has not
been connected to a live Telegram bot or paid model account, deployed to a public host,
or accepted by a pilot team. Those external gates remain unchecked in the bot plan.

## Implemented

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
  enrollment/whitelist policy, consented received-message collection and scoped sources.
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
shows Telegram names/usernames and numeric IDs, role, membership, whitelist status
and effective access, including whitelisted IDs that are not enrolled. Access
requests and policy preview/apply controls share this page. Old access-policy URLs
redirect while preserving workspace query parameters; search/pagination also retain
those parameters. Existing member and policy APIs remain supported.

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
creates/reactivates regular membership, whitelists the verified Telegram ID and queues
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
