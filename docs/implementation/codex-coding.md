# Codex issue-to-PR tasks

Codex implementation runs approved repository tasks in isolated local Podman
containers. The bot uses Pi for Telegram conversation; the coding service owns
authorization, task state, issue creation and publication. Setup and deterministic
tests do not start a coding task, connect an account or send a message. A live
end-to-end GitHub/Codex staging run remains a release gate.

The [continuous collaboration design](../design/codex-collaboration.md) is now
implemented behind per-repository **Direct** execution policy. Existing settings
remain **Reviewed** when the new policy is omitted. The reviewed issue-to-PR
workflow below is preserved; direct tasks use original received messages and do
not require creating an issue.

The runner defaults to four active tasks. Set `CODEX_RUNNER_CONCURRENCY` (1–32) in
the deployment environment to change capacity. API-key tasks execute Codex in
parallel; tasks sharing one workspace's ChatGPT login serialize Codex phases while
preparation, checks and publication can overlap. See the
[runner guide](codex-podman.md#lifecycle-and-recovery) for resource limits and recovery.

Pi receives `start_development_task` only when at least one repository explicitly
uses **Direct** policy, and its target list includes only those repositories.
**Reviewed** repositories, including older configurations without a development
policy, use `propose_coding_task` and an actor-bound Telegram approval. A rejected
direct start reports `coding_direct_execution_disabled`; it is a policy rejection
before any GitHub checkout, not evidence of repository reachability failure.

## Continuous collaboration

In the repository editor, select **Direct** to allow a current maintainer's clear
instruction to authorize a task. Set whether verified implementations
publish a draft PR by default. Codex has no application-imposed execution-cycle,
repair-count, active-time or token quotas. It continues authorized work until
completion, a necessary question, cancellation or failure. Provider/account
limits, container isolation, retention and current permissions still apply.
Pi selects the requested repository and relays source IDs. Codex investigates,
interprets the original instruction, decides the solution and handles checks.
Analysis-only requests receive investigation answers and cannot publish changes.
Implementation needs a source-grounded Codex intent result; uncertain intent waits
for a product clarification. Semantic intent quality remains a live pilot gate.

Intake output constrains evidence to the exact current authenticated text and
its revision, including short retries. A captionless media answer instead pins the
preceding authenticated text; the image supplies reference data, not authorization.
Codex can use reference context to
understand a retry, but must not substitute an explanation or earlier message for
that evidence. Intake returns only `intent` or `needs_input`; the application
still rejects unmatched evidence with `coding_intent_unverified` before granting
implementation or publication. Analysis and work retain their result contracts.

Direct tasks receive screenshots from original requirements and bound follow-ups
as Codex image inputs, including photo-only answers. Text/code files and selectable
PDF text also reach the task through the guarded attachment decoder. See
[attachment input](telegram-attachments.md) for limits, authorization and recovery.

Task-bound messages reach Codex at the next completed turn boundary. Reply to its
question or task update, or continue the same private/linked-group Topic. A Topic
with several tasks offers a selection; private conversations and unaddressed group
messages are never imported across audiences. Outside Topics, reply to the task's
confirmed message. Edits append new inputs. A necessary Codex question checkpoints
partial work and releases the runner slot; answers preserve their original text.
Tap inline **Cancel** on a task notice, or send **stop**, **停止**, or `/cancel` in
the bound conversation to stop the task. Inline **Status** and `/status` in that
conversation report its state and confirmed PR. The admin task
list supports cancellation in both modes. Its **Stop** icon button has a
task-specific accessible label and hover title, and opens a confirmation dialog
showing the task and repository before sending cancellation.
**Cancel** leaves the task running; published issues, branches and PRs remain on
GitHub after stopping.

Codex discovers environment preparation and relevant checks from AGENTS.md,
project manifests, scripts and CI. No setup/check commands are configured in the
panel. Its bounded verification plan is captured by the runner and replayed
without model or GitHub credentials; patch integrity is also checked. The first
plan stays fixed during automatic repair. Failed checks return
bounded private diagnostics to Codex for automatic repair. New requirements
received before publication reservation block the older
patch until they are consumed and checked. Inputs arriving after reservation
become the next cycle. Missing token reports are marked as unknown usage rather
than charged as a retired allowance. Reported tokens are not a provider-dollar
ceiling. Retention still applies.

The final-result field schema is generated from the application validator.
Status-specific rules still require a nonblank question for `needs_input` and
a nonempty verification plan for `completed`. A completed turn with missing,
invalid JSON or invalid result fields gets one read-only correction turn in the
same Codex thread and checkout, using the same output schema. This corrects only
the result; independent repository checks still run afterward, and any fixed
verification plan stays unchanged. Cancellation and sign-in failures retain
their normal handling. Reported usage includes both turns, with missing reports
marked unknown. Safe issue codes and known field paths survive account-volume
cleanup in runner state and the tenant-scoped attempt record. Historical stopped
tasks are not automatically retried by this correction.

A follow-up fetches the existing PR and current branch head, then updates that
branch using non-force publication from a fresh container. Closed/merged PRs are
not recreated. A remote-head change detected before any write returns to current
code and checks. Ambiguous publication is never replayed; a read-only GitHub lookup
can confirm exactly the recorded commit/branch/PR. Otherwise the task stops with
an unknown outcome for inspection. Existing confirmed links remain available.

Threads can resume within a surviving work volume (including automatic repair).
New isolated cycles reconstruct from original inputs, question/answer decisions,
prior outcomes and current code if the session is unavailable. Device credentials
are sealed separately and reacquired for each implementation. Expired checkpoints
are rebuilt from retained requirements; they are never described as surviving
patches. Permission/configuration changes, bot changes and removed source context
stop execution. Source expiry and soft deletion scrub relational private content
immediately and retry idempotent container/volume erasure until confirmed.

GET additionally returns `developmentTasks`; repository settings accept optional
`development: { executionMode, publishByDefault }`.
The existing cancellation route handles continuous
task IDs. The migration creates tenant-scoped task/input/grant/attempt/event tables;
it enables no new execution policy by itself. See [delivery evidence and rollout](codex-collaboration-plan.md).

Migration `014_remove_coding_limits.sql` removes old limits from repository and
current task policies, preserves historical grants and attempt envelopes, and
rebuilds token totals from reported usage. It does not restart stopped tasks.

## Set up

1. Configure the [local Podman runner](codex-podman.md) and build its task image.
2. Connect the workspace GitHub App and select each target repository. For local
   publication, grant **Contents: read and write**, **Issues: read and write** and
   **Pull requests: read and write** to the App installation.
   A read-only Contents grant can read a checkout but cannot support the complete
   coding workflow. GitHub token permission rejections report
   `github_app_permissions_missing`; update the App permissions and accept the
   installation permission update in GitHub before retrying.
3. Under **Plugins → Codex implementation**, add each repository with a base
   branch and active Telegram maintainer IDs. Codex handles environment preparation
   and verification automatically; neither Add nor Edit asks for commands.
   Choose **Custom provider API key** or **ChatGPT device code**
   in the panel. The custom provider endpoint and model are deployment settings;
   its key is saved per workspace (with an optional deployment fallback). Device
   code sign-in shows a link and one-time code in the panel. Both authentication
   methods support connected public and private repositories; repository access
   uses the workspace GitHub App. Enable the extension after signing in.
   Starting sign-in displays progress and times out after 20 seconds if no response
   arrives. Use **Recheck connection** to recover runner availability or an
   uncertain sign-in response without closing the editor or losing its draft.
4. Keep **Reviewed** for actor-bound issue/branch approval, or explicitly select
   **Direct** per repository after validating the dedicated live pilot journey.

The Add and Edit repository selectors search connected repositories by owner or
name, ignoring case. Use Arrow keys and Enter or select a result directly; Escape
closes the results before dismissing the dialog. Configured repositories are
excluded from Add, and Edit keeps its current repository available.

The repository editor shows a saved Telegram username when available, alongside
the numeric user ID. Maintainer grants remain bound to numeric IDs.

No repository Actions workflow or Actions permission is required. Coding provider
usage through a custom provider is billed separately from Pi chat usage.

The operator API is `GET|PUT /api/admin/workspaces/:id/plugins/coding`.
PUT accepts `{ revision, settings: { enabled, backend: "podman", authMode:
"provider_key" | "device_code", repositories:
[{ repositoryId, baseBranch, maintainers, development? }] },
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

Model authentication does not grant repository access. The worker uses the
connected GitHub App to mint a fresh installation token scoped to the selected
repository and the current operation, for both public and private repositories.
Maintainer, connected-repository and approval/direct-policy checks still apply.
The worker creates the issue after a durable reservation. The supervisor uses
separate preparation, environment initialization, implementation, verification and publication containers. Only the
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
shows a migration notice until the operator saves the local runner settings. Queued and issue-created Actions tasks become **cancelled**; tasks
that may already have started remotely become **unknown**. Their recorded links
remain visible, but the worker no longer polls or cancels Actions runs. Inspect
and, if necessary, stop an already-running workflow in GitHub before starting
another task.

No provider key, installation token, raw GitHub response or generated code is
stored in routine task records or logs. The pilot retains up to 10 active and 200
recorded coding tasks per workspace. See [runner isolation, limits and
recovery](codex-podman.md).

Migration `013_automatic_coding_checks.sql` removes old repository command settings
and increments affected coding revisions, invalidating old grants. Older client
command fields are discarded on save; they cannot override automatic verification.
Historical approval evidence stays immutable. Drain/cancel active attempts before
upgrading app, supervisor and job images together.
