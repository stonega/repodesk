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

No code fix, production reactivation, historical replay, deployment, model call
or Telegram send was performed. A correction should validate the selected
repositories independently of unrelated catalog changes while retaining current
membership, connection, repository and destination checks. Recovery must validate
current authorization before reactivation rather than restoring an old grant.

Required regression work remains open: exercise the production composition with
two repositories, remove only the unrelated one, and verify the remaining
schedule's behavior; retain denial cases for removal of its selected repository,
lost owner access and changed connection identity. Add a specific, safely logged
suspension cause with tenant/run context, and cover duplicate scheduler ticks.
