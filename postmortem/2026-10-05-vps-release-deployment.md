# VPS release deployment failed before startup

Date: 2026-10-05. Affected release: `v0.1.2`.

## Evidence and impact

[The first deployment attempt](https://github.com/stonega/deepx-telegram-bot/actions/runs/37261185259/job/111609361604)
passed verification, built and transferred the image, then exited without a
diagnostic. The host had no Docker installation, runtime `.env` or encryption key.
The script's initial configuration check returned status 1 before emitting output.

After provisioning the host, [the second attempt](https://github.com/stonega/deepx-telegram-bot/actions/runs/37261185259/job/111612031414)
loaded the image but failed with `No such image` when looking up the runner's ID.
Neither attempt reached writer startup or migrations; no existing application
database was modified.

## Root cause

The workflow assumed an image ID reported by the build daemon remained a valid
lookup key after `docker image load` on another daemon. The runner recorded the
configuration digest `a82752276cb3...`; the VPS containerd store reported the
imported image ID `3753abdf66b4...`. The archive's configuration blob matched the
runner digest and its release tag loaded correctly, proving the image transfer
succeeded. The failure was the cross-daemon ID lookup.

Fresh Docker Engine 29 installations use the containerd image store by default;
see [Docker's storage documentation](https://docs.docker.com/engine/storage/containerd).
The local Docker smoke used a classic store, which did not reproduce this mismatch.

## Correction and validation

Provisioned Docker Engine, Compose and protected runtime files without printing
credentials. The release bundle now carries its image tag and archive SHA-256.
The host checks the archive before import, resolves the imported tag on its own
daemon and pins that immutable local ID for Compose. Missing configuration,
commands and invalid artifacts now produce explicit preflight diagnostics.

Deployment tests cover different runner/host IDs, corrupted archives and missing
configuration, alongside backup, migration, readiness, duplicate-bundle, secret
access and architecture failures. No failure before cutover stops existing writers.

A rerun uses the original release's workflow and cannot incorporate this code
change. Publish the correction in a new patch release to validate the corrected
GitHub-to-containerd deployment path. Keep runtime secret values out of incident
logs, and preserve deployment backups and encryption keys across subsequent releases.
