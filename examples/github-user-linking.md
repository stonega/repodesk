# Telegram GitHub linking

Implemented locally; these are chat requests for an eligible member, not a live test.
The workspace operator must first connect a GitHub App installation and select
repositories. See [setup and permission boundaries](../docs/implementation/github-app.md#connect-a-verified-telegram-members-github-account).

```text
Switch to the intended workspace
Connect my GitHub account
```

Open the bot's authorization link, authorize your account on GitHub, then return
to Telegram and press **Connect account** after checking the displayed GitHub login.
Groups & Members will show your GitHub identity and selected-repository permissions.
GitHub rights do not grant a RepoDesk administrator role. Coding also requires verified GitHub write access.

The assistant starts the account flow from normal chat. No command menu is
published. Sign-in and Telegram account confirmation are still required.

```text
Refresh my GitHub permissions
Disconnect my GitHub account
```

Sync refreshes repository permissions immediately; the worker also polls about
every five minutes. Disconnect removes the local credential and grants. If a
permission sync fails or the token expires, authorize again by asking “Reconnect my GitHub account”.
Send these requests in the bot's private chat. Group messages cannot start linking.
