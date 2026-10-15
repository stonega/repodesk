# Workspace membership and access

Status: **implemented local P0 policy**. All active workspace members can use the
bot. Roles determine which actions they can perform. Whitelist enforcement and
access modes were removed on 2026-10-07.

## Membership and administration

Use verified **Telegram numeric user IDs**, represented as decimal strings, for
identity and authorization. Usernames and display names are informational labels.
An active member can use the bot immediately; regular membership grants no admin
role or additional source, destination or repository permissions. Non-members and
inactive members cannot run bot work.

The **Members & access** page offers a searchable, paginated member table with
Telegram profiles, IDs, roles, membership, GitHub detail actions and effective access.
Add/edit dialogs manage role and active membership. Access requests and their
shareable Telegram invite link remain on this page. The access policy card, whitelist
column, whitelist toggle and bulk ID editor have been removed.
Old `/admin/access-policy` browser links redirect to `/admin/members` while
preserving query parameters. The retired access-policy API and preview routes
are unavailable.

Member profiles come from actual Telegram senders in the resolved workspace and
approved requests, with older approved requests providing a display fallback.
Unknown profiles show **Telegram user** and the numeric ID. Later sender updates
refresh profiles and clear removed usernames. Editing membership preserves profile
metadata; names and usernames never enroll users or change authorization.

Workspace owners/admins manage membership and roles. The password-authenticated
deployment operator may manage configuration and membership in workspaces they
created before linking Telegram. Operators can inspect retained workspace runs
under the existing admin history rules; bot execution and run mutations still
require a linked, active Telegram identity. Regular members cannot manage access.
Reject member edits that would remove the last active owner/admin's management
access. Owner edits use the existing audited operator recovery flow.

Web-first onboarding can activate without an enrolled member, in which case
ordinary bot use is denied. Adding or approving a member grants access immediately
once processing is active. Verifying an owner later enrolls/reactivates that owner
and invalidates old browser sessions. Group linking never enrolls all participants.

## Enforcement contract

One shared membership check applies to bot commands, task requests, callbacks,
workspace admin APIs, queued runs, costly/tool steps, schedules and delivery:

```text
verified identity
  AND active workspace membership
  AND role permits requested action
  AND source/destination/repository permissions permit requested action
```

Operator setup/configuration and recovery use separate authorization. They do not
authorize bot execution. Scheduled work uses its recorded owner and rechecks that
owner before execution. External messages, quoted IDs, forwarded authors, callback
payloads and usernames never prove actor identity.

Private unauthorized requests receive brief access help. Groups silently ignore
unauthorized task requests; unauthorized callbacks receive a short denial without
task details. Denied requests make no model/tool calls and create no workflow.
Unauthenticated admin requests receive 401; authenticated unauthorized requests
receive 403 or a non-disclosing 404. Authentication alone grants no workspace access.

Group collection remains a separate opt-in policy and can include received messages
from people who are not workspace members. Bot replies in a group are visible to
all participants. Membership does not authorize a new chat, expand retention,
import old history or allow private sources in group output.

## Revocation, concurrency and migration

Workspace `memberVersion` is the optimistic concurrency revision for membership
edits, setup access changes and access-request decisions. Mutations validate the
expected version and commit with their audit entries. Stale edits return HTTP 409.
Protected operations always recheck current membership instead of trusting an old
positive result or run snapshot.

Deactivating a member denies subsequent API requests and callbacks, revokes pending
approvals, cancels queued/running work and pending delivery, and suspends personally
owned schedules. Roles, sources and repository grants remain independently checked.
Do not silently transfer ownership or restart cancelled work when reactivating a
member. An upstream call already in flight may finish; revocation cannot undo
completed work or a sent message.

Apply `015_remove_workspace_whitelist.sql` before running the updated app/worker.
It removes saved workspace `policy` objects and carries their version into
`memberVersion`, preserving memberships, roles, audit history and work state. It is
safe to repeat. Previously active members excluded by the whitelist can now use the
bot; IDs listed without membership remain non-members. Previously suspended schedules
and cancelled work retain their saved state.

`GET /api/admin/workspaces/:id/members?offset=0&search=NAME` returns the member
`version`, paginated `items`, `total` and `offset`. `POST` to `/members` takes
`{ id, role: "admin" | "member", active, version }`.

## Telegram access requests (implemented, 2026-09-20)

An unauthorized user can press **Request access** after messaging the bot privately
or directing a command/reply to it in a linked group. Private routing uses an
existing workspace selection or membership; exactly one configured workspace with
a verified owner may be inferred. With multiple possible workspaces, use the
workspace-specific invite link from **Members & access → Access requests**.
Ordinary requests and legacy workspace-ID request links still require approval.
They never expose workspace/member lists. Requests also work before activation
once Telegram updates are being received.

### Single-account invite links (implemented, 2026-10-14)

The shareable card now displays a signed invite, refreshed automatically every
10 seconds with an animated circular countdown after its title. Timing and
refresh status remain available to screen readers and on hover, with static
updates for reduced motion. In private Telegram, sending its `/start` command
immediately enrolls/reactivates regular membership for the actual sender, without
an approval step. Each token binds atomically to the first account that uses it;
another account cannot claim it. Active members also consume a token, preserving
their role. Inactive administrators rejoin as regular members; revoked owners
still require operator recovery. Bots, anonymous senders, mismatched private
chats, edited messages and group redemption cannot enroll members.

Copied invites remain valid for 24 hours, independently of the display countdown.
The signature binds the workspace, Telegram bot identity and issue time; tampered,
future-dated and expired tokens are rejected. Only hashed account claims are
persisted, in the same locked transaction as inbox deduplication, membership,
audit and default private selection. Concurrent claims enroll at most one account.
Replays do not change membership revisions or restore revoked membership. A fresh
invite can reactivate regular membership. Prior pending requests are resolved
automatically. Redemption creates no model/tool work and grants no panel/admin
account or additional repository permissions. It works before bot activation.
Expired claim records are pruned; workspace purge clears all claims.

The card keeps its current link visible while refreshing; failed refreshes pause
the countdown and offer Retry in an error toast. The next successful refresh also
updates the member table when the membership revision changes.

### Manual request review

The request records the actual callback sender's numeric ID, optional display
metadata, request time and originating chat/topic. Pending requests grant no
membership or AI execution. Bots, anonymous senders, other users' private chats
and unrelated groups are rejected.

**Approve access** atomically enrolls/reactivates regular membership, records the
decision/audit events and queues an approval notification to the originating chat.
It grants no panel account or admin role; revoked owners use operator recovery.
A default private workspace selection is saved only if none exists.
**Reject request** grants nothing. Rejection is shown at the next access check;
a user can request again after 24 hours.

Duplicate pending requests and repeated identical decisions are idempotent.
Replaying an old approval after deactivation cannot restore membership. Conflicting
decisions and stale membership versions return HTTP 409. All decisions require
current workspace admin authorization, CSRF and origin checks.

Requests are limited to 500 retained records per workspace, one per Telegram ID.
They expire 30 days after request/decision and are erased on purge. Fixed access
replies are throttled per bot, actor, workspace and chat/topic to one per minute,
retained for one day and use the retry/unknown-outcome delivery policy. Approval
notifications recheck membership before sending.

`GET /api/admin/workspaces/:id/access-requests` returns pending `items`, membership
`version`, signed `requestUrl`, `refreshAt` and `expiresAt` (null link metadata
when no bot is configured). `POST /access-requests/:request/decision` accepts
`{ decision: "approved" | "rejected", version }`. Setup offers the same decisions
under `/api/setup/workspaces/:id/access-requests/:request/decision`.

## GitHub identity and repository permission sync (2026-10-05)

Add/Edit member forms automatically fetch organization members from the GitHub API
or use the personal installation owner directly, without repository metadata.
Administrators can select a fetched account or enter a custom username, resolved
to its canonical login and numeric GitHub ID when saved, and associate it with a
Telegram member; View in the table opens its profile and verification status.
Associations are tenant-scoped profile data and do not create repository grants.
Verified accounts remain controlled by the member's Telegram connection flow.
See [account selection and App permissions](../implementation/github-app.md#fetch-github-accounts-in-member-forms).

Active members can link GitHub through `/github connect` in private Telegram,
then confirm the account in Telegram. Stable GitHub numeric IDs and repository
permission snapshots are stored per member and shown in Members & access. Each
GitHub column contains only a View button, opening account details, connection
status, sync time and the complete saved repository list with permission labels
in a read-only modal. Pending and unlinked accounts use the same View action.
The OAuth callback alone grants nothing. Repository grants intersect GitHub user
access with the operator-selected installation repositories. Membership, roles,
coding-maintainer grants and write approvals remain independent application checks.
Unlinked users retain operator-managed repository permissions; linked users must
satisfy the upstream check, including after disconnect. Snapshots expire after ten
minutes and refresh about every five minutes or via `/github sync`. Failed syncs
deny linked repository access. Temporary API failures hold coding task progression
for automatic retry; confirmed permission loss invalidates pending work. Completed
coding results retain their history, and follow-ups recheck current access. See
[implementation and rollout limits](../implementation/github-app.md#connect-a-verified-telegram-members-github-account).
