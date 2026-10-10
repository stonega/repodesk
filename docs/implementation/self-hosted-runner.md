# GitHub Actions runner on the VPS

The workflows use `runs-on: [self-hosted, linux, x64]`. The deployment in
`deploy/actions-runner/` provides three repository-scoped runners using Ubuntu 24.04,
Node 24, the checksum-verified GitHub runner, and Docker Engine with Buildx and
Compose from Docker's official package repository. Bun and Chromium are installed
by the workflows. The runner user has noninteractive sudo inside its container
for Chromium system dependencies.

Each runner starts its own Docker daemon inside a privileged container. It has
separate Docker storage, volumes and networking, so CI's ports 3000 and 5432 and
its disposable Compose stacks do not use the production daemon or host ports.
The container has no production Docker socket or application-directory mount.
It shares the VPS kernel and requires trusted workflow code.

On cgroup v2, the entrypoint moves its processes into an `init` child cgroup and
enables the available controllers before starting the inner Docker daemon. This
allows CI task containers to enforce their CPU, memory and PID limits. Enabling
controllers retries briefly to tolerate process-exit races and fails startup if
the hierarchy cannot be prepared. The initialization follows
[Moby's Docker-in-Docker wrapper](https://github.com/moby/moby/blob/master/hack/dind).

The outer Compose project is `repodesk-actions-runner`, separate from production's
`repodesk`. Each container is limited to two CPUs and 2 GiB of memory. The combined
memory ceiling is 6 GiB on the recorded four-CPU, 8-GiB VPS, leaving approximately
2 GiB for production and the host. CPU limits are shared ceilings, not reserved
cores; all three busy runners still compete with production for four host CPUs.
Each runner executes one job at a time, allowing up to three verification jobs
to run simultaneously. The browser suite remains one job with one Playwright worker.
Release installation runs on the host updater. Its deployment SSH secrets are
unused; the optional Codex diagnostics workflow can still use SSH credentials.

Verify runs quality/database checks, one browser job for the complete suite, and
application container checks. The browser job allows 30 minutes; quality and
application container jobs allow ten minutes each. Code Truth service checks and
the separate Codex image/lifecycle job are excluded from Verify. The host updater
builds app/Codex release images locally before its protected cutover.

## Install

Use the operator-provided SSH access recorded in [debugging](debugging.md).
The VPS needs its existing Docker Engine and Compose; no host Node installation
or production service restart is required. From the repository checkout:

```sh
tar -C deploy/actions-runner -cf - Dockerfile entrypoint.sh daemon.json cleanup.sh compose.yaml |
  ssh root@169.58.58.71 \
    'install -d -m 0755 /opt/repodesk-actions-runner && tar -C /opt/repodesk-actions-runner -xf -'
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml build runner &&
   docker compose --file /opt/repodesk-actions-runner/compose.yaml up --no-build --detach'
```

Each container waits for registration before starting the GitHub listener. Create
a short-lived repository registration token with an authorized local GitHub CLI
session and pass it directly over SSH; do not save a GitHub personal token on the
VPS or put the registration token in a Compose file:

```sh
for runner_service in runner runner-2 runner-3; do
  runner_name=repodesk-vps
  if [ "$runner_service" != runner ]; then
    runner_name="repodesk-vps-${runner_service#runner-}"
  fi
  # Preserve any existing registration, especially the original runner.
  if ssh root@169.58.58.71 \
    "docker compose --file /opt/repodesk-actions-runner/compose.yaml exec -T --user runner '$runner_service' test -f .runner"; then
    continue
  fi
  gh api --method POST repos/stonega/repodesk/actions/runners/registration-token --jq .token |
  ssh root@169.58.58.71 "
    set -eu
    IFS= read -r registration_token
    docker compose --file /opt/repodesk-actions-runner/compose.yaml exec -T --user runner '$runner_service' \
      ./config.sh --unattended --url https://github.com/stonega/repodesk \
      --name '$runner_name' --work _work --labels repodesk --token \"\$registration_token\"
  "
done
```

GitHub adds the default `self-hosted`, `linux` and `x64` labels. Each service has
its own registration/work volume and its own Docker-data volume. The original
`runner` and `docker` volume names are preserved; `runner-2`/`docker-2` and
`runner-3`/`docker-3` belong to the additional services. Never scale the original
service with `--scale runner=3`: replicas would share its named volumes and corrupt
runner registration or Docker data. Protect these volumes as runner credentials.
Register only once. Do not replace an existing runner registration during a job.

### Expand an existing installation

For a Compose-only change, retain the existing, smoke-tested runner image. Confirm
GitHub reports all affected runners idle and no `Runner.Worker` process is active
before recreating them. Copy the updated Compose file, validate it, then run:

```sh
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml config --quiet &&
   docker compose --file /opt/repodesk-actions-runner/compose.yaml up --no-build --detach'
```

The original `runner` keeps its registration and Docker cache. Run the registration
loop above to configure only the two new services, then verify all three online.
The workflows already match their labels; no workflow dispatch or application
release is needed to add capacity. Never recreate a busy runner to accelerate
this change.

## Verify and operate

Before installing a changed runner image, run the local resource-limit smoke:

```sh
docker build --tag repodesk-actions-runner:test deploy/actions-runner
bash scripts/actions-runner-smoke.sh repodesk-actions-runner:test
docker compose --file deploy/actions-runner/compose.yaml config --quiet
```

The smoke starts a disposable runner with the same CPU/memory limits, loads a
local image into its isolated Docker daemon and checks a nested container's
CPU, memory and PID limits on cgroup v2. It does not register a runner or contact
GitHub, Telegram or a model provider. Its containers and volumes are removed.
A successful `docker info` alone does not verify resource-limited task startup.
For an existing VPS installation, copy the updated runner files and recreate it
with the install command after GitHub reports every affected runner idle;
pushing the commit does
not update the running runner container.

```sh
gh api repos/stonega/repodesk/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml ps'
```

All three runners must appear online with all three required labels. Each container's
health check verifies the inner Docker daemon and GitHub listener process.
`restart: unless-stopped` restarts the runner with the host Docker daemon after
a reboot. To restart one deliberately, first check that GitHub reports `busy:false`
for that runner. Substitute `runner-2` or `runner-3` for the additional services:

```sh
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml restart runner'
```

The updated runner cleans unused inner Docker images, build cache and disposable
test volumes after each job, and configures Docker-driver cache garbage collection.
The hook checks the CI daemon label before pruning; the outer registration/data
volumes remain. See [automatic storage cleanup](storage-cleanup.md) for retention,
verification and activation. Monitor VPS disk space: CI image layers and release
archives can grow independently of production storage. Keep the named volumes
when recreating the runner container.
Pushing the workflow changes makes subsequent verification jobs eligible for this
runner; registering it alone does not publish a release or deploy the application.

## VPS verification, 2026-10-08

Installed in `/opt/repodesk-actions-runner` and registered `repodesk-vps` for the
private `stonega/repodesk` repository. GitHub reported it online and idle with
`self-hosted`, `Linux`, `X64` and `repodesk` labels. The container was healthy with
the configured two-CPU and 4-GiB limits; the host Docker service is enabled for boot.
The runner used version 2.337.0, Node 24.21.0, Docker 29.8.2 and Compose 5.6.0.

The inner daemon passed a Docker image build, an offline Node runtime check and
a port-3000 HTTP smoke while the production app still returned HTTP 200. All four
production containers remained healthy. Temporary smoke containers and their
test image were removed. Local lint, strict type checking, build, shell syntax,
Compose validation and all 586 deterministic tests passed.

No GitHub workflow was dispatched during setup. GitHub's verification workflow
still used `ubuntu-latest` at this checkpoint; commit and push the local workflow
edits before testing a complete Actions run on this runner.

## VPS expansion verification, 2026-10-10

Expanded the recorded VPS to three runners using the existing runner image after
its exact image passed the isolated smoke under the new 2-GiB memory limit.
The original runner was idle before recreation. Its registration ID 21 and both
named volumes remain; the new registrations are `repodesk-vps-2` (ID 22) and
`repodesk-vps-3` (ID 23). GitHub reported all three online and idle with the required
labels, and all three Compose containers are healthy with two-CPU/2-GiB limits.
The original listener briefly retried a stale GitHub session after restart and
reconnected without re-registration.

Each inner daemon reports `repodesk.ci=true`. Three simultaneous resource-limited
HTTP containers successfully bound the same internal port on their separate
daemons and returned their own runner markers. Nested CPU, memory and PID limits
passed on every runner. All temporary smoke containers/volumes were removed.
Production readiness returned HTTP 200. No application release or workflow
dispatch was performed as part of the runner expansion. A complete Verify run
using the new concurrent capacity remains unmeasured.

References: [GitHub runner registration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
[Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
