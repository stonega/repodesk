# Browser deployment checkpoint mixed progress output with JSON

## Impact and timeline

The operator-authorized Browser consent deployment stopped the existing API and
worker for its final checkpoint on 2026-11-02, then failed before native package
installation or production backup, migration and application cutover. The previous
release marker remained `41170079370-1`. PostgreSQL, Code Truth and the three CI
runners continued running. No database restore or credential rotation occurred.

All times below are UTC. Production was healthy at 02:05:35. By 02:11:42 the
application was unavailable after the checkpoint failure. The exact beginning of
that interruption was not measured. A guarded recovery started at 02:17:35 and
completed at 02:18:27, restoring the original API and worker. Public health then
returned HTTP 200. The corrected update resumed at 02:22. After the normal second
cutover, the final production receipt passed at 02:29:20. Independent public
health, readiness and Mini App checks subsequently returned HTTP 200.

## Cause

The operator driver used a general subprocess helper that combined stdout and
stderr. The application checkpoint emitted valid JSON on stdout, while Docker
Compose emitted container progress on stderr. The combined file failed JSON
parsing after writers had stopped. The same command had appeared to work before
shutdown, when Compose had no container-start progress to report.

The exception handler attempted `docker compose start app worker`. Compose refused
because the worker's migration dependency had no retained container; the production
deployment uses an ephemeral migration and starts long-running services separately.
This secondary exception also prevented the original handler from writing its
failure receipt. Application runtime tests and exact-image startup checks did not
cover this host-side operator boundary.

## Recovery and prevention

Recovery compared the original API and worker container IDs and immutable image
IDs with the protected baseline, then started those exact containers through
Docker. It did not recreate containers, resolve Compose dependencies, restore a
database or replay tasks. The recovery workflow completed its restore step; its
unrelated legacy polling step was then cancelled. Workflow conditions now limit
that polling to the original deployment modes.

The production checkpoint helper now captures JSON stdout separately from progress
stderr. Pre-cutover recovery uses identity-fenced Docker starts, and the driver
writes the fixed diagnostic code `browser_update_failed`, release-local stage and
cutover state before attempting recovery. Recovery failure cannot erase the first
diagnosis. Protected diagnostics contain no browser input, private page content or
credentials.

Two deterministic regressions exercise the production helper: a real subprocess
emits Compose-like progress alongside valid JSON, and a fake engine requires the
original writer identity while rejecting a replacement. Both pass. The complete
release suite passes **1,370 tests across 149 files**, plus lint and strict types.

The resume path validates the previous marker, safe checkpoint stage, source
archive, exact images, successful image checks, native manifest and unchanged
credentials before continuing. It reuses the previously verified images instead
of rebuilding or replaying a completed cutover.

## Outcome and evidence

Release `1793583945996-1` successfully deployed the coordinated application and
native Browser protocol from source `56350be2895ce813741826e12c14b5198b58379b`.
The receipt verifies 51 application/supervisor/task artifacts, public and loopback
HTML/assets, healthy services, preserved credentials and volumes, and unchanged
PostgreSQL/CI container identities. The native host permits synthetic routine
operations, blocks unapproved submission and serves the existing API/worker socket
mounts after restart. No live account, Telegram message or model call was used as
a probe.

The protected pre-cutover database backup is
`/opt/repodesk/backups/pre-release-1793583945996-1.dump` (2,238,307 bytes); its archive
listing passes verification. The initial failure, recovery and resumed logs remain
in the same protected release directory. See the
[successful status check](https://github.com/stonega/repodesk/actions/runs/41378162854),
[full verification receipt](https://github.com/stonega/repodesk/actions/runs/41378414076)
and [deployment evidence](../docs/implementation/vps-deployment.md).
