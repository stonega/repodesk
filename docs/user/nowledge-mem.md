# Nowledge Mem

Connect your existing Nowledge Mem knowledge to a private Telegram conversation.
The built-in plugin can browse, search and read memories, and save exact text when
you explicitly request it. It is disabled until configured and enabled.

## Connect

1. [Install and start Nowledge Mem](https://mem.nowledge.co/docs/installation),
   install its required models, and save a first memory in its Timeline.
2. If Mem runs on a different computer, configure
   [Access Anywhere](https://mem.nowledge.co/docs/remote-access). Keep Mem running.
3. As the deployment operator, open **Plugins → Nowledge Mem** and choose **Edit**.
4. Enter the server base URL and API key, then choose the Telegram member whose
   private knowledge this connection represents. Use a reachable HTTPS URL,
   without `/app` or `/mcp`. Loopback HTTP also works for a server reachable from
   the same process environment; Docker's localhost is inside the container.
5. Choose **Find Spaces**, select the intended Space, then **Save**. If there is
   only one Space, it is selected automatically.
6. Enable the plugin using the switch beside its title.

One workspace connection serves one selected member. Other members, group chats
and scheduled workflows cannot use it. The saved key is encrypted and never shown
again. Enter it again when changing the server or member. Disabling retains the
connection; Edit also offers removal of the saved key.

## Use in Telegram

In the selected member's private chat, try:

- “Search Nowledge Mem for our database decision.”
- “Show my saved memories in Nowledge Mem.”
- “Read that memory in full.”
- “Save to Nowledge Mem: Our application uses PostgreSQL.”
- “保存到 Nowledge Mem：我們的應用程式使用 PostgreSQL。”

Saving requires the explicit `Save to Nowledge Mem: ...` format or its supported
Chinese equivalent. Only the exact text after the colon is saved. Chat transcripts
are not automatically exported. Updates, deletion and automatic session capture
are not provided; manage those in Mem itself. Search excerpts and full reads are
bounded, so ask for the exact memory when a search result is truncated.

If a save's outcome is uncertain, inspect Mem before sending a new save request.
RepoDesk does not automatically resend it. A confirmed save stays in Mem even if
the bot's later answer fails. Disconnecting RepoDesk does not delete saved Mem
records. Mem's own retention/deletion controls remain separate from RepoDesk's
[conversation memory and privacy](memory-and-privacy.md).

If recall fails, check that Mem is running, the server is reachable from RepoDesk,
the API key is current, the selected member is active, and the correct Space is
configured. Missing Mem access does not prevent ordinary chat. Historical memories
may be outdated and never grant permission for other actions.
