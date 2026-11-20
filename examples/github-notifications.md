# Personal GitHub notification journey

Use an isolated test bot/repository for live checks. Local deterministic tests do
not connect accounts, change GitHub App settings or send Telegram messages.

1. Connect the GitHub App and select `example/app`.
2. Configure the public Webhook URL and shared secret from
   **Plugins → GitHub notifications → Delivery** in GitHub. Subscribe to
   `pull_request` and `issues`, then enable delivery.
3. Privately ask the bot: “Notify me when example/app receives a new PR or issue.”
   Verify the saved repository, event types and private destination.
4. Open an issue and a draft PR in the test repository. Each should produce one
   private main-chat notification, with a correct link and the PR's Draft label.
5. Redeliver a webhook from GitHub's delivery history. Confirm it creates no
   additional notification. Restart the worker with an accepted pending event;
   confirm it resumes without another model run.
6. Ask “Only notify me about new issues in example/app.” Open another PR and issue;
   only the issue should produce a notification.
7. Pause the subscription. Confirm earlier pending intents are cancelled. Resume
   it and verify only new events are eligible. Delete it and confirm it disappears.
8. Inspect the panel at desktop and mobile widths. The saved list has labels and
   actions; New/Edit open a dialog. Cancel discards changes, failed saves retain
   drafts, and pending saves block repeat submissions and dismissal.
9. Revoke membership, GitHub read access or App repository access before sending a
   pending notification. Confirm delivery stops. Restoring access must not revive
   the old intent. Refresh/reconnect and explicitly resume after App revocation.
10. With a failed GitHub delivery in the last three days, inspect the bounded
    five-minute recovery and deduplication. Inspect an uncertain Telegram send;
    it must remain unknown instead of automatically replaying.

Diagnostic alternatives:

```text
/notifications
/notifications subscribe example/app
/notifications subscribe example/app issues
/notifications pause example/app
/notifications resume example/app
/notifications delete example/app
```

The authenticated panel API uses the current session cookie, Origin and CSRF token:

```http
GET /api/admin/workspaces/WORKSPACE_ID/github/notifications

PUT /api/admin/workspaces/WORKSPACE_ID/github/notifications/settings
Content-Type: application/json

{"autoNotifyMaintainers":true,"revision":0}

POST /api/admin/workspaces/WORKSPACE_ID/github/notifications
Content-Type: application/json

{"action":"subscribe","repository":"example/app","events":["issues","pull_request"]}
```

Existing-record updates should include the returned `revision`. The API derives
the actor and private destination from the authenticated Telegram identity.
