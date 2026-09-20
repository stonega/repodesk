# Runnable examples

`health.http` checks a configured local API. `model-settings.http` shows an
operator saving an OpenAI-compatible endpoint, custom model and thinking level. `workflow-proposal.json` matches the
implemented proposal schema; replace its destination with your linked group (or
verified private Telegram ID) and its skill ID with an enabled published workspace skill.

In the admin panel's Workflows editor, paste the JSON and select **Preview approval
proposal**. Review the resulting immutable payload and next runs, then approve it.
The proposal alone never activates a schedule.

For API clients, log in with `POST /api/admin/auth/login`, retain its session cookie,
obtain the CSRF token from `/api/admin/auth/session`, and send the exact configured
`Origin` plus `X-CSRF-Token` on mutations:

- `POST /api/admin/workspaces/WORKSPACE_ID/workflows` — proposal JSON.
- `POST /api/admin/workspaces/WORKSPACE_ID/approvals/APPROVAL_ID` — `{"approve":true}`.
- `POST /api/admin/workspaces/WORKSPACE_ID/workflows/WORKFLOW_ID/action` —
  `{"version":1,"action":"pause"}`.

Use dedicated fixtures or a staging bot. Real approval authorizes future publication
to the displayed destination. Source/destination and actor checks run on the server.

See [polling.env](polling.env) for opt-in local Telegram reception without a webhook.

See [runtime-logs.http](runtime-logs.http) for operator log filters and cursor pagination.

`pi-extension.ts` is an unchanged Pi-format extension adding `count_words`.
`pi-extensions.json` grants it to an explicit workspace; replace the example UUID.
Copy both to `extensions/`, name the manifest `extensions.json`, then use
`extensions.compose.yaml` as described in [setup](../docs/implementation/setup.md#llm-plugins-pi-extensions).

[plugins.http](plugins.http) demonstrates the operator plugin registry API. The Plugins
page manages installed-file registrations and grants; it does not upload or install code.

- `code-truth.compose.yaml`: optional private local Code Truth service with a separate bearer secret and persistent indexes.
- `code-truth.http`: configure repositories and check workspace index status through authenticated operator APIs.

`github-app.compose.yaml` adds server-side GitHub App credentials to the app and worker.
Use it after `code-truth.compose.yaml`; follow [GitHub App setup](../docs/implementation/github-app.md).
