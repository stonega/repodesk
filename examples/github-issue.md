# File a GitHub issue through Telegram

Prerequisites: connect a GitHub App and select the target repository under Plugins.
Grant the App **Issues: Read and write** and approve the installation update on GitHub.
The workspace and bot must be active, and the requesting Telegram user authorized.

Send to the bot (replace the repository with a connected one):

```text
Create an issue in example/workspace titled "Recap omits the last message".
Body:
1. Post two messages in the linked group.
2. Ask for a recap.
Expected: both messages are covered.
Actual: the last message is omitted.
```

The bot shows the full draft with Approve/Reject buttons. Verify the repository and
content, then approve within 15 minutes. The bot returns the created issue's URL.
Reject and request a new draft to change the content. No issue is created by drafting.

For local verification without any GitHub, Telegram or model calls, point this command
at a disposable PostgreSQL instance (it creates and drops its own test database):

```sh
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres \
  bun test tests/integration/github-issues.test.ts
```
