# Codex issue-to-PR tasks

Codex implementation runs approved repository tasks in isolated local Podman
containers. The bot uses Pi for Telegram conversation; the coding service owns
authorization, task state, issue creation and publication. Setup and deterministic
tests do not start a coding task, connect an account or send a message. A live
end-to-end GitHub/Codex staging run remains a release gate.

The [continuous collaboration design](../design/codex-collaboration.md) records the
accepted next direction: Pi requirements intake, Codex-led decisions, direct task
authorization and ongoing task/PR conversations. Those capabilities are not yet
implemented; the approval and one-shot execution instructions below describe
current behavior.

## Set up

1. Configure the [local Podman runner](codex-podman.md) and build its task image.
2. Connect the workspace GitHub App and select each target repository. For local
   publication, grant **Contents: read and write**, **Issues: read and write** and
   **Pull requests: read and write** to the App installation.
3. Under **Plugins → Codex implementation**, add a base branch, active Telegram
   maintainer IDs, an optional setup command and a required check command for
   every repository. Choose **Custom provider API key** or **ChatGPT device code**
   in the panel. The custom provider endpoint and model are deployment settings;
   its key is saved per workspace (with an optional deployment fallback). Device
   code sign-in shows a link and one-time code in the panel and is available only
   for trusted private repositories. Enable the extension after signing in.
4. Review the requested issue and branch in Telegram before approving a task.

The repository editor shows a saved Telegram username when available, alongside
the numeric user ID. Maintainer grants remain bound to numeric IDs.

No repository Actions workflow or Actions permission is required. Coding provider
usage through a custom provider is billed separately from Pi chat usage.

The operator API is `GET|PUT /api/admin/workspaces/:id/plugins/coding`.
PUT accepts `{ revision, settings: { enabled, backend: "podman", authMode:
"provider_key" | "device_code", repositories:
[{ repositoryId, baseBranch, maintainers, setupCommand?, checkCommand }] },
providerApiKey? }`. Omit `providerApiKey` to retain it; send `null` to remove
the saved key. Responses return only `providerApiKeyConfigured` and device
connection status, never credentials. Device sign-in uses `POST
/api/admin/workspaces/:id/plugins/coding/device/start`; disconnect uses `POST
/api/admin/workspaces/:id/plugins/coding/device/logout`. Stop a task
with `POST /api/admin/workspaces/:id/plugins/coding/:task/cancel` and `{}`.
See the [HTTP example](../../examples/coding/settings.http).

## Approval and execution

A configured maintainer can ask the bot to implement a feature or fix in a selected
repository. The `propose_coding_task` tool drafts the exact repository, base
branch, issue title and body. A Telegram approval binds the initiating actor to
creating the issue, running Codex locally, pushing a task branch and opening a
draft PR. Approval expires after 15 minutes. Another actor cannot approve it.

Before reserving issue creation, the worker checks GitHub's current repository
visibility to block device-code tasks if a selected repository has become public.
It checks again before starting Codex.
The worker creates the issue after a durable reservation. The supervisor uses
separate preparation, setup, implementation, check and publication containers. Only the
preparation container gets a repository read token; Codex and checks run without a
GitHub token. Publication gets a fresh scoped write token after the worker
rechecks actor, repository, configuration and deployment authority. It rejects
`.github/` changes and opens a draft PR. No merge is automatic.

Each task has an issue link, status and, on success, a PR link. Ask for status or
stop by task UUID. Operators can inspect and stop tasks in Plugins. The initiator
may stop their own task after a maintainer grant is removed.

## Recovery and prior configurations

Every external POST is reserved durably and an uncertain write is never replayed.
An interrupted issue or publication request becomes **unknown**. Check GitHub for
an issue, branch or PR before starting another task. Local cancellation is
best-effort during publication, since a push or PR may already exist. Workspace
deletion removes local records and the sealed device credential, and does not undo GitHub writes.

Older GitHub Actions configurations cannot propose or dispatch new tasks. The panel
shows a migration notice until the operator adds local check commands and saves
the settings. Queued and issue-created Actions tasks become **cancelled**; tasks
that may already have started remotely become **unknown**. Their recorded links
remain visible, but the worker no longer polls or cancels Actions runs. Inspect
and, if necessary, stop an already-running workflow in GitHub before starting
another task.

No provider key, installation token, raw GitHub response or generated code is
stored in routine task records or logs. The pilot retains up to 10 active and 200
recorded coding tasks per workspace. See [runner isolation, limits and
recovery](codex-podman.md).
