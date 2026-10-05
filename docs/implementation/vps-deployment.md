# Release deployment to a custom VPS

The repository includes `.github/workflows/deploy.yml`. Publishing a **stable
GitHub Release** runs the reusable verification workflow, builds and smoke-tests
the exact release tag, and transfers the application image over verified SSH.
Drafts, prereleases and tag pushes alone do not deploy. The workflow must be
included in the released tag. No registry account or token is required.

This automates the base Docker stack: app, worker, migrations and PostgreSQL.
It does not deploy the optional Code Truth or Podman Codex services or Compose
overlays. Use a dedicated stack; do not point it at the existing local Podman
installation. The VPS must be Linux x86_64 with Docker Engine, Compose v2
(supporting `up --wait`), Bash, gzip and `flock`, and enough disk for the loaded
images, release archive and database backup. The GitHub-hosted runner must be able
to reach its SSH port. The deploy user needs Docker access without interactive sudo.

## Provision the host once

Create a dedicated deploy user and install its SSH public key. Keep the private
key in GitHub only. With that user, create a deployment directory (default
`/opt/repodesk`, owned by the deploy user) with this layout:

```text
/opt/repodesk/
  .env
  secrets/encryption-key
  releases/                 # created by the workflow
  backups/                  # protected pre-migration dumps
  .current-release          # written after a successful readiness check
```

Use `.env.example` as a reference, but provide a dedicated VPS configuration:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-URL-safe-password
PUBLIC_ORIGIN=https://repodesk.example.com
TELEGRAM_TRANSPORT=webhook
APP_PORT=3000
```

Keep `.env` mode 600 and `secrets/` mode 700. Generate a new encryption key for a
new stack with `openssl rand -hex 32 > secrets/encryption-key`. Ensure the runtime
Node user can read the mounted key (for example, file mode 644 inside the private
mode-700 directory). Preserve this key across releases and back it up separately.
An existing database requires its original key and password.
On SELinux hosts, the mounted key also needs a container-readable label. Configure
that label through your host policy; Unix file permissions alone are insufficient.
The deployment checks key readability inside the image before stopping writers.

Configure the host HTTPS reverse proxy to forward to `127.0.0.1:3000`. PostgreSQL
is never exposed publicly. On a new stack, use an SSH tunnel to claim `/setup`
before opening public access. Complete bot/model setup and explicitly activate
and register the webhook afterward; deployment does not register webhooks or
connect accounts. Configure encrypted off-host backups and retention separately.

## Configure GitHub

Create a GitHub Actions environment named **production**. Add the following
environment secrets (repository secrets also work):

| Secret | Value |
| --- | --- |
| `VPS_HOST` | VPS DNS name or IPv4 address |
| `VPS_USER` | Dedicated SSH deploy username |
| `VPS_SSH_KEY` | Complete private SSH key, without a passphrase |
| `VPS_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for the VPS |

Obtain the host key through a trusted host console and verify its fingerprint
before saving the known-hosts entry. `ssh-keyscan` can collect a candidate, but
alone does not verify the host's identity. For a custom port the entry uses
`[hostname]:port`. The workflow requires strict host-key verification.

Optional environment/repository variables:

| Variable | Default | Constraint |
| --- | --- | --- |
| `VPS_PORT` | `22` | SSH port, 1–65535 |
| `VPS_PATH` | `/opt/repodesk` | Absolute directory; letters, digits, `/`, `_`, `-` |
| `VPS_PROJECT` | `repodesk` | Stable Compose project name; lowercase letters, digits, `_`, `-` |

Keep `VPS_PATH` and `VPS_PROJECT` stable to preserve the PostgreSQL volume.
Environment protection rules must permit release tags. Required reviewers, if
configured by you, will pause the deploy job for GitHub approval.

## Publish and monitor

Commit and push the workflow and scripts before creating the release tag, then
publish a stable release from that tag. In Actions, inspect **Deploy release to
VPS**. Verification includes deterministic PostgreSQL and browser tests, Docker
smokes and a backup/restore rehearsal. The deploy job builds an amd64 image and
transfers it along with the release's Compose file and deploy script. SSH key
files are temporary and removed when the step exits.

The host loads the image and selects its immutable local `sha256:` image ID.
Unlike a registry `@sha256:` manifest digest, this identifies the image imported
by `docker image load`. It then:

1. Acquires a host lock, validates Compose and checks runtime secret access before
   touching running writers.
2. Pulls the pinned PostgreSQL image, stops app/worker and starts the database.
3. Writes a restrictive database dump and verifies its archive listing.
4. Runs migrations once; starts neither writer if migration fails.
5. Starts app/worker without building or pulling their image, waits for both
   health checks, and checks `/readyz` inside the app container.
6. Updates `.current-release` only on success and removes the transfer archive.

GitHub serializes deployment workflows without cancelling an active cutover.
An identical bundle cannot overwrite its earlier backup. To retry, use **Re-run
all jobs**: the run attempt receives a fresh release directory and backup name.
Deployment includes a brief outage while writers stop, backup and migrations run.
Stop workers only after active work has drained if a release needs a clean
cutover; this automation does not wait for application jobs to drain.

## Failure and recovery

Preflight failures leave running writers untouched. Once cutover begins, a
backup, migration, startup or readiness failure stops app/worker and leaves the
previous `.current-release` marker unchanged. A marker is a record of the last
successful deployment, not evidence that those containers are still running.
The workflow fails visibly; it does not automatically revert a migrated schema.

Use the failed release directory to inspect migration status and protected
backups. Roll forward with a corrected release. Only restart a previous image
after verifying its schema compatibility; use the explicit project, project
directory, Compose file and both environment files:

```sh
cd /opt/repodesk
release_id=$(cat .current-release)
docker compose --project-directory "$PWD" -p repodesk \
  --env-file .env --env-file "releases/$release_id/release.env" \
  -f "releases/$release_id/compose.yaml" \
  up -d --no-deps --no-build --pull never --wait app worker
```

Use the configured path/project if changed. Do not remove volumes or restore a
database automatically. Follow [the recovery runbook](release-runbook.md) for
restore and reconciliation of unknown delivery/provider outcomes. Retained
release directories, images and backups require an operator retention policy.

This workflow has local deterministic and container validation; an actual VPS
release deployment remains unverified until host provisioning, GitHub secrets
and a successful release run are complete.
