# Telegram task → GitHub fix → the same task and PR

This workflow uses the existing GitHub App, Review Bot and Codex runner. Local
tests use fake GitHub/runner transports and disposable PostgreSQL. Live model
quality, webhook delivery and Telegram presentation require a separately scoped
pilot; these instructions do not register a webhook or send a message themselves.

## Prerequisites

- An active workspace member has verified their own GitHub account with write
  access to the selected repository.
- Codex and Review Bot are enabled; Review Bot accepts requests and permits fixes.
- The operator has configured webhook delivery for issue and PR review comments.
- Use a task whose PR publication was confirmed by this version. Historical
  records without the installation/repository/PR/branch binding remain independent.

## Journey

1. In Telegram, request a bounded repository change, for example:
   “In example/app, fix pagination when the final page is empty and add checks.”
2. Wait for a confirmed ready-for-review PR. Keep its original task message.
3. On that PR, use the same verified GitHub account and the actual bot handle:
   `@repodesk[bot] fix the next-page button when that final page is empty.`
   A reply to an inline finding also supplies its parent as reference evidence.
4. Check that the original task receives one new input revision. Its task ID and
   PR number remain unchanged and no second Review Bot fix task is created.
5. Return to the original Telegram conversation. Status and View conversation
   show the same task's new work and result. Product questions are answered there.

Only directly addressed fix instructions use this continuation. Questions/reviews
remain read-only. Other collaborators, missing or ambiguous bindings and older PRs
keep independent Review Bot routing; they are not silently appended to private
Telegram work. A stopped task is not revived. Source edits/deletion, current
permission loss or disabled fix policy block further execution/publication.
Temporary source failures hold the same task and retry. Unknown publication is
inspected through existing recovery, never replayed. Inputs inherit the original
context's retention bound and are erased with the task's retained sources.

## Deterministic verification

Set `TEST_DATABASE_URL` to a disposable PostgreSQL service with CREATEDB and run:

```sh
NO_PROXY=localhost,127.0.0.1 bun test tests/integration/review-bot.test.ts tests/integration/development.test.ts tests/integration/miniapp.test.ts tests/integration/team-workflows.test.ts --timeout 15000
```

The production service/executor fixtures cover initial Telegram intake and
publication, signed GitHub ingress, duplicate delivery, executor reconstruction,
same-PR publication, original-audience delivery intents, Pi task snapshots and
Mini App history. They also cover source edits/deletion, foreign-PR comments,
revocation, transient source failures, inline context, fallback routing and erasure.
These checks do not establish live consent classification or external delivery.
