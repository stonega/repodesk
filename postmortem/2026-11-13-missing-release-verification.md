# Missing release verification — 2026-11-13

Status: CI restored; v0.1.49 patch verification in progress.

## Impact and evidence

The operator's panel update from v0.1.46 to v0.1.48 stopped with
`verification_failed`. The published annotated v0.1.48 tag points to commit
`0424ce9aec08b08b05f1b8c3c4059caf708920ba`, already on remote main.
GitHub returned no workflow runs for that commit. Verify (workflow ID 363982082,
`.github/workflows/check.yml`) was `disabled_manually`. All three registered
repository runners (IDs 21–23) were offline. The current VPS at the destination
recorded in `docs/implementation/debugging.md` had no Actions runner containers,
images or registration/data volumes.

The host verification guard runs before release checkout, builds, migrations or
cutover. This failure did not install v0.1.48. Existing production app/worker,
PostgreSQL, Code Truth and Codex supervisor containers remained healthy.

## Cause

Publishing a stable GitHub Release and passing local checks were treated as
sufficient release readiness while the updater independently requires a successful
push-triggered Verify run for the exact release commit. A disabled workflow does
not create runs; re-enabling it does not replay earlier pushes. Restoring the
application on another host did not restore the separately installed CI runners.
The record does not establish who disabled Verify or why.

The runner guide also retained the previous host address and described an older
one-job browser configuration. This made its operational instructions stale.

Restored CI exposed another release gate: six native-runtime tests assumed a
bare Linux host, but the configured runner executes inside Docker. The production
driver correctly returned `coding_native_host_required`; the fixtures had no way
to represent the intended host. One fake CLI also hardcoded `/usr/bin/node`
instead of using the Node installation selected by CI.

## Recovery

Built the checked-in Actions runner image and passed the isolated nested-Docker
CPU, memory and PID smoke, post-job cleanup retention checks, and Compose
validation locally. Transferred that image and the unchanged runner deployment
files to the current VPS. CI uses its own Docker daemons, registration volumes,
resource limits and Compose project; it receives no production Docker socket or
application directory.

Re-enabled Verify and pushed the unchanged release commit to
`verify/v0.1.48-recovery-20261113`. This created push-triggered
[Verify run 43357867105](https://github.com/stonega/repodesk/actions/runs/43357867105).
The published release/tag were not rewritten. No application deployment or
failed update-request replay is part of this CI repair.

That run completed with **1,579 passing and six failing tests**; browser and
container jobs were skipped. It is not passing evidence for v0.1.48. The
correction prepares v0.1.49 from main rather than rewriting that published tag.
The native driver now accepts internal host-observation dependencies, defaulting
to the same real platform, UID and container-marker checks as before. Only fake-CLI
fixtures supply simulated host information; production composition keeps the
defaults. Separate regressions reject non-Linux hosts, root, Docker and Podman
before any CLI runs. The fake CLI resolves Node from PATH.

## Prevention and validation

The release runbook now requires enabled verification, online runner capacity
and successful evidence for the exact candidate before publishing. The update
guide documents recovery using an unchanged commit, preserves the existing
push-event/exact-SHA requirement, and calls the production `requireVerifiedCommit`
function as the final read-only check. The runner guide targets the current host
and describes the existing two browser shards and current timeout budgets.

The seven deterministic host-updater tests pass, including rejection of failed
checks, other commits, manual dispatches and PR-only evidence; build/cutover
ordering, safe failures and interrupted-update protection remain covered.
All ten native-runtime tests pass locally and inside the actual Docker CI runner
with Bun 1.3.14. Biome, strict TypeScript, production build and the Node runtime
contract pass locally, including all 16 integration-startup cases with zero
external startup calls. All **1,589 deterministic tests across 161 files pass**
with Bun 1.3.14, the CI 30-second timeout and disposable PostgreSQL. The five
application-update browser scenarios pass,
covering the version indicator, desktop/mobile themes, release notes, request
deduplication, pending/error states and explicit retries.

Local browser selection compares v0.1.49 with main/release commit `0424ce9`:
only native host observations, fake-CLI tests, documentation and version metadata
change. The five update scenarios cover the affected version/release behavior;
this focused pass does not claim that v0.1.48's broader browser scope was verified.
The new release's own Verify run must still pass its complete configured
quality/database, browser and container jobs before publication. Record its final
result and the live production guard check here before marking this incident
recovered.
