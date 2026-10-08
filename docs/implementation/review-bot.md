# Review Bot

Status: implemented locally; live GitHub and Codex acceptance remains a release gate.

Review Bot is a built-in plugin at **Plugins → Review Bot**. It automatically
reviews PRs in selected repositories and accepts directly addressed GitHub comments.
Its primary review framework is [Open Code Review](https://open-codereview.ai/docs)
(OCR), using the official [delegation workflow](https://github.com/alibaba/open-code-review/blob/main/pages/src/content/docs/en/integrations/delegate.md).
OCR selects reviewable files and resolves review rules; Codex supplies the analysis
through the existing local runner and workspace credentials. The task image pins
`@alibaba-group/open-code-review` 1.12.12 alongside Codex. No separate deployment
or model credential is required. The Review model editor can select a saved
provider and Responses-compatible model, or inherit Codex. Reviews and answers use
that selection; fixes use the Codex model. Rebuild the task image when updating this integration;
custom runner images must include this JSON-capable OCR version.

## Configure

1. Connect the GitHub App and repositories to the workspace. Enable Codex, configure
   the repositories and assign active maintainers. Review Bot selects from these targets.
2. Open Review Bot. New Apps created through RepoDesk retain GitHub's generated
   webhook secret automatically. If **Webhook secret** shows **Not configured**,
   configure an existing secret or generate one; generated secrets appear once in
   that dialog. The encrypted secret belongs to the operator's App and is shared
   across that operator's workspaces. Replacing a secret also requires updating it
   in GitHub.
3. New Apps created through RepoDesk with a public HTTPS domain already have the
   webhook URL, delivery and required event subscriptions configured. For an
   existing or manually registered App, set the displayed webhook URL, paste the
   secret, enable delivery and subscribe to `pull_request`, `issue_comment`,
   `pull_request_review_comment`. The receiver also handles `installation` and
   `installation_repositories` lifecycle events.
   A publicly reachable HTTPS origin is required for live delivery. Saving a secret
   in RepoDesk does not update or verify GitHub's webhook configuration. Local
   registrations retain an inactive placeholder until a public HTTPS receiver is
   configured.
4. Choose **New** in Repositories, choose an automatic review owner and save the
   repository in the dialog. The page shows saved repository names, owners and
   policy values. **Edit** opens the same editor; Cancel discards changes, failed
   saves retain them, and removal requires confirmation. Enable Review Bot.
   Automatic reviews and tagged requests are independently configurable per repository.
   The same operator/App installation repository can have Review Bot enabled in only
   one workspace, preventing duplicate reviews and ambiguous request routing.
5. To accept fixes, enable **Direct** execution for that repository in Codex and
   **Allow explicitly requested fixes to the same PR** in Review Bot. Members must
   verify their GitHub account through the existing Telegram connection flow.
   Admin-selected GitHub profile associations alone do not authorize requests.

Automatic reviews are a standing, revisioned workspace policy grant owned by the
selected maintainer. The sender of an ordinary PR event does not authorize a write.
Tagged requests require an active, verified maintainer with current repository access;
fixes also require push access. The App must have Contents read and Pull requests
read permissions for checkout; review/progress publication uses repository-scoped
Pull requests/Issues write tokens. Fix publication uses a separate Contents/Pull
requests write token. Write tokens never enter model execution or repository checks.

## Behavior

Automatic review triggers are `opened`, `synchronize`, `reopened` and
`ready_for_review`. Drafts are skipped automatically. New commits supersede old
automatic jobs. Explicit requests can work on draft PRs. Closing a PR cancels its
pending work; converting to draft stops only automatic reviews.

Reviews check out the exact PR head through the base repository's pull ref, including
fork PRs, and compare the recorded base/head commits. In the credential-free setup
phase, application code runs `ocr delegate preview --format json --from BASE --to HEAD`
and `ocr delegate rule --format json -- PATH...` in bounded batches. It validates the
JSON version, exact refs, file counts, relative paths and complete rule coverage,
then writes a task-local review plan outside the checkout. It does not run repository
setup scripts or tests. OCR never receives a GitHub/model credential or calls an LLM.
Missing OCR, incompatible/malformed output or incomplete rules fail the task with
`coding_review_preparation_failed`; there is no alternate review engine.

Codex reads the OCR plan and reviews in its read-only sandbox. Its review instructions
require a checklist of every reviewable file, matching rules, merge-base diffs,
reviewed/skipped coverage and explicit reasons for OCR exclusions and skipped files.
Coverage reporting is model-generated; the application validates preparation coverage
and inline anchors, but does not independently prove the model inspected every file.
OCR rules and repository content remain reference data, never authorization.
Review/answer turns declare
credential directories and `/proc` unreadable, remove inherited shell credentials
and keep project configuration untrusted. The runner host must support Codex’s
Linux command sandbox; a sandbox failure has no unrestricted fallback. It returns a concise summary
and up to 20 supported findings. Application code validates inline paths, sides and
diff lines and publishes a `COMMENT` review pinned to the head commit. Findings
without a valid inline anchor remain in the summary. Inline placement examines up
to 1,000 changed files and discloses incomplete placement coverage. A stale result
cannot publish against a newer head.

The page displays the existing App's actual bot handle, for example
`@repodesk[bot]`; Review Bot does not register a second GitHub App.

| GitHub comment | Result |
| --- | --- |
| `@repodesk[bot] review` | Review the current PR |
| `@repodesk[bot] explain this finding` | Read and answer in the PR |
| `@repodesk[bot] fix this` | Implement the referenced change, verify and update the same PR |
| `@repodesk[bot] status` | Report confirmed task state |
| `@repodesk[bot] cancel` | Request cancellation of the active PR task |

Both the displayed `@repodesk[bot]` handle and GitHub’s usual `@repodesk` short
mention are accepted. The bot must be addressed at the beginning of a comment line. Mentions inside
quotes, fenced code, inline code or indented code cannot authorize work. Multiline
instructions retain their original text. Inline replies include their parent review
comment as reference context. Explicit fix instructions start under the repository
policy without another approval click. General questions remain read-only.

A required question checkpoints the task. A tagged answer from the original
requester continues the same task with a new input revision and runner attempt.
Other accepted requests queue independently and serialize work on the PR. Fixes
currently support same-repository PRs targeting the configured Codex base branch;
fork PRs support reviews and answers. Merge and deployment retain their separate
authorization boundaries.

The runner selects and runs repository checks. Application services require confirmed
check success before publishing. A maintainer push restarts unpublished work from
current code. Publication proves the commit descends from the recorded head and
uses a remote-ref lease, so a concurrent rewind or deletion cannot be overwritten.
This compare-and-swap permits only a fast-forward update; it does not rewrite
history. Confirmed stale-head rejections restart work, while unknown writes do not. A task uses one progress comment,
edited for meaningful stages, questions and its final result. Automatic reviews
normally publish only the final review. Activity and cancellation are also available
in the plugin page.

## Durability, privacy and limits

Migration `016_review_bot.sql` adds encrypted operator webhook settings and delivery
receipts. Workspace JSONB stores optional Review Bot configuration and PR task
records; existing workspaces remain disabled. Receipt insertion and task creation
commit together. Stable comment/head keys handle semantic duplicates, and expiring
fenced leases protect execution across workers. The worker polls durable tasks;
no process or in-memory promise waits for a user.

Review policies, membership, verified GitHub identity, connection/configuration
revisions and repository grants are rechecked before execution and publication.
The author and content hash of each authorizing comment are fetched again; editing
or deleting it prevents subsequent publication. External text cannot expand grants.
Installation removal/suspension and repository removal request cancellation.

Runner starts have stable attempt IDs. Each GitHub POST has a committed reservation.
Unknown review/progress outcomes are reconciled by App identity, an application-added
marker and, for reviews, the recorded commit. Missing evidence does not authorize
another POST. Unknown pushes remain visible for operator inspection and are never
replayed automatically. Edits retry only an already known comment ID.

Workspace retention/deletion removes inputs, results and configuration. Content-free
attempt IDs persist only until runner cancellation/erasure succeeds, including after
an outage. Operator App webhook secrets remain shared App configuration, like existing
GitHub App credentials. Receipts hold no raw webhook body and expire after 30 days.
Routine logs/audits contain IDs and fixed error codes, not secrets or PR contents.

Webhook payloads are limited to 2 MiB; other HTTP APIs keep their existing 64 KiB
limit. Tagged comment input is limited to 20,000 characters. Existing pilot storage
limits allow 200 retained tasks, 20 nonterminal tasks and 100 input revisions per
workspace/task. These are ingress/storage bounds; Review Bot adds no Codex execution,
repair, time or token quotas. OCR command output and the combined review plan are
bounded to 6 MiB; oversized preparation fails explicitly rather than dropping files
or truncating rules. Control characters and non-relative paths in OCR output are
unsupported and fail preparation.

## Verification

OCR integration on 2026-10-08: Biome, strict TypeScript, build and all **592**
deterministic tests passed with disposable PostgreSQL. App/job Docker builds,
migrations/API health and base/Docker-runner Compose validation passed. The pinned
OCR CLI ran offline in the built job image using exact local commits. The smoke
script covers file/rule coverage, exclusions, failed preparation and answer/fix
isolation; supervisor regression coverage rejects publication after preparation
failure. These checks do not establish live model inspection or semantic quality.


Repository display/editor follow-up on 2026-10-08: Biome, strict TypeScript,
build and all **581 deterministic tests** passed. All **10 Review Bot browser
scenarios** passed, covering desktop/mobile summaries, New/Edit dialogs,
discarded drafts, failed/pending saves, confirmed removal and polling conflicts.
Desktop/mobile screenshots were visually inspected.

Local verification on 2026-10-07: Biome, strict TypeScript and the build passed;
**569 deterministic tests** passed with disposable PostgreSQL and **97 browser
scenarios** passed. The complete suite used loopback proxy bypass and a 30-second
fixture timeout. Both app and Codex-job Docker images built; migrations and API
health passed in disposable containers. The pinned job's preparation phase passed
with fake Git, including its exact PR-ref/head check. The built Pi contract passed
on host Node 22 and Docker Node 24. `docker compose config --quiet` passed.

The local Git regression test confirms that a concurrent maintainer rewind rejects
publication even when the candidate commit would otherwise be a fast-forward.
Confirmed rejections restart the original fix; unknown effects retain their
reservation and require reconciliation.

Deterministic tests use fake GitHub/model/runner transports and disposable PostgreSQL.
They cover selected repositories, verified identities, write grants, duplicate events,
draft/fork behavior, stale heads, serialized jobs, failed checks, tag cancellation,
questions/answers, source edits, revocation, restart/unknown outcomes and deletion
cleanup retries. Browser checks cover the plugin configuration at desktop/mobile widths.
See [runnable journeys](../../examples/review-bot.md).

An offline command probe of the pinned Codex 0.155.1 image on this development
Docker host failed at bubblewrap namespace/devpts setup. This confirms fail-closed
behavior, not successful review execution. Verify sandbox compatibility on the
intended runner before the live pilot.

Live webhook delivery, semantic review quality and real same-PR Codex publication
remain explicit pilot acceptance. Local implementation does not deploy, connect an
account, modify a GitHub App, register a webhook or send a real GitHub/Telegram message.
