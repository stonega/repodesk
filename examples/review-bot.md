# Review Bot journeys

These are opt-in live acceptance journeys after local setup; deterministic tests
never make these GitHub or model calls. Follow [Review Bot setup](../docs/implementation/review-bot.md).
Use **New** in the Repositories heading to configure a target in its dialog;
use its **Edit** action to change saved policies. Cancel leaves the saved values
unchanged, and removal requires confirmation.

For a new GitHub App, start **Connect GitHub** in setup or **New** in Manage
GitHub. The suggested name is `repodesk`; choose another available name on GitHub
if needed. On a public HTTPS deployment, confirm that GitHub has an active webhook
at the operator-specific URL and subscriptions to Pull request, Issue comment and
Pull request review comment. After the callback, Review Bot should show its secret
as configured without copying it. Repository policy and verified maintainer setup
are still required. Existing Apps follow the manual webhook steps in the guide.

1. Enable automatic review for a dedicated test repository. Open a non-draft PR
   containing a concrete regression. Expect one informational review at that head
   with supported file/line findings. Check that the summary reports OCR exclusions,
   reviewed/skipped files and coverage. Redeliver its webhook: expect no duplicate.
2. Open a PR in an unselected repository and a draft in the selected repository.
   Expect no automatic review. Mark the selected draft ready: expect a review.
3. Push a new commit while review is running. Expect the old result to stop and the
   latest head to receive the review. Verify that every inline finding identifies
   a line in the reviewed diff.
4. From a verified maintainer, write `@YOUR-APP[bot] explain this finding` as an inline
   reply. Expect an answer in the PR with no commits.
5. With Direct execution and tagged fixes enabled, write `@YOUR-APP[bot] fix this`.
   Expect one edited progress comment, passing checks and a commit on the same PR.
   Expect no new issue/PR, force-push, merge or deployment.
6. Answer a necessary question with a new tagged comment from the requester. Expect
   the same task to resume and retain the original requirements and answer.
7. Tag the bot from an unverified account or a maintainer without push access. Expect
   no implementation. A selected fork PR can be reviewed but cannot receive fixes.
8. Cancel a running request from a tagged maintainer comment or the plugin page.
   Confirm stopped execution; an operation already publishing may finish. Disconnect
   repository access or edit the authorizing comment before publication: expect work
   to stop before a new write.
9. Inspect a simulated unknown publication in activity. Confirm that restart does
   not blindly resend a review, progress comment or push. Inspect the confirmed
   GitHub artifact and task evidence before requesting new work.

For a repeatable offline runner smoke check, build the `codex-job` target and run
its credential-free preparation with disposable Docker volumes:

```sh
docker build --target codex-job -t repodesk-ocr-job:test .
bun scripts/open-code-review-smoke.ts repodesk-ocr-job:test
```

This covers actual OCR JSON/rules, excluded files, failed preparation and answer/fix
isolation without network access. To inspect the CLI manually, run `ocr --version`
inside that image. A disposable Git repository with two local commits can
exercise the actual preparation commands without GitHub/model credentials:

```sh
ocr delegate preview --format json --from BASE_SHA --to HEAD_SHA
ocr delegate rule --format json -- src/example.ts
```

In a disposable custom image, remove or replace OCR with a failing fixture and
start a review. Expect `coding_review_preparation_failed`, no model execution and
no GitHub publication. Answer/fix tasks retain their existing Codex workflow.
