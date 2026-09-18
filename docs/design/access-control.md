# Allowed-user whitelist

Status: **proposed P0 requirement**. Applies to Telegram usage and workspace access
in the [admin panel](admin-panel.md). This policy is not implemented in the scaffold.

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
local deployment admin can configure a draft before linking Telegram; linking the
verified Telegram owner performs membership and whitelist enrollment atomically. An empty enforced list denies all ordinary workspace access.
Never interpret an empty, invalid or unavailable list as unrestricted access.

Proposed stored fields:

| Record | Fields |
| --- | --- |
| Workspace access policy | Workspace ID, mode, monotonically increasing version, updated by/at |
| Allowed-user entry | Workspace ID, Telegram user ID, optional label/note, added by/at |

Enforce unique `(workspace_id, telegram_user_id)` entries. Access policy belongs in
PostgreSQL so changes apply to all API and worker containers without redeployment.

## Admin panel controls

Add **Access → Allowed users** with:

1. Current mode, allowed-user count and a plain-language explanation.
2. Searchable/paginated list showing ID, known label, membership/role and date added.
3. Add by ID, or select an already verified workspace member.
4. Bulk paste/import of IDs with validation and a preview of additions/removals.
5. Remove selected entries and preview affected access, runs and owned schedules.
6. Save using an expected policy version; stale edits require reload/review.
7. Audit history of mode changes and added/removed IDs, including actor and timestamp.

Workspace owners/admins may manage their own policy. Ordinary members cannot edit it.
Reject ordinary UI changes that would remove the last allowed active owner/admin's
management access. Deployment operators have an explicit, audited recovery action for
restoring management access; their operator role is not a blanket right to run the
bot or read workspace conversations.

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
