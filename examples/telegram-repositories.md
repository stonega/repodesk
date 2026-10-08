# Telegram repository picker

Implemented locally; live Telegram acceptance remains pending. Use a configured
workspace with an active member and workspace-selected GitHub repositories.

1. In a private bot Topic, mention a connected repository in a request, such as
   `Explain example/service`. Send `/repos`: that repository should precede
   repositories with newer saved GitHub activity. At most ten repository buttons
   appear, one per row; archived/disabled repositories are absent.
2. Click a repository. The bot confirms it for this conversation. Ask
   `Explain the architecture`: the assistant receives that repository as default
   context. Naming a different repository in the request takes precedence and
   still requires normal access. Selection alone creates no approval or coding task.
3. Send `/repos` again. The saved selection has a checkmark and **Selected** label.
   Use `/repos service` to search names, or **Clear selection** to remove the default.
4. Switch Topics or workspaces, or use another member. Selection must not carry
   into their context. In a linked group, private repositories must not appear.
5. Test an expired menu, an older menu after opening a new one, another person's
   button, and a repository whose access was removed. Selection must be rejected;
   stale-menu errors tell you to send `/repos` for current choices.
6. On Telegram desktop and mobile, inspect the ten-row menu, long repository
   names, selected and cleared states, search misses, no repositories, and errors.
   Telegram owns the native keyboard layout; deterministic tests verify payloads,
   routing and authorization, not the client's visual rendering.

Automated local checks:

```sh
bun test tests/unit/telegram-repositories.test.ts tests/unit/github-repository-metadata.test.ts
# Use an isolated disposable PostgreSQL database, never the application database.
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
  bun test tests/integration/telegram-repositories.test.ts tests/integration/github-repository-sync.test.ts
```

The stored activity fields come from GitHub's
[installation repository response](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).
Callbacks use short numeric references within Telegram's
[inline keyboard limits](https://core.telegram.org/bots/api#inlinekeyboardbutton),
with server-side actor, bot, tenant, destination and delivery checks.
