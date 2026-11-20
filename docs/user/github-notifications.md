# GitHub notifications

RepoDesk can send a private Telegram notification when a selected repository
receives a new pull request or issue. By default, active workspace members with
verified GitHub **Maintain** or **Admin** access on a connected repository
automatically receive these private alerts (skipping PRs and issues they opened
themselves). Any member can also create personal subscriptions or pause and
customize individual repositories.

Notifications include the repository, item number, title, author and GitHub
link. Draft PRs are included and labeled. Notification delivery does not require
Code Truth, Codex or Review Bot and does not call a model. Interpreting a
natural-language subscription request uses the normal chat assistant.

## Automatic maintainer notifications

When **Plugins → GitHub notifications → Repository maintainers** is enabled (the
default), RepoDesk automatically alerts active workspace members whose verified
GitHub account currently has **Maintain** or **Admin** permission on that
connected repository:

- Alerts go only to each maintainer's private main Telegram chat.
- PRs and issues opened by that same maintainer are skipped.
- Write-only, Triage, Read and unlinked members are not automatically notified;
  they can still subscribe manually.
- If a maintainer already has a personal subscription (enabled or paused) for a
  repository, that personal rule takes precedence so no duplicate alerts are
  sent.
- Workspace administrators can disable or re-enable automatic maintainer alerts
  from **Plugins → GitHub notifications → Repository maintainers → Edit**.
  Disabling stops queued automatic alerts; re-enabling covers only new events
  opened afterward.

## Set up GitHub delivery

Connect the [GitHub App and repositories](github.md). Give RepoDesk a public HTTPS
address. In **Plugins → GitHub notifications**, the owning deployment operator can
inspect the Webhook URL and edit or generate its shared secret under **Delivery**.
Save the same URL and secret in the GitHub App settings, enable webhook delivery,
and subscribe to `issues` and `pull_request`. The App needs at least read access to
Issues and Pull requests for these events.

New Apps created through RepoDesk include these event subscriptions. Existing Apps
need `issues` added manually. Local registrations retain an inactive placeholder
until a public HTTPS address is configured. Saving a secret in RepoDesk does not
update GitHub or prove that events can arrive. The secret is shared with Review
Bot and the operator's other workspaces; replacing it requires updating GitHub too.

## Subscribe from Telegram

Start the bot privately, join the intended workspace and ask:

- “Notify me when example/app receives a new PR or issue.”
- “Only notify me about new issues in example/app.”
- “Show my repository notification subscriptions.”
- “Pause notifications for example/app.”
- “Resume notifications for example/app.”
- “Delete my notification subscription for example/app.”

Name a connected repository. Notifications always go to your private main chat,
even when you subscribe from a private Topic. Group and shared Topic destinations
are not supported. Other members have their own subscriptions.

## Manage subscriptions in the panel

Open **Plugins → GitHub notifications**. Link your Telegram identity from
**Account** first. Only your own subscriptions appear. Choose **New**, select a
repository and the events to receive, then save. **Edit** changes events and
enables the subscription; **Pause**, **Resume** and **Delete** control it.
The saved list also shows the latest retained delivery state.

An active workspace membership and current repository access are required. Linked
GitHub accounts must have a fresh permission snapshot; unlinked members retain
the existing operator-managed access policy. Membership or permission revocation,
App removal/suspension, repository removal and connection changes stop affected
notifications. After an App lifecycle revocation, refresh or reconnect GitHub before
explicitly resuming. Restoring access does not replay cancelled deliveries.

## Delivery and recovery

Subscriptions cover new events from their activation time, at GitHub's timestamp
precision. Earlier items, comments, reopenings, commits and merge/close updates do
not generate notifications. Pausing or changing a subscription cancels older
queued notifications for that subscription. Resume starts a new activation period.

Accepted events and outgoing messages are persisted. Duplicate webhook deliveries
and repeated opened events are deduplicated. Telegram rate limits and known
temporary failures use the normal delivery retries. An uncertain send is recorded
as **delivery unknown** and is not automatically sent again; inspect it through
the existing delivery recovery controls before deciding what to do.

While a notification subscription or Review Bot is enabled, the worker checks
failed GitHub App webhook deliveries every five minutes. It scans up to one page
of 100 deliveries per check, follows GitHub's pagination cursor on later checks,
and requests at most three redeliveries per check and three attempts per event.
This recovery is limited to the last three days. GitHub retains its own delivery
history; extended outages and events outside that window require investigation.
No historical notification backfill is provided.
