# GitHub work through Telegram

Status: **product direction with local implementation**, updated 2026-10-07. This page describes the main
user journey. The capability table separates local implementation from proposed
work; [implementation evidence](../implementation/implementation-status.md) records
what was verified and which live gates remain.

## Product promise

RepoDesk lets an authorized person work with a selected GitHub repository from a
Telegram conversation. The person states an intent in ordinary language; the AI
helps find relevant repository context, explains it, or drafts a concrete action.
Application policy decides which repositories and tools are available. In the
current implementation, a person reviews the exact proposed GitHub write or
coding-task scope before it runs. The accepted continuous-development direction
below introduces scoped task authorization from clear user instructions.

The first audience is a small engineering team or repository maintainer already
using Telegram. The useful result is a repository-grounded answer or a reviewable
GitHub artifact with a link back to the same chat or topic. Telegram is the
conversation surface, GitHub is the repository and action surface, and the AI is
the bridge between the user's intent and scoped application tools.

## Primary journey

1. An operator registers a GitHub App. A workspace operator connects an
   installation and selects the repositories the workspace may use. Repository
   access does not follow automatically from a Telegram message or GitHub URL.
2. The operator enables Code Truth and configures branches for source questions.
   Eligible members can propose issues; the operator separately grants selected
   repository maintainers access to coding tasks.
3. A member asks a question or requests a GitHub action in a private chat or an
   explicitly linked group. The bot binds the request to the workspace, actor,
   chat/topic and current repository configuration.
4. For a read, a scoped tool retrieves authorized repository context and the AI
   explains the result with source references and uncertainty where appropriate.
   For a write, the bot shows the exact repository and payload or coding-task scope.
5. The authorized requester approves or rejects the proposal. The worker rechecks
   actor, repository, connection and task policy immediately before the action.
   The result or an uncertain-outcome notice returns to the original chat/topic.

The AI may interpret intent and prepare drafts. It cannot connect a repository,
grant a member access, approve its own proposal, expand the GitHub App's permissions,
or turn text found in a repository into instructions with authority.

## Capability and status

| User outcome | Current scope | Status |
| --- | --- | --- |
| Ask how selected code works | Code Truth indexes configured branches and exposes source-query tools with commit provenance and workspace grants. It requires its optional service and plugin setup. | Implemented locally; live repository/model evaluation remains |
| File a GitHub issue | AI drafts repository, title and full body; the requester approves before the GitHub App creates it. | Implemented locally; live GitHub submission remains unverified |
| Delegate a feature or fix | A configured repository maintainer approves issue creation, Codex execution and a PR; task status and links return to Telegram. | Implemented locally; repository setup and live execution remain |
| Ask for PR/issue status or a PR digest | Read-only selected repository metadata with numbered items, reviewers, merge windows, dates, links and explicit paging coverage. Approved daily/weekly workflows pin repository sources and destination. | Implemented locally; live GitHub/model report evaluation remains |
| Save an assistant procedure as a team skill | Requester approves a sanitized draft from an owned completed run; admins publish and enable it through Skills. | Implemented locally; usefulness/reuse evaluation remains |
| Get a work handoff | Personal task/checkpoint/question/PR and discussion summary; group queries remain in the current topic. | Implemented locally; live usefulness evaluation remains |
| Automatically review selected PRs and finish tagged requests | Opt-in Review Bot policy, exact-commit informational reviews, verified maintainer mentions and checked same-PR fixes. | Implemented locally; live webhook/review/publication acceptance remains |
| Merge or close a selected repository PR | Owner/admin or configured coding maintainer proposes one action; requester approves its PR, target branch and merge method. Linked accounts also require current GitHub write access. Merges pin the reviewed head commit. | Implemented locally; live GitHub/Telegram acceptance remains |
| Modify arbitrary repository content | Separate, narrowly scoped actions with distinct approvals and recovery rules. | Proposed; no general GitHub write tool is available |

See [Review Bot](../implementation/review-bot.md), [GitHub App setup](../implementation/github-app.md),
[Code Truth](../implementation/code-truth.md),
[Codex tasks](../implementation/codex-coding.md) and the
[Telegram guide](../user/telegram-experience.md) for the implemented paths.

## Product boundaries

- Every read and write is scoped to an active workspace, eligible actor and
  selected repository. A private answer cannot be reposted into a group merely
  because the same user belongs to both.
- The GitHub App is installed and granted permissions in GitHub. RepoDesk can use
  only the selected installation repositories and the permissions available to
  each operation. Connection loss or a changed selection blocks new work.
- Answers should distinguish source facts, AI inference and missing coverage.
  Code Truth indexes configured branches and snapshots; its result does not prove
  current issue/PR state or that an answer is semantically correct.
- A GitHub write needs a reviewable, actor-bound approval for the exact target and
  payload. A coding approval explicitly covers its issue, local execution and PR.
  Merging requires a separate explicit PR-action approval. Unknown remote outcomes require inspection before
  a new request; automatic replay could duplicate work.
- Repository files, issue text and tool output are untrusted input. They cannot
  override application policy or supply credentials. Secrets stay out of Telegram
  previews, model context, ordinary logs and repository artifacts.
- Telegram exposes only delivered messages in authorized chats; RepoDesk does not
  gain arbitrary chat access or old history. Group context collection has its own
  consent and never grants GitHub access.

## Next product decisions

### Accepted coding direction, 2026-10-05

[Continuous Codex collaboration](codex-collaboration.md) was implemented locally
on 2026-10-05; live acceptance remains pending. Pi receives and relays original requirements;
Codex investigates code and owns technical decisions, implementation, clarification
and verification. A clear authenticated maintainer instruction can authorize a
bounded task under repository policy without a second approval click. The application
records and rechecks that grant; models cannot grant themselves authority.
Follow-ups and answers to Codex questions continue the same durable task and draft
PR. Human input is reserved for necessary product choices, ambiguous targets and
operations beyond the grant. Readiness and progress notices require no reply.

This authorization contract applies to opt-in continuous coding tasks. Exact-payload
approvals for standalone issues and reviewed coding proposals remain in force;
direct execution requires the configured repository policy and an actor-bound grant.
Merge, deployment and general GitHub writes are not included in the initial task grant.

### Pilot validation and later capabilities

Evaluate the primary journey with a dedicated test repository and bot before a
pilot: connect a repository, ask a source question, review a proposed issue, and
complete one maintainer-approved coding task through a PR. Measure answer
usefulness and source accuracy, approval clarity, task completion and recovery from
unknown outcomes. The [repository reports, skills and handoff plan](../implementation/team-workflows-plan.md)
was authorized for local implementation on 2026-10-07. Evaluate those paths using
[the runnable journeys](../../examples/team-workflows.md). Keep
recaps, schedules and general team assistance available, but prioritize work that
improves this repository journey.
