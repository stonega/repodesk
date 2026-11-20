# GitHub notification implementation

Scope accepted by the owner on 2026-11-14: new PRs and issues, personal Telegram
delivery, subscription management, durable processing and failure recovery.
This document describes local implementation. Live GitHub/Telegram delivery and
production rollout remain separate acceptance gates.

## Contracts

- `GitHubWebhooks` owns shared signature verification, App-secret lookup,
  notification event acceptance, installation revocation and bounded redelivery.
  The existing endpoint remains `/github/webhook/:operatorId`; Review Bot is an
  independent consumer and retains its exclusive review-workspace routing.
- `GitHubNotifications` stores one subscription per member/repository in the
  workspace aggregate, plus workspace-level `githubNotificationSettings`
  (`autoNotifyMaintainers`, enabled by default, with optimistic `revision`,
  `updatedAt` and lifecycle `revokedRevisions`). Subscriptions pin actor, bot,
  installation, repository ID and connection generation. Subscription revisions
  and settings revisions fence queued recipients and outgoing delivery intents.
  Activation timestamps prevent historical replay.
- Automatic maintainer notifications target active workspace members with fresh
  verified GitHub Maintain or Admin permission (`repositoryMaintainer`) on the
  connected repository, skip items opened by that same maintainer (matching
  GitHub numeric user ID when present, or case-insensitive login fallback), and
  defer to any existing personal subscription (enabled or paused) for that
  actor/repository so duplicates never occur.
- `024_github_notifications.sql` adds tenant-scoped event receipts with unique
  App/delivery and semantic opened-event keys. Ingress records normalized,
  bounded metadata and exact subscription revisions; it makes no Telegram or
  model calls. Worker transactions turn pending events into ordinary delivery
  intents and atomically acknowledge events. Store.save creates the existing
  transactional outbox entries.
- The delivery worker rechecks membership, bot, subscription revision, private
  destination and repository access immediately before sending. Existing retry,
  Telegram rate-limit and uncertain-outcome policies apply. There is no
  exactly-once claim for external Telegram sends.
- Processed receipts discard title/author and recipients immediately; receipts
  are retained for 30 days. Pending events are bounded to the same retention.
  Opened events older than three days are ignored at ingress. Workspace deletion
  clears subscriptions immediately and removes event rows during worker cleanup.
- The existing encrypted `review_bot_hooks` storage remains compatible. Its name
  is historical; both consumers use the same operator/App secret. Shared secret
  configuration is operator-only and does not update GitHub.
- Durable `github_webhook_recovery` leases checks across workers. Recovery scans
  100 records per page, follows cursors, groups duplicate GUIDs, reserves retry
  attempts before HTTP, and limits retries to three per GUID and three per check.
  A fixed diagnostic code records failures without upstream text or credentials.
  Recovery runs separately from ordinary worker maintenance and tool startup.

## Interfaces

`manage_github_notifications` accepts `list|subscribe|pause|resume|delete`, a connected
repository name/ID, optional `pull_request|issues` events and the current user's
request quote. It rejects group requests, workflows, stale run fences, changed bots
and quotes absent from the current request. Registration is local and included in
the combined production-factory startup fixture. No new dependency was added.

Explicit diagnostic controls share the same policy:
`/notifications`, `/notifications subscribe owner/repo [prs|issues]`,
`/notifications pause|resume|delete owner/repo`. These do not add Telegram menus.

Panel API:

- `GET /api/admin/workspaces/:id/github/notifications`: workspace maintainer
  notification settings, own saved subscriptions, automatic maintainer
  repositories, accessible repositories, webhook URL and configuration status.
- `POST` to the same path: validated subscription action; the panel supplies the
  saved revision for existing records. `pause` also creates a paused override
  for an automatic maintainer repository. Owner/destination cannot be supplied.
- `PUT /api/admin/workspaces/:id/github/notifications/settings`: updates
  `autoNotifyMaintainers` with optimistic `revision` checking and audit logging.
- `POST /api/admin/workspaces/:id/github/notifications/webhook`: operator-only
  shared secret update/generation. Secrets are returned once and stored encrypted.

## UI acceptance criteria

Applicable preferences: **Add and create flows use modals**, **Content layout owns
card spacing**, **Routine action confirmations and request errors use toasts**,
**Loading keeps the layout visible**, shared dropdowns and shared checkbox styles.
Scope: the notification page, its New/Edit/Delete and shared-secret dialogs.
**Card actions stay at the top right** also applies to the subscription heading,
including at mobile widths.
No exception or new general preference is introduced.

The comparable implementation is Review Bot's saved configuration and modal editor.
Observable criteria: saved subscriptions contain no form controls; New/Edit use the
shared named modal and dropdown; cancel discards edits; failed saves preserve the
draft; pending saves prevent dismissal/duplicate submission; actions update saved
labels and toasts; unknown/loading data is not presented as an empty list; missing
identity and unavailable access are explicit; 1280px and 390px layouts do not
overflow and keep first/last visible content within intended card padding.

## Verification

Verified baseline: `f615f56588f3b33afe6e4488553a8369fa03b23c`, the group-feedback
implementation whose 41 selected browser passes and deterministic validation are
recorded in implementation-status.md. The starting checkout was release
`c81cbf6d470f85353590958df82f13d1933ccfd1`. Comparing the baseline to that checkout
shows only AGENTS instructions and the package version; no dependency or runtime
code change intervenes. The pre-existing deletion of `CLAUDE.md` was preserved.

Fresh selected suites cover the notification flow, plugin catalog, GitHub repository
selection/refresh, Review Bot/Codex configuration and application update/version
flows. These exercise the affected shared components and entry points, including
the intervening version change. The unchanged group-feedback baseline evidence is
not represented as a fresh run. Google, Browser, skills and unrelated UI journeys
are outside this bounded selection; this is not a full browser-suite claim.

Final checks: lint (nine pre-existing warnings), strict types, 1,744 passing tests
with eight Docker-gated skips, build and the Node runtime contract passed. All
13 notification integration tests passed. There are 33 distinct selected browser
cases, with focused notification reruns after scoped visual changes. See
[implementation evidence](implementation-status.md#personal-github-notifications-2026-11-14).
No live account connection, webhook registration, GitHub write, Telegram send,
integration/push or deployment is part of this task.
