# Continuous Codex tasks

Task messages offer **View conversation**, opening a read-only Telegram Mini App
with retained original inputs, Codex messages and expandable activity. It follows
Telegram theme and viewport settings and rechecks the viewer's task/audience
access. Enable the bot's Main Mini App at the existing site's `/mini` URL before
rollout. See [task history and setup](telegram-mini-app.md) for capture boundaries,
recovery, retention and live client acceptance.

Codex implementation runs approved repository tasks in isolated Docker or
OpenSandbox environments. The bot uses Pi for Telegram conversation; the coding service owns
authorization, task state, conversation and publication. Setup and deterministic
tests do not start a coding task, connect an account or send a message. A live
provider-key GitHub/Codex VPS run and an isolated OpenSandbox repeat passed in the
[landing acceptance environment](codex-landing-acceptance.md). Live account-auth
refresh/continuation and a production OpenSandbox rollout remain separate gates.

The [continuous collaboration design](../design/codex-collaboration.md) is the only
Codex task workflow. Verified users hand original messages to Codex, continue the
same task/PR, and ask factual questions during execution or after completion.
Tasks require no Issue, execution-mode selector or separate coding approval.
Reviewed proposals and the legacy issue/exec engine have been removed without a
compatibility or automatic migration path.

The runner defaults to four active tasks. Set `CODEX_RUNNER_CONCURRENCY` (1–32) in
the deployment environment to change capacity. API-key tasks execute Codex in
parallel; tasks sharing one workspace's ChatGPT login serialize Codex phases while
preparation, checks and publication can overlap. See the
[runner guide](codex-runner.md#lifecycle-and-recovery) for resource limits and recovery.

Temporary GitHub permission-sync failures hold task progression for automatic
retry, retaining the same attempt and checkout. Already-running local work can
finish under its original grant; new execution, auth resumes, result delivery and
PR publication wait until current access is verified. Confirmed permission loss,
configuration changes and explicit Stop still cancel pending execution. Published
PRs and completed results retain their saved status; follow-ups reauthorize access.
Rate limits use GitHub's cooldown and increasing sync backoff. An unavailable
permission check reports automatic recovery; a confirmed denial points to
`/github sync` or `/github connect` before a new request. Cancelled tasks from older
builds require explicit recovery and are not restarted automatically. See the
[permission recovery journey](../../examples/github-coding-permission-recovery.md).

New tasks bind a GitHub connection generation and a revision for their selected
repository. Metadata or permission changes in other repositories do not cancel
them. A workspace metadata refresh can temporarily hold progression until the
member's permissions are synced at the current workspace revision; the same
attempt then continues. Target repository changes (including visibility, name,
default branch or removal), connection replacement, Codex settings changes and
confirmed target permission loss still fence execution and publication. Restoring
target metadata cannot revive an older grant. Historical tasks without the scoped
snapshot keep the previous global revision check; terminal failures are not replayed.

Checkout failures report a safe cause before Codex starts. When the configured
base branch is missing, Telegram outcomes, requested status and the admin task
summary name the repository and branch and point to **GitHub repository settings**
to fix the default branch before a new request. Other clone failures
explain that checkout failed and suggest checking GitHub access and branch settings.
Raw Git output and credentials remain private. Missing PR branches are not
misreported as missing configured base branches; uncertain publication keeps its
existing unknown-outcome handling. Old failures saved only as a generic code
cannot recover their original cause after an upgrade.

Pi receives `start_development_task` when the enabled Codex plugin has connected
GitHub repositories. Its target list includes only repositories where the verified
user has current GitHub write access. Questions, status and ordinary conversation
cannot authorize implementation or publication.

When a request is blocked because the member has not connected GitHub, the tool
description and bundled GitHub skill direct the assistant to explicitly say:
send `/github` in the bot's private chat, follow the authorization link, return
to confirm the account, then resend the request. Coding-task failure notices use
the same recovery steps. `/github connect` remains a supported alias.

## Continuous collaboration

Documentation and example repositories named in authenticated task inputs can be
prepared as reference snapshots when they are selected in the same workspace and
every contributing member has verified read access. Use full repository names when
short names are ambiguous. The worker pins the source default branches before
intake; only the original target receives implementation and PR publication grants.
Missing source/environment prerequisites produce a blocker notice instead of a
request for repeated human confirmation. Product questions still wait for an answer.
See the [reference-source example](../../examples/codex-reference-sources.md).

New coding attempts can recover confirmed infrastructure interruptions in
preparation, setup, implementation and checks. The application revalidates
authorization and supplies fresh credentials before resuming the same attempt
and retained workspace. The fixed check plan remains enforced. Routine recovery
updates the existing progress message; Stop remains available. Publication is
never replayed through this path, and historical failures are not restarted.
See [recovery evidence and boundaries](codex-runner.md#lifecycle-and-recovery).

A verified GitHub collaborator's clear instruction can authorize a task.
Verified implementations automatically publish PRs ready for review; no
publication checkbox or separate PR request is required. Saved publication
opt-outs are normalized to enabled. Existing tasks with a different authority
snapshot stop on the configuration check rather than silently gaining authority.
Codex has no application-imposed execution-cycle,
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

Tasks receive screenshots from original requirements and bound follow-ups
as Codex image inputs, including photo-only answers. Text/code files and selectable
PDF text also reach the task through the guarded attachment decoder. See
[attachment input](telegram-attachments.md) for limits, authorization and recovery.

Ordinary Topic messages and replies to old task updates first reach Pi for intent
handling. Pi answers conversation, explanation, status and PR-review requests with
its permitted read tools; metadata alone does not support a code review. Clear code
changes continue the matching task through `send_development_input`, while a new
development goal can start a separate task. Codex is also available when explicitly
requested. The presence of a task never imports every later message into its inputs.

For questions about the task's current work or technical choices, Pi reads
`development_task_conversation` and can use `ask_development_task` for a fresh
answer. Pi may formulate technical follow-ups within the user's request. Questions
and confirmed replies remain in the same task/audience without granting changes
or publication. Receipt, explicit reading and an actual answer are distinct;
answers arrive asynchronously in the original chat/topic. Questions after completion
or while a product choice is pending use a separate read-only execution, preserving
the result, question and PR. New implementation waits for its cleanup. See the
[conversation examples](../../examples/codex-task-conversation.md).

Text and captioned replies to a current Codex question receive Pi intent handling,
so explanations and repository corrections do not become implementation answers.
Captionless media replies to its confirmed notice still route directly to the task.
Edits/duplicates of accepted inputs retain their task binding; source identity also
deduplicates an input received through both Pi and the direct media route.
Private conversations and unaddressed group messages are never imported across
audiences. New implementation requirements reach the next completed turn boundary;
factual questions can use the active-turn channel. A necessary Codex question checkpoints
partial work and releases the runner slot; answers preserve their original text.
Tap inline **Cancel** on the latest task notice, or send **stop**, **停止**, or
`/cancel` in the bound conversation to stop the task. **Status/Cancel** appear only
on the latest confirmed task message; older messages lose these controls after
the new one is delivered. Failed or uncertain sends keep the previous controls.
Inline **Status** and `/status` in that conversation report its state and confirmed
PR. Confirmed PR messages retain their Review/Merge links. The admin task
list supports cancellation in both modes. Its solid **Stop** icon button has a
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

Successful publication creates a PR ready for review after the recorded checks
pass. A verified follow-up also marks an existing draft PR ready for review before
reporting success. Previously completed draft PRs change on their next authorized
published follow-up; they are not updated in bulk. A failed or unconfirmed readiness
update leaves publication unknown. Read-only recovery requires an open, non-draft
PR at the recorded commit. Review Bot fixes preserve that plugin's draft policy.

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

GET returns a single `tasks` collection. The task authority snapshot records the
fixed `publishByDefault: true` policy; execution mode and publication are not
operator choices.
The existing cancellation route handles continuous
task IDs. The migration creates tenant-scoped task/input/grant/attempt/event tables;
it enables no new execution policy by itself. See [delivery evidence and rollout](codex-collaboration-plan.md).

Migration `014_remove_coding_limits.sql` removes old limits from repository and
current task policies, preserves historical grants and attempt envelopes, and
rebuilds token totals from reported usage. It does not restart stopped tasks.

## Repository targets and correction

Chat Agent separates a modification target from documentation/example sources.
Both coding tools accept the target `repositoryId` and `targetRepository`, a
literal name quoted from the authenticated human input (empty for an implicit
contextual target). The application checks quoted names, exact names and unique
prefix abbreviations against connected repositories. Document/issue URL paths
cannot supply that quote. The check validates identity and evidence; semantic
target/reference classification still depends on the model and remains a live
pilot gate.

`send_development_input` can correct a repository when the initiating actor names
the new target in the current message. Replacement requires an idle queued/waiting
task, no active execution/conversation/cleanup/lease, no PR or verified artifact,
and either no prior attempt or a runner-confirmed empty exported patch. Unknown
patch state and existing work refuse replacement. Original retained sources must
match their accepted text and fit the bounded handoff. The workspace transaction
stops/fences the old task and creates one linked replacement, preserving original
requirements as references. Duplicate corrections return that same task. The new
task starts read-only intake with current target permissions and the current human
correction as its authorization evidence; it inherits no old patch, session or
implementation/publication grant. An unsafe result must not be bypassed by a
chat-agent cancel/start sequence.

For interactive chats, up to five recent tasks owned by the actor in the same bot
and conversation supply a current-state snapshot. Retained source hashes, repository
grants and coding revision fence derived replies. Explanations use the actual
blocker and preserve the distinction between a repository and its branch. Saved
handoff summaries use current task state rather than always claiming queued.

Deploy matching app/worker and supervisor builds for empty-patch evidence. Old
attempts without this evidence cannot be automatically replaced. No dependency,
configuration or SQL migration is added; historical tasks are not bulk-restarted.

## Set up

1. Configure the [local local runner](codex-runner.md) and build its task image.
2. Connect the workspace GitHub App and select each target repository. For local
   publication, grant **Contents: read and write**, **Issues: read and write** and
   **Pull requests: read and write** to the App installation.
   A read-only Contents grant can read a checkout but cannot support the complete
   coding workflow. GitHub token permission rejections report
   `github_app_permissions_missing`; update the App permissions and accept the
   installation permission update in GitHub before retrying.
3. Under **Plugins → Codex**, configure the shared provider/model or ChatGPT
   device-code sign-in. Enable the plugin after connecting credentials.
   Sign-in progress is bounded; Recheck connection preserves the editor's draft.
4. Verified implementations publish PRs ready for review automatically.
   Codex reads the repository's default branch from GitHub; branch settings and
   collaborator access are managed in GitHub. There is no extra repository editor,
   maintainer list or plugin repository grant.
5. Each member connects and verifies their GitHub account with `/github connect`
   in their private bot chat. Current GitHub write access is required to start,
   continue or publish coding work. Read-only/unlinked users cannot start tasks.

No repository Actions workflow or Actions permission is required. Coding provider
usage through a custom provider is billed separately from Pi chat usage.

The operator API is `GET|PUT /api/admin/workspaces/:id/plugins/coding`.
PUT accepts `{ revision, settings: { enabled, backend: "podman", authMode:
"provider_key" | "device_code", model? },
providerApiKey? }`. Omit `providerApiKey` to retain it; send `null` to remove
the saved key. If `development.publishByDefault` is supplied, the server normalizes
it to `true`; it cannot disable publication. Responses return only
`providerApiKeyConfigured` and device
connection status, never credentials. Device sign-in uses `POST
/api/admin/workspaces/:id/plugins/coding/device/start`; disconnect uses `POST
/api/admin/workspaces/:id/plugins/coding/device/logout`. Stop a task
with `POST /api/admin/workspaces/:id/plugins/coding/:task/cancel` and `{}`.
See the [HTTP example](../../examples/coding/settings.http).

## Authorization and execution

An active workspace member with verified GitHub write access can request a feature
or fix. `start_development_task` binds the original request, actor, repository and
chat/topic. Codex interprets the request in a read-only intake turn; the application
checks its evidence against the original message before granting implementation
or publication. Factual questions never create those grants.

Model authentication does not grant repository access. The worker uses the
connected GitHub App to mint a fresh installation token scoped to the selected
repository and the current operation, for both public and private repositories.
Current GitHub write access, workspace connection scope and source-bound grant
checks still apply.
The supervisor uses
separate preparation, environment initialization, implementation, verification and publication containers. Only the
preparation container gets a repository read token; Codex and checks run without a
GitHub token. Publication gets a fresh scoped write token after the worker
rechecks actor, repository, configuration and deployment authority. It rejects
`.github/` changes and opens a PR. No merge is automatic.

Each task has a status, retained conversation and, when published, a PR link. Ask for status or
stop by task UUID. Operators can inspect and stop tasks in Plugins. The initiator
may stop their own task after GitHub access is removed.

## Recovery

External publication is reserved durably and an uncertain write is never replayed.
An interrupted publication request becomes **unknown**. Check GitHub for a branch
or PR before starting another task. Cancellation during publication is best-effort.
Workspace deletion removes local task records and sealed device credentials;
it does not undo GitHub writes.

No provider key, installation token, raw GitHub response or generated code is
stored in routine task records or logs. The pilot retains up to 10 active and 200
recorded coding tasks per workspace. See [runner isolation, limits and
recovery](codex-runner.md).

Upgrade app, supervisor and job images together. The runner accepts only the
continuous-task envelope and uses the app-server conversation protocol.
