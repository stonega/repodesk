# In-app update failed on a full VPS disk

Date: 2026-10-10. Requested release: `v0.1.34`, commit
`83ab742dea5f773dd0001be2c0807c9463fb707e`. Running release during diagnosis:
`v0.1.33`.

## Evidence and impact

The operator clicked Update in the panel, but the webpage kept showing v0.1.33.
Read-only SSH inspection found request
`240e179f-fe86-4443-b5bb-293ebe8a82a9` marked `failed/update_failed`. Its protected
host log showed all three image builds and the Node runtime smoke succeeded,
then `gzip: stdout: No space left on device`. The deployment filesystem was 96GB
and 100% full, with only 25–63MB available during inspection. The protected
cutover had not started; the app/worker remained healthy on the previous release.

The host had accumulated 74 images (60.58GB reported logical size), 9.214GB of
build cache and 27.45GB of volumes. These figures include shared storage and
must not be added as independent physical disk usage. The failed bundle retained
a 327,528,448-byte incomplete archive.

## Cause and correction

The host updater built images locally, saved them to a compressed archive, then
would reload the archive on that same Docker daemon. This temporary duplicate
ran out of space before checksum creation. Generic failure feedback did not
explain the capacity problem.

The correction pins each locally built image ID and passes `--local-images` to
the existing protected cutover. App, supervisor and task tags must still match
the recorded IDs before writers stop. Manual transferred archives retain their
checksum/import path. The updater checks for a minimum 1GiB reserve before
checkout, each build and cutover, and exposes a safe disk-space error in the
update dialog. This reserve does not guarantee enough space for every build or
backup; deployment image/cache retention remains an operator responsibility.

## Recovery and validation

Removed the incomplete archive only after checking the failed result, unchanged
current-release marker, missing checksum and absent cutover backup. Reclaimed
unused build cache last accessed more than 24 hours earlier. The host then had
3.7GB available. Retried the same published v0.1.34 release through the signed-in
operator's **Retry update** action. Additional capacity cleanup selected only
obsolete RepoDesk release image tags with no references from any container;
current, recent and requested release images were retained. No container,
database volume, credential or backup was deleted.

The retry `065610d4-768a-4f7f-8517-46b7b0a2bf12` succeeded through the original
published v0.1.34 updater. It deployed bundle `1791614204914-36610498` after
checkpoint, backup, migrations and readiness. Reloading the operator's existing
browser tab showed v0.1.34 and the member GitHub View action. The source-level
local-image and disk-space feedback correction is prepared for a future release;
it was not installed as an unpublished hotfix during this recovery.
Final checks found app, worker, PostgreSQL and Codex runner healthy, the updater
active, public readiness HTTP 200, a 1,556,146-byte mode-600 backup, and 7.9GB
free on the deployment filesystem.

Deterministic coverage checks low-space rejection before external commands,
safe failure reporting, local image deployment without archives and rejection
of retagged app/task images before cutover. Existing archive, checkpoint,
backup, migration, readiness and interrupted-job protections remain covered.
The browser fixture checks the disk-space explanation and explicit Retry action
at desktop and mobile widths.

Validation passed: 673 deterministic tests, all five focused update browser
scenarios, lint, strict TypeScript, production build, Docker app build/Node runtime
smoke, Compose configuration, and shell/Node syntax checks.
