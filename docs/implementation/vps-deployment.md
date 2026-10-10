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
enough disk for local builds, three images, release archives and database backups.
The updater service requires noninteractive Docker and deployment-directory access.
It handles app, worker, migrations, PostgreSQL and the Docker Codex runner. The
optional Code Truth service and local Podman overlay remain separate.

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
commit, validates its package version, builds app, Codex task and supervisor images
and smoke-tests the app's Node runtime. Builds run on the host before stopping any
services. It records the locally built app, supervisor and task image IDs with
release files in a fresh numeric bundle directory and invokes
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
4. Saves a restrictive PostgreSQL custom dump and verifies its archive listing.
5. Runs migrations once; writers remain stopped if migration fails.
6. Starts app/worker and checks readiness for up to two minutes, allowing the
   first Telegram long poll to finish. Response bodies are not printed in checks.
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
