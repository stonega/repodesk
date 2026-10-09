# GitHub Actions runner on the VPS

The workflows use `runs-on: [self-hosted, linux, x64]`. The deployment in
`deploy/actions-runner/` provides one repository-scoped runner using Ubuntu 24.04,
Node 24, the checksum-verified GitHub runner, and Docker Engine with Buildx and
Compose from Docker's official package repository. Bun and Chromium are installed
by the workflows. The runner user has noninteractive sudo inside its container
for Chromium system dependencies.

The runner starts its own Docker daemon inside a privileged container. It has
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
`repodesk`. Its container is limited to two CPUs and 4 GiB of memory. One runner
executes one job at a time; verification jobs queue rather than running simultaneously.
The private repository's Actions secrets continue to provide deployment SSH access.

Verify runs quality/database checks, one browser job for the complete suite, and
application container checks. The browser job allows 30 minutes; quality and
application container jobs allow ten minutes each. Code Truth service checks and
the separate Codex image/lifecycle job are excluded from Verify. The release deploy
job still builds and smoke-tests the Codex images before transferring the release.

## Install

Use the operator-provided SSH access recorded in [debugging](debugging.md).
The VPS needs its existing Docker Engine and Compose; no host Node installation
or production service restart is required. From the repository checkout:

```sh
tar -C deploy/actions-runner -cf - Dockerfile entrypoint.sh compose.yaml |
  ssh root@169.58.58.71 \
    'install -d -m 0755 /opt/repodesk-actions-runner && tar -C /opt/repodesk-actions-runner -xf -'
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml up --build --detach'
```

The container waits for registration before starting the GitHub listener. Create
a short-lived repository registration token with an authorized local GitHub CLI
session and pass it directly over SSH; do not save a GitHub personal token on the
VPS or put the registration token in a Compose file:

```sh
gh api --method POST repos/stonega/repodesk/actions/runners/registration-token --jq .token |
  ssh root@169.58.58.71 '
    set -eu
    IFS= read -r registration_token
    docker compose --file /opt/repodesk-actions-runner/compose.yaml exec -T --user runner runner \
      ./config.sh --unattended --url https://github.com/stonega/repodesk \
      --name repodesk-vps --work _work --labels repodesk --token "$registration_token"
  '
```

GitHub adds the default `self-hosted`, `linux` and `x64` labels. Registration and
automatic runner updates persist in the runner volume; inner Docker images and
cache persist in a separate volume. Protect these volumes as runner credentials.
Register only once. Do not replace an existing runner registration during a job.

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
with the install command after GitHub reports it idle; pushing the commit does
not update the running runner container.

```sh
gh api repos/stonega/repodesk/actions/runners \
  --jq '.runners[] | {name,status,busy,labels:[.labels[].name]}'
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml ps'
```

The runner must appear online with all three required labels. Its container's
health check verifies the inner Docker daemon and GitHub listener process.
`restart: unless-stopped` restarts the runner with the host Docker daemon after
a reboot. To restart it deliberately, first check that GitHub reports `busy:false`:

```sh
ssh root@169.58.58.71 \
  'docker compose --file /opt/repodesk-actions-runner/compose.yaml restart runner'
```

Monitor VPS disk space: CI image layers and release archives can grow independently
of production storage. Keep the named volumes when recreating the runner container.
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

References: [GitHub runner registration](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners),
[Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/).
