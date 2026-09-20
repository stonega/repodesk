# Implementation evidence — 2026-09-18

The repository now contains the local P0 bot/admin/worker implementation. It has not
been connected to a live Telegram bot or paid model account, deployed to a public host,
or accepted by a pilot team. Those external gates remain unchecked in the bot plan.

## Implemented

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

Advanced skill/workflow editing uses JSON forms validated by shared server schemas.
Skill testing is a deterministic policy/prompt preview. Live model-quality testing is
an explicit, separately capped operator evaluation; it has not been performed.
Optional Telegram web login remains deferred; verified Telegram linking plus local
account sessions is the implemented authentication path. Group migration suspends and
requires relinking rather than automatically authorizing a new chat.

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
