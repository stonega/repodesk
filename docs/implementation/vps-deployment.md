# Release deployment on a custom VPS

RepoDesk now installs approved GitHub releases through a host-side updater.
The previous `.github/workflows/deploy.yml` is removed. GitHub Actions verifies
code; it does not transfer images or deploy to the VPS. Publishing a stable
release makes it available in the panel's version indicator. A deployment
administrator reviews its notes and starts installation explicitly.
See [host updater installation](updates.md) for the service and panel contract.

## Provision the host once

Use a dedicated Linux x86_64 Docker stack with Docker Engine, Compose v2
(supporting `up --wait`), Node 24, Git, Bash, gzip, sha256sum and flock. Reserve
enough disk for local builds, four images, release archives and database backups.
The updater service requires noninteractive Docker and deployment-directory access.
It handles app, worker, migrations, PostgreSQL, Code Truth and the Docker Codex
runner. Custom local build overlays remain separate. Code Truth is always
available internally; workspace enablement controls indexing and tool access.
Its generated service token and indexes persist in `code_truth_auth` and
`code_truth_data` volumes under the existing Compose project.

Before the first release with bundled Code Truth, install the current host
updater using [the updater instructions](updates.md#install-the-host-updater-once).
Older daemons build only three images; their incomplete bundles are rejected
before stopping writers. Manual archives must include the Code Truth image and
`code-truth-tag` artifact; local-image bundles also require `code-truth-id`.

Keep the running deployment directory and Compose project stable. The default
root is `/opt/repodesk`, and the default project is `repodesk`:

```text
/opt/repodesk/
  .env
  secrets/encryption-key
  secrets/codex-runner-token
  updater/update-host.mjs
  updates/requests/
  updates/results/
  updates/logs/
  releases/
  backups/
  .current-release
```

Provide dedicated runtime configuration in mode-600 `.env`:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-URL-safe-password
PUBLIC_ORIGIN=https://repodesk.example.com
TELEGRAM_TRANSPORT=webhook
APP_PORT=3000
```

Keep `secrets/` mode 700. Generate a new encryption key only for a new database:
`openssl rand -hex 32 > secrets/encryption-key`. The runtime Node user must be
able to read the mounted key (for example mode 644 within that private directory).
Preserve the original encryption key, database password, Compose project and
Codex runner state across updates. On SELinux hosts, apply container-readable
labels through host policy. The cutover verifies secret access before stopping
writers. Configure encrypted off-host backups and retention separately.

Route host HTTPS to the app's loopback port (default `127.0.0.1:3000`). PostgreSQL
and the updater have no public ports. Use an SSH tunnel to claim a new `/setup`
before opening public access, then configure and activate the bot separately.
Installation never registers webhooks, connects accounts or sends Telegram messages.

A first installation can use the documented Compose setup and Docker Codex
configuration; install the host updater after the stack is healthy. Existing
release-bundle deployments retain their original project/root. No GitHub SSH
secrets, production deployment environment or Actions write token is required.

## Host release build and cutover

The daemon checks the selected release ID, fingerprint and tag commit against
GitHub and requires a successful Verify run for that commit. It fetches the exact
commit, validates its package version, builds app, Code Truth, Codex task and
supervisor images, smoke-tests the app's Node runtime and runs the service's
offline real-index/MCP smoke. Builds run on the host before stopping any
services. It records the locally built app, Code Truth, supervisor and task image
IDs with release files in a fresh numeric bundle directory and invokes
`scripts/deploy-vps.sh --local-images`. The same-daemon path requires no duplicate
image archive. Manual transferred archives retain checksum/import verification.

The script:

1. Acquires the deployment lock and checks local release tags still match the
   verified image IDs, or verifies/imports a transferred archive. Concurrent
   host/manual cutovers cannot overlap.
2. Preserves the Codex token/state, validates Compose and secret access and pulls
   the pinned PostgreSQL image before stopping writers.
3. Waits for safe coding checkpoints, stops app/worker and checks again for a
   just-started attempt before replacing the runner. Existing task containers
   finish their current phases; they are not cancelled to accelerate an update.
4. Starts the pinned runner and Code Truth with its persistent token initializer,
   then saves a restrictive PostgreSQL custom dump and verifies its archive listing.
5. Runs migrations once; writers remain stopped if migration fails.
6. Starts app/worker, verifies Code Truth authentication from both writers and checks app readiness
   for up to two minutes, allowing the first Telegram long poll to finish.
   Response bodies and service tokens are not printed in checks.
7. Updates `.current-release` only on success and removes any transfer archive.

The checkpoint budget defaults to 1800 seconds across both checks. It can be
shortened with `CODEX_DEPLOY_CHECKPOINT_TIMEOUT_SECONDS` (1–1800) in the host
service environment. A timeout before cutover leaves the old runner intact and
restarts only writers that were running before the second wait. This is an update
wait, not a coding execution limit. The updater's queue/results survive app
replacement. Inspect progress in the modal and protected host logs.

## Failure and recovery

Release/CI verification or image-build failures leave running services untouched.
Missing configuration, checksums, invalid bundles, secret access and checkpoint
failures are explicit preflight errors. Once runner replacement or database
cutover begins, backup, migration, startup or readiness failure stops app/worker
and preserves the previous `.current-release`. That marker records the last
successful release; it does not prove the old services are still running.

Inspect the failed bundle and protected logs/backups. Prefer rolling forward
with a corrected release. An explicit Retry update creates a fresh bundle and
backup. An agent restart during cutover records an uncertain outcome rather than
replaying it. Reconcile host processes and schema before clearing its reservation.
Never remove volumes or restore/revert automatically. Use
[the recovery runbook](release-runbook.md) for data and unknown delivery outcomes.

Only restart a previous image after confirming schema compatibility:

```sh
cd /opt/repodesk
release_id=$(cat .current-release)
docker compose --project-directory "$PWD" -p repodesk \
  --env-file .env --env-file "releases/$release_id/release.env" \
  --env-file "releases/$release_id/codex.env" \
  -f "releases/$release_id/compose.yaml" \
  -f "releases/$release_id/codex-compose.yaml" \
  up -d --no-deps --no-build --pull never --wait app worker
```

For bundles before Docker Codex integration, omit `codex.env` and its overlay.
Preserve `secrets/codex-runner-token` and `codex_runner_state` together. Temporary
runner outages keep queued tasks retryable; durable cleanup/publication identities
prevent double charges and blind repeated GitHub writes. Apply retention to old
images, bundles, backups and updater logs. Provisioning and a direct cutover were
verified on the recorded VPS on 2026-10-09 for `cfffdfc` (v0.1.32), with protected
backup, migration 017, healthy services, public readiness and updater queue access.
The modal's v0.1.34 retry was verified on 2026-10-10 after recovering disk space;
it used that release's original archive path. A published release containing the
new direct local-image path still needs its live check.

A manual archive cutover on 2026-10-13 deployed package v0.1.36 from the verified
worktree snapshot `bd6c3dc446f33b72e3bd68793b31769de0617a4f`, using bundle
`1791874171029-72300379`. Its source archive and checksum metadata remain in the
bundle. Migration 019 removed legacy Codex and Review Bot repository grants;
post-cutover checks found no remaining plugin repository arrays. The protected
pre-release backup passed archive verification, all application containers were
healthy and public readiness returned HTTP 200. This verifies the transferred
archive path; the published-release local-image updater gate remains separate.

The 2026-10-14 manual archive cutover deployed clean commit
`2dd613aae9fe14abf07fcbc15abfc4d87e940571` (package v0.1.36) in bundle
`1791958130084-55435898`. The retained source archive and verification report
identify the exact deployment. Local validation passed 737 deterministic tests,
239 browser scenarios and exact-image Node/Compose/backup/restore smoke checks.
The protected pre-release backup passed archive verification; all four production
services are healthy and public health, readiness, admin and asset checks returned
HTTP 200. Configuration, secrets, database and runner-state volumes, PostgreSQL
and CI runner identities were preserved. No migration was added. This remains a
manual archive deployment, separate from the published-release updater gate.

The later 2026-10-14 cutover deployed clean commit
`1afd6f5f58b2a5b31a9e1006ec6bcdc7ffadd526` (package v0.1.37) in bundle
`1791965539905-97510167`, including single-account invites/countdown and GitHub
member account updates. Its Verify workflow passed; the exact images passed local
Node runtime, Compose, migration rerun and backup/restore smoke checks. The host
verified the transferred archive, waited for durable coding checkpoints, verified
the protected pre-release backup and completed readiness checks. All four services
are healthy; public health, readiness and admin requests returned HTTP 200, with
served JavaScript/CSS matching the verified image. Configuration, secrets, database
and runner volumes and existing PostgreSQL/CI runner identities were preserved.
No migration was added. Source, CI and post-deployment receipts remain in the
bundle. This is another manual archive deployment, separate from the published
release updater gate.

## Google confirmation topic deployment (2026-10-24)

The operator-authorized manual archive cutover installed source tree
`45dbf03ccdf3f1c943eeab23215448571d5986d3`, based on pushed fix commit
`5f222bfe13034287d068040a08f64f1f55e7d6e8`, in bundle
`1792842855984-15165143` (package v0.1.44). It replaces bundle
`1792808351773-02844639`. The snapshot retains the previous deployment's group
dialog and other runtime sources; only `src/google/config.ts`,
`src/google/service.ts` and `src/google/telegram.ts` change application behavior.
No dependency or database migration was added.

All four images were built from the isolated retained snapshot. Lint, strict
TypeScript, build, all **1,190 deterministic tests across 130 files** with the
CI-standard 15-second timeout and **44 focused browser checks** passed. Browser
checks covered Google, group dialogs, the catalog, service URLs and updates, using
a separate test port and disposable database filename. The bundle retains the
test isolation patch; no full browser-suite result is claimed for this cutover.
Exact-image Node 24 runtime, CPU transcription imports, offline Code Truth,
Docker Codex lifecycle, merged Compose, readiness, migration rerun and disposable
backup/restore checks passed. All nine frontend artifacts match the prior image.

The guarded cutover verified archive/source checksums, waited for durable coding
checkpoints, stopped writers and verified
`backups/pre-release-1792842855984-15165143.dump` before migrations. App, worker,
runner and Code Truth are healthy. All 45 deployed artifacts match the tested
images; public and loopback health, readiness, admin and versioned asset requests
return HTTP 200. Configuration, credentials, persistent volumes, PostgreSQL and
all three Actions runners were preserved. The verified receipt and source remain
in the bundle; the imported image archive was removed after success.

No account was connected, consent confirmed, webhook registered or manual Telegram
message sent by deployment. Existing flows without a saved topic keep their old
destination; members start `/google connect` again to receive confirmation in the
initiating topic. Live consent/confirmation after this rollout remains a member
acceptance check. See the [incident](../../postmortem/2026-10-24-google-confirmation-topic.md).

## Group management dialog deployment (2026-10-24)

The operator-authorized manual archive cutover installed source tree
`435eb33600b278edf3dba13ebee3e9e80f260230`, based on commit
`7ddfd760057269dfe7cba31b2633a45b6279383a`, in bundle
`1792808351773-02844639` (package v0.1.44). It replaces bundle
`1792800488147-74185335` and moves group management actions into an Edit dialog
opened by the card's top-right pencil icon. No migration was added.

All four release images built from the retained source snapshot. Exact-image
Node runtime, CPU transcription imports, offline Code Truth, merged Compose,
readiness, migration rerun and disposable backup/restore checks passed. The full
browser run passed 382 scenarios. Two stale plugin-catalog expectations were
corrected for the seventh built-in plugin and passed on rerun; the bundle retains
that test-only change as `validation-test-correction.patch` separately from the
application build snapshot.

The protected cutover verified archive checksums and durable coding checkpoints,
then created and validated
`backups/pre-release-1792808351773-02844639.dump`. App, worker, runner and Code
Truth are healthy. All 45 packaged artifacts match the tested images; public and
loopback `/healthz`, `/readyz`, `/admin` and versioned assets return HTTP 200 with
matching JavaScript/CSS hashes. Configuration, credentials, persistent volumes,
PostgreSQL and all three Actions runner containers were preserved.

The initial post-deployment helper missed versioned asset URLs, and the default
Python HTTP client received an edge HTTP 403. Correcting the URL matcher and
identifying the deployment client completed verification without further service
changes. The original logs and final `deployment-receipt.json` remain in the
bundle. The imported image archive was removed after success. No manual Telegram
message, account connection or webhook registration was performed.

## Reference-source blocker fix deployment (2026-10-23)

The operator-authorized manual archive cutover deployed commit
`b4bac2e15e7083f7800cc0a36813a11ed8187483` (package v0.1.44) in bundle
`1792747504017-26715920`, replacing bundle `1792737476277-54958102` from `1261479`.
The snapshot includes the Codex reference-source/blocker correction and the
previously committed Plugins page changes. No database migration was added.

All four images were built from an isolated checkout of that exact commit. Node 24
runtime, Code Truth offline real-index/MCP, full Docker Codex lifecycle/reference
smoke and merged Compose checks passed. The host verified the image and source
archives, acquired the storage/deployment locks, waited for safe checkpoints,
stopped writers, verified its restrictive database backup and completed migrations
and readiness checks through the existing script. Secrets, database, runner state,
PostgreSQL and the separate Actions runners were preserved.

Post-cutover checks confirmed the pinned image identities and exact server, worker,
frontend, supervisor and task artifact hashes. App, worker, runner and Code Truth
are healthy; public `/healthz`, `/readyz` and `/admin` return HTTP 200. Source,
image metadata, verification logs and `deployment-receipt.json` remain in the
bundle; the imported image archive was removed after success. The protected backup
is `backups/pre-release-1792747504017-26715920.dump` and its archive listing verified.

The incident task remains waiting at revision 4 with no live attempt. Deployment
did not continue or publish it; its next authorized input uses the new source
preparation. This manual source snapshot deployment is separate from publishing
a stable GitHub release or exercising the hosted updater's release-selection gate.

## Operator-requested fresh installation (2026-10-18)

At the operator's explicit request to clear the deployment **including data**, the
VPS at `169.58.58.71` was reset and redeployed from clean commit
`cea5d410fa06b0e3c9cf2b420b1a3d7020238c99` (package v0.1.39), in bundle
`1792281550088-85350776`. This was a destructive fresh installation, separate from
the normal data-preserving update procedure above.

The old PostgreSQL and Codex runner volumes, six retained task containers and
their three volumes, prior backups, credentials, update history and deployment
artifacts were removed. The database password, encryption key and runner token
were regenerated. HTTPS routing, the Compose project and the separate Actions
runners were retained. No admin, workspace, bot or external account was created
or connected. The fresh database had zero admins/workspaces and `claimed=false`.

Biome, strict TypeScript, build and all **863 deterministic tests** passed with
disposable PostgreSQL. The exact app, supervisor and task images built; Node 24
runtime, full-stack Compose readiness, fresh migrations/rerun and backup/restore
smoke checks passed. The browser suite could not start because another local test
server occupied port 3107; no browser-suite or rendered-UI verification is claimed.
The host verified the image archive before stopping services and reused the
normal protected deployment script against fresh volumes. All four services were
healthy after cutover; public health, readiness and setup checks returned HTTP 200,
with setup uninitialized. Public JavaScript/CSS matched the verified image.
The host updater and cleanup timer resumed. Source, verification, reset receipt
and protected logs remain in the bundle; the temporary upload and duplicate
bootstrap secrets were removed. Complete first-run setup at
`https://dev.stonegate.me/setup` and reconfigure connections before using the bot.

## Custom domain from the panel

Sign in as a deployment administrator and open **Deployment → Site domain**.
Use **Add custom domain** (or **Edit domain**) and enter a hostname such as
`admin.example.com`, without `https://`, a port or a path. This setting overrides
`PUBLIC_ORIGIN` for generated callback URLs and adds the new HTTPS origin to
allowed admin requests immediately, across the app and worker. No restart or
`.env` edit is needed. Keep the original configured address routed for recovery.

Prepare DNS and HTTPS before switching:

1. At your DNS provider, add an A record pointing the hostname to the VPS public
   IPv4 address. Add AAAA only if your server and proxy also serve IPv6.
2. Configure your existing HTTPS proxy to serve this hostname and forward to the
   app's loopback port. For host-installed Caddy with the default `APP_PORT=3000`,
   the site block is:

   ```caddy
   admin.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Adjust the upstream port if `APP_PORT` differs. A containerized proxy needs a
   reachable container upstream instead of host loopback. Caddy can obtain and
   renew HTTPS certificates when DNS points to the server and ports 80 and 443
   reach it. See the [official Caddy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).
3. Save the domain in the panel, open its HTTPS address and sign in there. The
   panel stores the hostname; it does not verify DNS or HTTPS availability or
   modify infrastructure. The original site remains an allowed recovery origin.
4. For existing GitHub Apps, copy the Homepage URL, Callback URL and Setup URL
   shown in **Site domain** into GitHub App settings. Pending connections are
   cancelled by domain changes and must be started again. New App manifests use
   the saved address automatically.
5. In webhook mode, use **Register Telegram webhook** only after HTTPS is ready.
   Domain changes clear the saved webhook-ready status but leave the existing
   remote webhook until you explicitly register the new address. Polling mode
   requires no webhook changes.

To remove a custom domain, open **Edit domain → Use default address**. This restores
`PUBLIC_ORIGIN`, revokes the removed origin for admin writes, and requires the same
callback/webhook updates. Saving uses an independent revision; a stale editor
must reload current settings before retrying. Domain changes and their operator
are recorded atomically in the deployment audit. The setting persists in the
existing deployment JSON record, so no database migration is needed.
