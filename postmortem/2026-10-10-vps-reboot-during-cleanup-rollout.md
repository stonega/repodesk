# VPS reboot during cleanup rollout

Date: 2026-10-10. Scope: operator-approved automatic storage cleanup and immediate
host/CI cleanup. The application remained on its existing v0.1.34 release.

## Evidence and impact

Host cleanup first completed successfully, removing 50 eligible obsolete release
tags and unused build cache. Free disk space increased from 7.9GB to 51GB. The
daily systemd timer was enabled. Production container identities, volume names
and the current-release marker matched the pre-cleanup snapshot.

While rebuilding the Actions runner image, SSH disconnected during final image
export/unpacking. Reconnection showed a new host boot and restarted production
and CI containers. All were already healthy when inspected. No reboot command
was issued by the rollout; only the idle updater and later the idle CI runner
were deliberately restarted. The host reboot caused a service interruption;
its exact duration was not measured. GitHub reported the CI runner idle before
the rollout, and no workflow was dispatched as part of this work.

Observed UTC times from host records:

- 07:16:36: creation timestamp of the new runner image.
- 07:17:47: last retained entry of the previous boot's journal.
- 07:18:06: first retained entry of the new boot.
- 07:19:30: SSH inspection found the new boot and all containers healthy.
- 07:28:14: the replacement runner reported reconnection and listening for jobs.

These observations do not establish the precise start or end of downtime.

## Cause

Unconfirmed. The available previous-boot kernel journal did not report an OOM,
kernel panic, watchdog reset or shutdown reason. Systemd logged transient Docker
cgroup process-move failures during builds, but those messages do not establish
a connection to the reboot. Image export was in progress; timing alone does not
prove that the build or cleanup caused the reboot. Provider console/hypervisor
events were not available in this investigation.

## Recovery and final validation

Docker's restart policies brought the existing containers back. The updater and
daily cleanup timer also resumed after boot. Production container IDs, volume
names and the current-release marker remained unchanged. The new runner image
persisted as `sha256:f42dc546f9e345ede479ca6d646c6450afdc0b38e26042aaeffa0cb366c84899`.

Before replacing the registered runner, the exact new image passed the isolated
VPS smoke: nested CPU/memory/PID limits, removal of an unused test volume and
retention of a stopped container's image and volume. Replacement occurred only
after GitHub and the local process check reported idle. The existing registration
and both outer volumes were preserved. A transient stale-session error resolved
through the listener's normal reconnect; no re-registration was performed.

Immediate cleanup of the labeled isolated CI daemon succeeded. Final checks found
all containers healthy, public readiness HTTP 200, GitHub runner ID 21 online,
matching host-script hashes, and the daily timer enabled/active. Disk usage was
39%, with 60GB free. No production database/task volume, credential, backup or
release metadata was deleted. The manual hook run verifies live cleanup; automatic
invocation still needs observation after a naturally completed GitHub job.

## Follow-up

Obtain provider console or infrastructure events before assigning a root cause
or choosing a prevention change. Retain the previous updater and runner image for
recovery. Continue to smoke-test exact runner images before replacement and to
check production health and storage identities after maintenance.
