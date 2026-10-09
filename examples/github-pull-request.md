# Merge or close a GitHub PR through Telegram

Connect a GitHub App and select the repository in Plugins → GitHub. The App needs
Contents and Pull requests **Read and write**; existing installations must accept
the updated permissions in GitHub. Use an active workspace owner/admin or a
repository maintainer in enabled Codex settings. Linked accounts need current
GitHub write/admin access. Use the bot's private chat for private repositories.
The updated app/worker automatically expose the GitHub tools and bundled skill to
connected workspaces, including existing ones. Deploy the updated build through the
release process; changing App permissions alone does not add tools to an older worker.

Send one request:

```text
Merge example/workspace PR #233 using squash.
```

Review the bot's confirmation: PR title/link, target branch, merge method and head
commit. Choose Approve within 15 minutes, or Reject to request a different action.
The bot reports the confirmed PR link or a specific recovery step. GitHub can reject
the merge because of conflicts, checks, reviews, rules or a disabled merge method.
Draft, closed or changed PRs cannot execute the old approval. Coding task approvals
do not grant merge authority.

For a close without merging or deleting its branch:

```text
Close example/workspace PR #215.
```

Each PR has a separate confirmation; bulk merge/close and merge queues are not
supported by this tool. If an outcome is unknown, inspect GitHub before submitting
a new request. The application never automatically retries that mutation.

Credential-free deterministic verification with a disposable PostgreSQL instance:

```sh
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres \
  bun test tests/integration/github-pull-requests.test.ts
```

Manual staging acceptance: use a dedicated test repository and bot, verify one
merge and one close, test Reject, try a missing installation grant, update the PR
head after a proposal, and verify a wrong actor cannot approve. Review native
Telegram desktop/mobile messages and controls. These live checks remain pending.
