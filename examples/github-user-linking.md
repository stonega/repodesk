# Telegram GitHub linking

Implemented locally; these are commands for an eligible member, not a live test.
The workspace operator must first connect a GitHub App installation and select
repositories. See [setup and permission boundaries](../docs/implementation/github-app.md#connect-a-verified-telegram-members-github-account).

```text
/workspace <workspace-id>
/github
```

Open the bot's authorization link, authorize your account on GitHub, then return
to Telegram and press **Connect account** after checking the displayed GitHub login.
Members & access will show your GitHub identity and selected-repository permissions.
GitHub rights do not grant a RepoDesk administrator role. Coding also needs the
operator's existing maintainer grant.

`/github connect` is an equivalent explicit form. `/github` appears in Telegram's
private command menu after the active worker publishes its shortcuts; groups show
`/repos`, Ask, Status, Cancel and Help instead. Registration is retried on failures
and does not block receiving messages or working on tasks.

```text
/github sync
/github disconnect
```

Sync refreshes repository permissions immediately; the worker also polls about
every five minutes. Disconnect removes the local credential and grants. If a
permission sync fails or the token expires, authorize again with `/github connect`.
Use these commands in the bot's private chat. Group messages cannot start linking.
