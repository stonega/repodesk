# Unrelated repository change blocks a scheduled report — 2026-11-12

## Observed impact

The daily Wallshader star report appeared as `suspended` with reason
`owner_or_skill_revoked`. Scoped, read-only inspection of the Seattle VPS found
all five application services healthy. No production records, credentials,
connections or services were changed during this investigation.

Workspace `6a084cfc-c08f-4268-a0eb-84a80fe93760` contains workflow
`a77b1192-2912-4aa0-8446-369d7ea715db`, created at
2026-11-11T10:41:58.885Z. Its daily recurrence is 08:00 Asia/Taipei. It has no
selected skill and is pinned to GitHub revision 1 and repository ID
`1371046474` (`stonega/wallshader`).

The 2026-11-12T00:00:00Z occurrence queued run
`95fc7052-8f92-4a52-a064-8e674756ace2` at 00:00:03.878Z. Inspection found that run
cancelled, with no delivery and no retained start/completion event. Its saved
repository read scope is revision 1. The workflow's saved next occurrence is
2026-11-13T00:00:00Z, but suspended workflows do not dispatch. The card's schedule
preview does not establish that a run is scheduled.

## Confirmed blocking condition

At inspection, the workspace GitHub revision was 2 and its connection revision
remained 1. The recorded repository revisions identified only repository
`257514806` as changed at revision 2. That ID was absent from the current
427-repository selection. Read-only extraction of the existing pre-release
backup identified it as `stonega/spacex-go`; both it and `stonega/wallshader`
were present at revision 1. Wallshader was not marked as changed at revision 2.

The workflow owner remained an active member. The owner's GitHub snapshot was
connected, fresh, on revision 2, and granted read/write/admin access to Wallshader.
The workspace was not paused. No selected skill could have been revoked because
this workflow has none. No retained GitHub sync-failure diagnostic was found in
the scoped runtime-log query.

The deployed release was `1794386364054-96360541`. Inspection of its source
confirmed the following chain:

1. `RepositorySync.sync` removes previously selected repository IDs absent from
   the installation's accessible list. A policy change advances the global
   metadata revision and records which repository IDs changed.
2. `repositorySourcesAllowed` requires equality with the global revision even
   for a scope containing only an unchanged repository.
3. `revokeWork` permanently changes active workflows failing that check to
   `suspended` and writes the shared reason `owner_or_skill_revoked`. It does
   not distinguish repository-scope failures from owner or skill revocation.
4. Subsequent successful permission refreshes do not reactivate a suspended
   workflow or update its pinned scope.

The unrelated repository removal therefore invalidates the Wallshader workflow
under the deployed policy. The current revision mismatch conclusively explains
why this workflow remains blocked despite valid membership and repository access.

## Evidence limits and correction boundary

The metadata refresh and automatic suspension do not retain a dedicated audit
entry identifying their exact transaction time. The evidence does not establish
why GitHub stopped exposing Spacex Go to the installation, the exact suspension
time, or which invalidation transaction first cancelled the queued run. Do not
describe the repository as deleted or the owner's Wallshader access as revoked.

The initial investigation made no production changes, model calls or Telegram
sends. The operator subsequently authorized implementation and deployment of the
correction described below.

## Correction and regression coverage

Repository read scopes and fresh permission snapshots now validate the connection
generation and the change revisions of their selected repositories. Unrelated
catalog changes no longer invalidate an unchanged source. Removed/changed IDs
retain tombstones, future revisions are rejected, and historical connections
without scoped generation data retain their strict boundary. Coding and verified
write actions still require a snapshot synchronized to the current global revision.

Permission synchronization previously passed affected repository IDs only to
coding-task cancellation; assistant runs, approvals and deliveries were still
cancelled for the whole actor. It now passes the affected IDs to assistant
invalidation too. Dependent follow-ups and handoffs are fenced, and unknown
historical provenance retains conservative cancellation. Identity/connection
revocation still invalidates the actor's work.

Suspension records one timestamped `workflow.suspended` audit entry, with a specific
owner, skill or repository cause. An allowlisted `workflow_suspended` runtime
diagnostic is emitted after the workspace transaction commits, with workspace and
related run IDs; no private text, upstream exception or credential is logged.

The deterministic regression uses production Store, GitHubService, metadata
refresh, user permission sync and scheduler services with fake GitHub responses
and isolated PostgreSQL. It covers an ordinary member's two reports, unrelated
removal, restart, duplicate ticks, pending output, selected-repository restoration,
lost permissions, expired snapshots, owner deactivation and connection replacement.
Additional coverage verifies targeted approval/follow-up/delivery revocation.
All 1,500 main-tree tests and 1,503 preserved-production tests pass with Bun 1.3.14,
along with lint, strict types, builds and the 16-case offline startup contract.

An initial incomplete GitHub installation-list fixture was corrected. An unpinned
Bun 1.4.4 run exposed unrelated timing failures and was interrupted; the pinned
focused and final full suites pass. No dependency or SQL migration was added.

## Deployment and scoped recovery

The operator-authorized release `1794469596569-79773357` deploys preserved
production source `b6ab2b9531bd3ea9a30e2c5eab9cabc0a5b46a1b`, containing main fix
`64113d3a962dd6347a0e111e147cffd44e29e1f9`. The exact source is retained on
`deploy/scoped-workflow-repositories-20261112`. All five services are healthy;
all 55 deployed artifacts, exact-image integration startup, Code Truth, Compose,
migration rerun and backup/restore gates pass. The protected pre-cutover backup
is 533,250 bytes and its archive listing verifies. Configuration, credentials,
mounts, PostgreSQL identity and the 813-file native Browser installation are
preserved. See [the deployment record](../docs/implementation/vps-deployment.md#scoped-repository-schedule-fix-deployed-2026-11-12).

A recovery bundle first performed a read-only dry run against the live workspace.
After cutover, an audited Store transaction verified the exact suspended record,
version, owner, destination and repository IDs, then invoked the normal pause and
resume lifecycle checks under its owning deployment operator. Current membership,
repository permissions and selected-source generations passed. The stale reason
was cleared after successful validation and separately audited. No owner identity
or upstream grant was changed.

The workflow is active, remains version 1, and is next due at
2026-11-13T00:00:00Z (08:00 Asia/Taipei). Its repository pin remains at revision 1,
which is valid because the connection generation and selected repository did not
change. Recovery asserted unchanged historical runs, deliveries, occurrences and
other workflows before committing. The cancelled November 12 run remains
cancelled. No historical replay, manual Telegram send or live model call was used.
