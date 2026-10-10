# Automatic VPS storage cleanup

Host release images and the three isolated CI Docker daemons have separate retention
policies. Neither policy removes production database or Codex task volumes,
runner registration, credentials, backups or release metadata.

## Host: daily release image and build cache retention

`scripts/cleanup-host.mjs` defaults to a dry run. In apply mode it removes only
RepoDesk release tags older than 24 hours. It retains the current release plus
the two newest complete app/job/supervisor image sets as rollback candidates.
These candidates are complete local builds, not evidence that a previous
deployment succeeded; verify schema compatibility before rollback. All images
referenced by existing containers, including stopped task containers, remain.
Other image repositories and tags are outside the policy. Shared IDs retain
every release alias when any alias belongs to a retained image set.

The script rechecks image identity and container references before each removal,
uses no forced image deletion, and does not prune host containers, volumes or
networks. Unused host build cache is pruned with a 4GB retention target. Shared
or active cache can remain above the target; it is not a total Docker disk limit.
Missing/malformed current-release metadata stops cleanup before deletion.

The updater holds `.storage.lock` throughout checkout, builds and cutover.
Cleanup takes this same lock, then `.deploy.lock`, and skips a busy installation.
Direct manual cutovers retain their existing deployment lock. Install the matching
updater before enabling cleanup: an older updater does not take the storage lock.

On a provisioned, idle installation, copy both scripts together and restart only
the host updater. This does not restart app/worker or the Codex runner:

```sh
sudo install -m 700 scripts/cleanup-host.mjs /opt/repodesk/updater/cleanup-host.mjs
sudo install -m 700 scripts/update-host.mjs /opt/repodesk/updater/update-host.mjs
sudo systemctl restart repodesk-updater
sudo node /opt/repodesk/updater/cleanup-host.mjs /opt/repodesk --dry-run
```

Review the dry run before activating permanent deletion. Adjust the deployment
root and Node path in the service template for a different installation:

The recorded VPS uses `/opt/repodesk/updater/node` rather than a Node executable
on the SSH PATH. Use that executable for the preview and in the cleanup service's
`ExecStart` on this host. Confirm it against
`systemctl show repodesk-updater --property=ExecStart` before installation.

```sh
sudo install -m 644 deploy/updates/repodesk-cleanup.service /etc/systemd/system/
sudo install -m 644 deploy/updates/repodesk-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now repodesk-cleanup.timer
systemctl list-timers repodesk-cleanup.timer
```

The timer runs daily with up to fifteen minutes of jitter and catches up after
host downtime. A busy deployment skips that day's run. For an immediate cleanup
after reviewing the plan, use `sudo systemctl start repodesk-cleanup.service`.
Inspect failures using `journalctl -u repodesk-cleanup.service`. Disable future
runs using `sudo systemctl disable --now repodesk-cleanup.timer`. Later host
updates copy both maintenance/updater scripts atomically per file; the separate
timer is installed once by an operator, not by a release check or local setup.

## CI: cleanup after each job

The runner image configures `ACTIONS_RUNNER_HOOK_JOB_COMPLETED` with the cleanup
hook outside its persistent registration directory. GitHub executes it
synchronously after workflow steps and before the next job. Each Docker operation
has a timeout; prune failures are visible in job logs and retried after subsequent
jobs without changing a completed job into a failure.

The hook explicitly targets the inner Unix socket and refuses a daemon without
the `repodesk.ci=true` label. Only that isolated CI daemon removes unused images
older than 24 hours, prunes unused build cache to a 2GB retention target, and
removes unreferenced disposable test volumes, including named volumes. Existing
containers and their volume references remain. Docker-driver cache GC is also
enabled with a 2GB target; separate Buildx builders have their own cache policies.

Update the runner through [its installation workflow](self-hosted-runner.md#install),
copying `daemon.json` and `cleanup.sh` alongside the Dockerfile, entrypoint and
Compose file. Rebuild/recreate each affected service only when GitHub reports
its runner idle. Keep each service's separate outer registration and Docker named
volumes. Existing registrations and production services remain in place. The hook
runs independently on each runner's own Docker daemon. An installation still
using the previous runner image has no
post-job cleanup hook.

## Recorded VPS activation, 2026-10-10

After operator approval, the matching host scripts and daily timer were installed
on the recorded VPS. The service uses `/opt/repodesk/updater/node`. Immediate host
cleanup completed successfully, removing 50 eligible release tags. The updated
runner passed an isolated smoke on the VPS and was replaced while idle, keeping
GitHub runner ID 21 and both outer volumes. Its inner daemon reports Docker
29.9.0 with `repodesk.ci=true`; the post-job hook path is configured and executable.
Immediate CI cleanup completed without prune failures. Final disk usage is 39%
with 60GB available. Production containers, volume identities and current release
are preserved; public readiness returns HTTP 200. The timer/updater remain active
after boot. No workflow was dispatched for this verification; a naturally completed
job will provide the next check of automatic hook invocation.

The VPS unexpectedly rebooted during CI image export. The image persisted and
passed smoke afterward; available logs did not identify the reboot cause.
See [the incident record](../../postmortem/2026-10-10-vps-reboot-during-cleanup-rollout.md).

## Verification and limits

Deterministic tests exercise retained/current/referenced images, aliases, partial
builds, changed tags, dry runs, malformed metadata, lock contention and the CI
daemon boundary. `scripts/actions-runner-smoke.sh` runs the actual hook against an
isolated Docker daemon, verifies an unused test volume is removed, and preserves
a stopped container's image and volume. Deployment checks include Docker image
builds, Node runtime smoke, Compose validation and systemd unit validation.

This policy does not manage backup retention, application task retention or the
runner's `_work` directory. Those require their existing application/operator
policies. Disk can still fill if active task volumes or retained images grow;
the updater's free-space preflight remains in place.

References: [Docker image removal](https://docs.docker.com/reference/cli/docker/image/rm/),
[build cache pruning](https://docs.docker.com/reference/cli/docker/builder/prune/),
[Docker cache GC](https://docs.docker.com/build/cache/garbage-collection/),
[GitHub runner job hooks](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts).
