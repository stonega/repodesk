# Codex issue-to-PR tasks

Implemented locally, 2026-09-21. This is a built-in Pi extension backed by an
application service with **GitHub Actions** (the default) or **Local Podman**
execution. Neither backend runs repository code inside the bot. This page describes
the GitHub Actions backend; see [Local Codex execution](codex-podman.md) for the
custom-provider configuration, workspace API key management and local repository commands.
Live GitHub/Codex execution remains a staging gate; deterministic tests use fake
GitHub responses and real PostgreSQL. No deployment, account connection or live
coding run is performed by setup or tests.

## Configure a repository

1. Connect the workspace's GitHub App and select repositories under **Plugins**.
2. In the GitHub App's repository permissions, retain **Contents: read** and
   **Issues: read and write**, and add **Actions: read and write** and
   **Pull requests: read**. Approve the installation's updated permissions.
   The guided App registration initially requests only source-read/issue-write;
   this optional extension requires the additional permissions afterward.
3. Copy [the workflow template](../../examples/coding/repodesk-codex.yml) to
   `.github/workflows/repodesk-codex.yml` on the repository's **default branch and
   configured development branch**. GitHub requires the dispatch workflow on the
   default branch; execution checks out the dispatched branch's exact commit.
4. Configure these repository Actions settings:
   - Secret `OPENAI_API_KEY`: used only by the Codex action's API proxy.
   - Variable `REPODESK_BOT_LOGIN`: the connected App's exact bot login, e.g.
     `my-repodesk-app[bot]`. The template refuses other actors and manual reruns.
   - Variable `REPODESK_CHECK_COMMAND`: a required, trusted repository check command,
     e.g. `bun run check && bun run typecheck && bun test && bun run build`.
   - Optional `REPODESK_SETUP_COMMAND`: install required runtimes and dependencies
     before Codex starts. Adapt the template's setup steps to the repository;
     the stock Ubuntu runner does not provide every project runtime.
   - Allow GitHub Actions to create pull requests. Organization policies may
     require an administrator to enable this. The publish job requests only
     Contents-write and Pull-requests-write using its own `GITHUB_TOKEN`.
   Existing repositories using `deepx-codex.yml` can keep that configured
   filename and its `DEEPX_*` variables until they install the RepoDesk
   template on both required branches. Earlier runs and PR branches remain
   discoverable during the transition.
5. Under **Plugins → Codex implementation**, add a repository, base branch
   (default suggestion: `develop`), workflow filename and maintainers. Maintainers
   are active, allowed workspace members identified by their Telegram user IDs.
   They need not be workspace administrators. An owner/admin is **not** implicitly
   a coding maintainer. Enable the extension.

No new application dependency or SQL migration is required: optional coding
configuration and task records live in the existing tenant JSONB aggregate.
Restart updated API/worker processes together. Saving settings applies without a
restart and uses an independent optimistic revision for this extension.

GitHub Actions minutes and Codex API spend are separate from the bot's Pi chat
usage/budget ledger. Configure spending limits in GitHub/OpenAI. The template has
45-minute implementation and 10-minute publication job limits; the bot requests
cancellation after two hours of task tracking. These are operational limits, not
cost guarantees. The template uses versioned actions; pin reviewed commit SHAs
according to the target repository's dependency policy.

## Use from Telegram

A configured maintainer can ask:

> Implement a fix in example/workspace: the recap omits the last message. Add a
> regression test and open a PR.

The `propose_coding_task` tool drafts the exact repository, base branch, issue title
and body. The requesting maintainer reviews a single Telegram approval that
explicitly authorizes **creating the issue, starting Codex, pushing a task branch,
and opening a draft PR**. Another actor cannot approve it. Approval expires after
15 minutes; after approval the background workflow has its own lifecycle.

The service creates the issue, dispatches the configured workflow, and tracks the
remote run. Each run uses a fresh checkout and a unique
`codex/repodesk-<task UUID>` branch. Codex implements the reviewed requirements;
configured project checks must pass. A fresh publish runner applies the patch as
data without running repository code, pushes the branch and opens a draft PR
against the configured development branch. Its body references the issue's full
URL and workflow run. Changes to `.github/` are rejected by the supplied template.
No automatic merging is performed.

Task progress and issue/workflow/PR links return to the initiating chat/topic.
Ask “What is the status of coding task <UUID>?” or “Stop coding task <UUID>”.
The status/cancel tools permit the initiator or current repository maintainers.
Operators can inspect task records and request Stop under Plugins. A revoked
initiator who still has ordinary workspace access may stop their own task.

Settings can be inspected/changed through
`GET|PUT /api/admin/workspaces/:id/plugins/coding`. PUT accepts
`{ revision, settings: { enabled, repositories: [{ repositoryId, baseBranch,
workflowFile, maintainers }] } }`. Operators can request cancellation with
`POST /api/admin/workspaces/:id/plugins/coding/:task/cancel` and `{}`.
These endpoints enforce operator ownership, active session, Origin and CSRF.
See [the HTTP example](../../examples/coding/settings.http).

## Permission, durability and recovery boundaries

The model supplies task data, never authority. Active membership, whitelist,
repository maintainer grant, connected repository, destination and pinned
configuration are checked at proposal, approval and before each issue/dispatch
write. Checks run again after installation-token minting. Tokens are restricted
to one repository: Issues-write for issue creation; Actions-write,
Contents-read and Pull-requests-read for workflow control. No token, model secret,
raw GitHub response or generated code is stored in task records/routine logs.

Every irreversible POST has a durable reservation. Concurrent workers claim
under the workspace row lock; duplicate approvals cannot enqueue another task.
Interrupted issue/dispatch reservations become **unknown**, never automatic retries.
GitHub run discovery matches the exact task UUID, branch and workflow event;
PR lookup validates the task branch, repository, base branch and issue reference.
Read-only polling can retry temporary outages. A successful workflow without a
matching PR is reported for inspection, never silently called successful.

Changing coding settings, removing a maintainer, cancelling the originating run,
workspace/deployment pause or access revocation blocks undispatched work and
requests cancellation of a known remote run. Remote cancellation is **best-effort**:
a dispatched workflow is already an external operation. Publication may race Stop,
and disconnected/revoked GitHub credentials can prevent cancellation. Inspect the
workflow link and stop it on GitHub if necessary. Workspace deletion purges local
coding state, not remote issues, branches, PRs or Actions artifacts. Stop remote
runs before deleting a workspace. Retention follows workspace content retention;
the pilot accepts up to 10 active and 200 retained coding tasks per workspace.

For **unknown** outcomes, inspect the repository's issues, Actions runs named
`repodesk-coding:<UUID>`, branch and PR before starting a new request. Do not rerun the
remote workflow or re-dispatch the same task. GitHub may have accepted a POST even
when the bot received no response. Known workflow failures can leave an issue or
branch for human inspection. Starting another task always creates a new issue and
requires a new maintainer approval.

Official references:
[Codex GitHub Action](https://learn.chatgpt.com/docs/github-action),
[Codex automation](https://learn.chatgpt.com/docs/non-interactive-mode),
[workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs).
