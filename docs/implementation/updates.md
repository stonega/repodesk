# Release checks and host updates

Signed-in users automatically check the configured GitHub repository's latest
published stable release. A newer numeric version adds an update arrow immediately
after the version label (bottom right on desktop, in the mobile admin header,
or in the mobile setup footer). Click it to review the formatted changelog,
release-specific upgrade notes and deployment consequences in a modal. HTML,
scripts and remote images stay literal; links allow only HTTP/HTTPS. Missing
notes have an explicit empty state. Sign-in keeps the version without an action.

Checks run when the session opens, every minute while the page is visible and on
window focus. The server coalesces checks and caches metadata for fifteen minutes,
or one minute after a failure. Numeric stable tags, with or without `v`, are
supported. Drafts, prereleases, malformed tags, equal versions and downgrades are
never offered. Changelogs scroll within the modal; Update and Cancel stay ordered.

## Install the host updater once

Panel updates run on the installation host. The GitHub deployment workflow is
removed. The remaining Verify workflow supplies evidence that the selected commit
passed quality, deterministic database tests, browser tests and container checks.
The host builds images from that exact commit and reuses the existing protected
[backup/migration/readiness cutover](vps-deployment.md). Publishing a release makes
it discoverable; installation starts only after a deployment administrator clicks
**Update now**. No Actions write token or GitHub SSH deployment secrets are needed.

This currently supports the dedicated Linux x86_64 Docker VPS stack, including
its Docker Codex runner. It does not replace a custom Compose topology, the
optional Code Truth service or a local Podman overlay. See the VPS guide first.

On the provisioned host, copy the checked-in daemon and service template:

```sh
sudo install -d -m 700 /opt/repodesk/updater
sudo install -m 700 scripts/update-host.mjs /opt/repodesk/updater/update-host.mjs
# The app image's node user is UID/GID 1000. Root daemon can read its private queue.
sudo install -d -o 1000 -g 1000 -m 700 /opt/repodesk/updates /opt/repodesk/updates/requests
sudo install -m 644 deploy/updates/repodesk-updater.service /etc/systemd/system/repodesk-updater.service
# Edit root, project, repository, Node path and service user for this installation.
sudo systemctl daemon-reload
sudo systemctl enable --now repodesk-updater
```

Node 24, Git, Docker Engine/Compose v2, Bash, gzip, sha256sum and flock must be
available. The service must have the deployment user's Docker/filesystem access.
The sample uses root, which already has Docker's equivalent host privileges. A
matching deployment account may be configured instead; ensure it can read the
app's UID-1000 queue and write the host releases/backups. Do not grant Docker
socket access to the web app. Only the existing trusted Codex supervisor keeps it.

The base Compose app mounts `<deployment root>/updates` at
`/var/lib/repodesk-updates`. This contains requests, results and an updater
heartbeat. Keep the deployment root and Compose project identical to the running
stack so its database and Codex volumes are preserved. Restart the app once with
the new Compose configuration after provisioning. For a direct Node app set
`UPDATES_DIRECTORY=/opt/repodesk/updates`; it must reach this same queue.

Set `UPDATES_GITHUB_REPOSITORY=owner/repository` for a fork; the service's last
argument must match. Default: `stonega/repodesk`. Public repositories work without
a token. An optional fine-grained **Contents: read / Actions: read** token can
increase API limits or read private source/CI. Store it in the host's protected
`.env` for the app (`UPDATES_GITHUB_TOKEN`), or use a private mounted file for a
Node app (`UPDATES_GITHUB_TOKEN_FILE`). The host service can read its own token
file using the commented Environment entry. Restart after token rotation.
Credentials never enter requests, browser responses or ordinary app logs.

## Update and recovery

Only authenticated deployment operators can queue installations. Existing session,
origin and CSRF checks apply; workspace accounts can review notes. The server
rechecks release ID, notes fingerprint and tag commit before saving a reservation,
operator audit and atomic queue file. Concurrent clicks and app restarts produce
one request. A missing/stale heartbeat or mismatched host repository prevents
submission. No file is written by a release check or modal open.

The host verifies the exact published stable release and a successful Verify run
for its commit, fetches that commit, checks package version, builds app/Codex
images locally, and smoke-tests the Node app image. It rechecks release metadata
immediately before passing a checksummed bundle to `deploy-vps.sh`. The cutover
waits for safe coding checkpoints, stops writers, backs up PostgreSQL, migrates,
starts writers and confirms readiness. A changed release or unverified commit
fails before any cutover. Expect a brief outage; the queue and results survive it.

The modal polls queued/running/completed/failed status and offers Reload after
success. Installed version is checked after reload, separately from daemon
completion. Host logs are at `updates/logs/<request UUID>.log` (private); service
health is available through `systemctl status repodesk-updater` and `journalctl`.
Queue/result files contain release metadata, not secrets or conversation contents.

A failed job shows an explicit **Retry update** action after the operator reviews
logs and fixes the cause. It creates a fresh bundle/backup ID. Restarting the
agent during an active job records an uncertain outcome and never repeats cutover.
An interrupted or ambiguous request blocks further installations. Follow the VPS
recovery guide, confirm no old updater child or deployment is running, and clear
that reservation from `deployment_updates` by repository/release ID only after
reconciliation. Preserve its operator audit. Never restore a database or revert
a migrated image automatically. Retain backups and prune old sources/logs/release
images through an operator policy; successful source checkouts are removed.

[updates.http](../../examples/updates.http) documents the API. Local tests use fake
GitHub, host commands and queue fixtures. Host provisioning and a direct VPS
cutover were verified on 2026-10-09 for `cfffdfc` (v0.1.32), including public
readiness and queue access from the app. This host uses
`/opt/repodesk/updater/node` (v24.21.0, extracted from the verified app image) in
its installed service instead of a global Node installation. A subsequent
published-release installation initiated through the modal remains a live staging
gate; deterministic development checks do not deploy.

API references: [GitHub Releases](https://docs.github.com/en/rest/releases/releases),
[Verify run lookup](https://docs.github.com/en/rest/actions/workflow-runs).
