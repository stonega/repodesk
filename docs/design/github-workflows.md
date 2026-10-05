# GitHub work through Telegram

Status: **product direction**, updated 2026-09-27. This page describes the main
user journey. The capability table separates local implementation from proposed
work; [implementation evidence](../implementation/implementation-status.md) records
what was verified and which live gates remain.

## Product promise

RepoDesk lets an authorized person work with a selected GitHub repository from a
Telegram conversation. The person states an intent in ordinary language; the AI
helps find relevant repository context, explains it, or drafts a concrete action.
Application policy decides which repositories and tools are available. A person
reviews the exact proposed GitHub write before it runs.

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
| Delegate a feature or fix | A configured repository maintainer approves issue creation, Codex execution and a draft PR; task status and links return to Telegram. | Implemented locally; repository setup and live execution remain |
| Ask for PR/issue status or a PR digest | Read selected GitHub metadata and cite item URLs, with permissions and freshness visible. | Proposed; the current source-query tool is not a general PR/issue reader |
| Review, comment, merge or modify arbitrary repository content | Separate, narrowly scoped actions with distinct approvals and recovery rules. | Proposed; no general GitHub write tool is available |

See [GitHub App setup](../implementation/github-app.md),
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
  payload. A coding approval explicitly covers its issue, local execution and draft PR.
  There is no automatic merge. Unknown remote outcomes require inspection before
  a new request; automatic replay could duplicate work.
- Repository files, issue text and tool output are untrusted input. They cannot
  override application policy or supply credentials. Secrets stay out of Telegram
  previews, model context, ordinary logs and repository artifacts.
- Telegram exposes only delivered messages in authorized chats; RepoDesk does not
  gain arbitrary chat access or old history. Group context collection has its own
  consent and never grants GitHub access.

## Next product decisions

Evaluate the primary journey with a dedicated test repository and bot before a
pilot: connect a repository, ask a source question, review a proposed issue, and
complete one maintainer-approved coding task through a draft PR. Measure answer
usefulness and source accuracy, approval clarity, task completion and recovery from
unknown outcomes. Add read-only issue/PR metadata only after this journey is useful;
choose its exact questions and GitHub App permissions from pilot demand. Keep
recaps, schedules and general team assistance available, but prioritize work that
improves this repository journey.
