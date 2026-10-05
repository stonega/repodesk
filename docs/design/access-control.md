# Allowed-user whitelist

Status: **implemented local P0 policy**. Applies to Telegram usage and workspace access
in the [admin panel](admin-panel.md). See [implementation evidence](../implementation/implementation-status.md)
for deterministic and PostgreSQL revocation tests; live pilot verification remains pending.

## Configuration

Each workspace has an access mode:

- **Whitelist only** (default): active workspace members must also appear in the
  allowed-user list to use the bot or access that workspace in the panel.
- **Workspace members**: any active member may use the bot; role permissions still
  apply. Turning off whitelist enforcement does not grant public access.

Store allowed users by verified **Telegram numeric user ID**, represented as a decimal
string. Usernames and display names are informational labels, never authorization keys.
Adding an ID to the whitelist does not automatically grant membership or admin rights.
The panel can offer an explicit “add member and allow access” operation with a selected
role; apply both changes atomically and audit them separately.

Workspace creation through Telegram enrolls its verified creator as owner and adds
that identity to the whitelist in the same transaction. In web-first onboarding, the
local deployment admin can activate a draft and approve or allow members from
the authenticated Setup panel before linking Telegram. Linking the verified
Telegram owner later performs membership and whitelist enrollment atomically.
An empty enforced list denies all ordinary workspace access.
Never interpret an empty, invalid or unavailable list as unrestricted access.

Proposed stored fields:

| Record | Fields |
| --- | --- |
| Workspace access policy | Workspace ID, mode, monotonically increasing version, updated by/at |
| Allowed-user entry | Workspace ID, Telegram user ID, optional label/note, added by/at |

Enforce unique `(workspace_id, telegram_user_id)` entries. Access policy belongs in
PostgreSQL so changes apply to all API and worker containers without redeployment.

## Admin panel controls

The unified **Members & access** page provides:

1. A searchable, paginated member table with Telegram name, username and ID, role,
   membership status, whitelist status and effective access. Whitelisted IDs without
   membership are shown as **Not enrolled**, with an explicit enrollment action.
2. Add/edit member dialogs and the existing access-request approval flow.
3. Access mode selection and an expandable whitelist ID editor for bulk changes.
4. A preview of affected access, runs and schedules before applying policy changes.
5. Version checks, last-admin protection and audit records for mutations.

The sidebar has one entry at `/admin/members`. Old `/admin/access-policy` links
redirect there while preserving query parameters. The API routes remain available.

Member names and usernames are display metadata captured from actual Telegram
message/callback senders in the resolved workspace. Approved access requests also
populate this profile; older approved requests provide a display fallback. No
username lookup or extra Telegram request is made. A later sender update refreshes
the profile and clears an old username when the user no longer has one. Unknown
profiles show **Telegram user** and the numeric ID until an interaction supplies
more information. Editing membership preserves these fields. Usernames never grant
access, identify an API actor or replace numeric IDs in permission checks.

Workspace owners/admins may manage their own policy. The password-authenticated
deployment operator may also manage configuration, skills, members and access for
workspaces they created without linking a personal Telegram account. This web
authority cannot read runs or private conversation history or execute bot work.
Ordinary members cannot edit policy.
Reject ordinary UI changes that would remove the last allowed active owner/admin's
management access. Deployment operators can manage setup access for workspaces
they created, with audited membership and whitelist changes. This does not grant
bot execution or private conversation retrieval. Their separate recovery action
remains available.

## Enforcement contract

Local deployment-admin bootstrap/configuration and audited recovery use separate
operator authorization so setup works before Telegram exists. This exception never
authorizes bot execution or private conversation retrieval.

Apply one shared policy function to bot commands, task requests, callback buttons,
workspace admin APIs, queued runs and scheduled execution:

```text
verified identity
  AND active workspace membership
  AND (members mode OR identity is whitelisted)
  AND role permits requested action
  AND source/destination permissions permit requested action
```

The bot verifies the actual event sender; an ID quoted in text, forwarded author,
username, callback data or browser form is not proof of identity. Requests without
an attributable user cannot perform restricted actions. Scheduled work uses its
recorded owner and rechecks that owner's eligibility before execution.

In private chat, deny access with a brief message and instructions to contact an
admin. In groups, silently ignore unauthorized task requests to avoid noise. Answer
an unauthorized button click with a short denial, without exposing task details.
Unauthenticated admin requests receive 401; authenticated but unauthorized workspace
requests receive 403 (or non-disclosing 404 for a resource outside their scope).
Authentication may identify a user before membership is known; it grants no access
to workspace records by itself.

Denied requests must not trigger Pi/model calls, tool execution or workflow creation.
Record only minimal access-denial metadata if needed, not a durable transcript of
the denied request. Basic private `/start` and access-help responses may explain how
to obtain access; they cannot create a workspace or expose data without the separate
onboarding authorization policy.

## Revocation and existing work

Commit policy changes and audit records together. Check the current policy version
on every protected API request, dequeue, costly/tool step and outbound delivery;
do not trust an old policy snapshot or a long-lived positive authorization cache.

When removal changes effective eligibility (in whitelist-only mode):

- Deny subsequent workspace API access, even with an otherwise valid login session.
- Invalidate outstanding approvals and delegated connector use for that workspace.
- Cancel queued work; signal active runs to abort and prevent subsequent tool steps
  or output delivery after the change is observed.
- Suspend personally owned schedules until an eligible owner is assigned and the
  revised schedule is approved. Do not silently transfer ownership.
- Retain configuration and audit history according to the retention policy.

An upstream call already in flight may finish or incur cost; revocation cannot undo
completed work or erase a message already sent. Removing an entry while enforcement
is disabled only edits the saved list; the panel must show that it does not revoke
access in members mode. Switching to whitelist-only computes all affected users.

## Group visibility and context

The whitelist controls **who can invoke the bot and manage workspace resources**.
It does not hide a bot's group replies from other group participants. Use private
destinations for private outputs.

Group context collection remains a separate opt-in policy. An enabled group recap
may include received messages authored by non-whitelisted group participants under
that collection policy. Explain this beside the setting. Whitelisting a requester
does not authorize observing a new chat, expand retention or override source access.

## API and tests

Proposed resource: `/api/admin/workspaces/:id/access-policy`, with a validated mode,
version and paginated allowed-user entries. Use dedicated add/remove/bulk-change
operations and expected-version checks; do not permit cross-tenant replacement.

Required acceptance cases:

- Empty/invalid policy denies, default creator initialization succeeds.
- Allowed member succeeds; listed non-member, unlisted member and spoofed username fail.
- Whitelisted regular member cannot perform admin operations.
- Revocation blocks an old browser session, callback, queued run and scheduled run.
- Two admins editing concurrently cannot overwrite each other silently.
- Changes propagate across separate API/worker containers and survive restart.
- Last-admin lockout protection and operator recovery work and are audited.
- Bulk input rejects malformed IDs, deduplicates entries and shows effective changes.
- Denied task requests make zero provider calls; group visibility/context behavior
  matches the explanation above.

## Telegram access requests (implemented, 2026-09-20)

An unauthorized user receives a **Request access** button after messaging the bot
privately or directing a command/reply to it in a linked group. A private chat uses
its existing workspace selection or membership; when there is exactly one configured
workspace with a verified owner, it can be inferred. With multiple possible workspaces,
the bot asks for the workspace-specific link available under **Members & access → Access
requests**. Opening that link offers the button; it does not grant access. No workspace
names or member lists are exposed to unauthorized users.
The link and request button also work while the deployment is inactive, once
Telegram updates are being received. Approval can happen during setup; ordinary
bot requests still require activation.

Pressing the button records the Telegram callback sender's numeric ID, optional name
and username, request time and originating chat/topic in that workspace. Names and
usernames are display labels only. Pending requests neither enroll users nor execute
AI work. Requests from bots, anonymous senders, another user's private chat or an
unrelated group are rejected. Normal group collection consent still applies.

Workspace admins review requests in **Members & access → Access requests**. **Approve access**
atomically enrolls/reactivates the user as a regular member, adds them to the whitelist,
records the decision/audit events and queues an approval notification in the originating
chat. It does not grant panel accounts or admin privileges; a revoked owner uses the
existing operator recovery flow. A default private workspace selection is saved only
when the user has none. Existing selections are preserved.

**Reject request** grants nothing. The bot reports rejection on the next access check;
the user may submit a new request after 24 hours. Duplicate pending requests and repeated
identical decisions are idempotent. Replaying an old approval after revocation cannot
restore access. Conflicting decisions and stale policy versions return HTTP 409.
All decisions use current workspace admin authorization, CSRF and origin checks.

Requests are limited to 500 retained records per workspace, one per Telegram identity.
Records expire after 30 days from request/decision and are erased on workspace purge.
Fixed access replies are throttled per bot, actor, workspace and chat/topic to one per minute,
retained for one day, and use the existing retry/unknown-outcome delivery policy.
Approval notifications use the normal outbox and recheck authorization before sending.

API: `GET /api/admin/workspaces/:id/access-requests` returns pending `items`, policy
`version` and `requestUrl`. `POST /api/admin/workspaces/:id/access-requests/:request/decision`
accepts `{ "decision": "approved" | "rejected", "version": number }`.
Apply migration `009_access_requests.sql` before running the updated app/worker.

Telegram controls follow the [Bot API inline keyboard and callback contract](https://core.telegram.org/bots/api#inlinekeyboardbutton):
callback data is under 64 bytes and button presses are acknowledged with `answerCallbackQuery`.

## GitHub identity and repository permission sync (2026-10-05)

Eligible members can link GitHub through `/github connect` in private Telegram chat,
then confirm the returned account in Telegram. Stable GitHub numeric IDs and repository
permission snapshots are stored per workspace member and shown in Members & access.
The OAuth browser callback alone grants nothing. Repository grants are the intersection
of GitHub user access and the operator-selected installation repositories; RepoDesk
membership, whitelist, administrator roles, coding-maintainer grants and write approvals
remain separate application boundaries. Existing unlinked users retain the manually
configured policy; linked users must satisfy the synchronized upstream boundary,
including after disconnect. Snapshots expire after ten minutes and refresh about every
five minutes or via `/github sync`. Failed syncs deny linked repository access and
permission loss invalidates pending work. See [implementation and rollout limits](../implementation/github-app.md#connect-a-verified-telegram-members-github-account).
