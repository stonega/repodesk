# Branch and release-source divergence — 2026-11-12

Status: branch consolidation completed; prevention rules documented.
Scope: repository development, integration and release-source handling.

## Observed impact

The repository had separate local-main, remote-main and production-source
histories. Before consolidation, local `main` was `889e094` and remote main was
`c5305dd`. Local main had three commits not reachable from remote main and lacked
34 commits reachable from remote main. The working directory also contained 158
modified tracked files and 26 untracked files.

After fetching the remote, 11 local task branches and 12 remote task branches
had commits outside remote main. Deduplicating their names yielded 15 branches.
One branch, `fix/telegram-recovery-main` at `9bc4253`, had a patch-equivalent
commit upstream. The other 14 names still had unmatched patches, including
shared deployment history. These counts do not establish 15 missing features,
14 independent changes or three entirely unpublished local features.

The confirmed impact was uncertainty over which source contained each correction
and accumulated integration work. Some production fixes were outside main, while other features were already
represented there under different commits. This audit did not establish a new
production outage or loss of committed code.

## Evidence and timeline

- On November 10–12, the original worktree recorded local commits `60c122c`,
  `f3c25a7` and `889e094`. Remote main contained corresponding feature work under
  `c2a55f7`, `969b8c5` and `9fa07d5`, among other newer commits. Matching subjects
  helped identify review candidates; they were not treated as proof that every
  patch was identical.
- The local-main reflog continued to record local commits while the remote-main
  reflog recorded successful pushes from other checkout activity. A remote push
  advanced the tracking ref without advancing this worktree's local `main`.
- Production updates repeatedly started from the previously deployed source. For
  example, main fix `64113d3` was applied to production source `41b179b`, producing
  `b6ab2b9`. The [deployment record](../docs/implementation/vps-deployment.md#scoped-repository-schedule-fix-deployed-2026-11-12)
  records the separate main and production sources and their separate checks.
- At the November 12 audit, the user requested consolidating all outstanding
  branches into main, then explicitly requested committing directly.
- At 16:33 Asia/Taipei, consolidation commit `40b6c70` was pushed to main. Every
  original local/remote branch tip was verified as an ancestor of remote main;
  local and remote main matched and the original worktree was clean.

## Cause

The shared main branch was not consistently used as the integration and release
baseline. Three practices reinforced the divergence:

1. **Worktree-local state was treated as if it followed remote main.** Independent
   worktrees and pushes are valid, but they do not synchronize another worktree's
   branch or dirty files. Local work continued without reconciling its baseline.
2. **Production snapshots became an ongoing development line.** To retain earlier
   deployed fixes, later changes were applied to the previous production source.
   Corrections were not consistently reconciled into main before another release
   extended that snapshot. Retaining live configuration/state and retaining old
   application source became coupled in the release process.
3. **Completion did not consistently verify source reconciliation.** Reworked and
   squash/cherry-picked features left old history flags unresolved, while useful
   local edits accumulated outside commits. The workflow lacked a shared check
   for the pushed destination, outstanding production fixes and remaining local
   work before declaring integration or a release complete.

Branch count alone overstated missing functionality, but patch equivalence alone
could not establish that all production fixes were in main. Both history and the
remaining implementation changes needed review.

## Correction

The original worktree was captured in local backup commit `37d5afa`, preserving
all 184 changed/untracked task files and the original local-main history. Original
branch tips were recorded before integrating in an isolated worktree based on
remote main. Local changes and production histories were merged, followed by the
remaining branch tips. Conflict resolution retained later fixes and current
documented behavior. Equivalent or superseded changes retained their history
without restoring obsolete implementations. The distinct download investigation
was retained as `deploy/browser-operator/download-diagnostic.py` beside the newer
chat diagnostic.

After verification, the unchanged original worktree was additionally saved in a
local stash, local main was fast-forwarded to the integration result and main was
pushed normally. The original branches and local backups were retained. No shared
history was force-pushed. This repository consolidation performed no production
cutover, live Telegram send or live model request.

## Validation and limits

- All original branch tips were reachable from pushed main at `40b6c70`.
- **1,554 deterministic tests across 163 files passed** with Bun 1.3.14, isolated
  PostgreSQL and the CI 30-second timeout. The initial Bun 1.4.4/default-timeout
  run had seven timing failures; the pinned full rerun had zero failures.
- Biome, strict TypeScript, production build and the Node runtime contract passed.
  The imported thread diagnostic retained nine lint warnings; formatting/import
  errors were corrected.
- **36 browser scenarios passed**, with desktop/mobile screenshots inspected for
  workflow ownership, Code Truth saved summaries/modal editors and native runtime
  settings, including the exercised pending/error states.
- The built Docker image passed all 16 integration-startup cases with zero
  external startup calls, migration and app/worker HTTP readiness checks.
  Compose configuration and changed Python syntax also passed.

Passing local checks and pushing main do not establish a production rollout.
The prevention changes below are contributor instructions and manual release
checks; no automatic branch-protection or deployment-lineage enforcement was
installed by this documentation change.

## Prevention and ownership

| Checkpoint | Responsible role | Required result |
| --- | --- | --- |
| Start or resume work | Task implementer | Fetch remote refs; inspect the current branch, worktrees, dirty files and divergence; use current remote main for new task branches. |
| Reconcile an old checkout | Task implementer | Preserve unrelated edits and local-only commits; integrate in isolation when necessary; never discard work to make synchronization succeed. |
| Integrate completed work | Integrator | Review history and patch equivalence separately, resolve conflicts by behavior/chronology, validate and verify the pushed destination when push is in scope. |
| Prepare a normal release | Release operator | Use a clean, tested, immutable source commit already reachable from remote main, including deployment/service corrections; record commit/tree and exact artifact identity. |
| Perform an authorized emergency exception | Incident owner and release operator | Record the source, exception reason, verification, return-to-main owner and deadline; verify reconciliation before the next normal release. |
| Report completion | Task or incident owner | Distinguish local changes, merged/pushed changes and deployed artifacts; disclose remaining source reconciliation. |

The durable instructions are in [AGENTS.md](../AGENTS.md#branch-integration-and-release-source).
The executable inspection steps, equivalence limits and emergency/rollback policy
are in the [release runbook](../docs/implementation/release-runbook.md#source-lineage-and-branch-integration).
Historical deployment snapshots remain evidence; subsequent development uses
reconciled main.
