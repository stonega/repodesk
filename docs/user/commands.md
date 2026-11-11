# Chat requests

RepoDesk uses ordinary conversation. The bot does not publish a slash-command menu,
and you do not need to memorize commands. Use your own wording and language; these
are examples. In groups, mention the bot or reply to it.

| Goal | Example request |
| --- | --- |
| Help | “What can you do?” |
| Choose or search repositories | “Help me choose a repository” or “Find example/app” |
| Switch workspace | “Show my workspaces” or “Switch to the Design team” |
| Connect GitHub | “Connect my GitHub account” in private |
| Refresh GitHub access | “Refresh my GitHub permissions” in private |
| Disconnect GitHub | “Disconnect my GitHub account” in private |
| Connect/reconnect Google | “Connect my Google account” or “Reconnect Google” in private |
| Google account status | “Which Google account is connected?” in private |
| Search Console selection | “Choose my Search Console properties” in private |
| Disconnect Google | “Disconnect my Google account” in private |
| Check or stop work | “How is that task going?” or “Stop the previous task” |
| Summarize | “Summarize this Topic's decisions and blockers” |
| List/manage schedules | “Show my schedules”, “Pause the daily recap” or “Run it now” |
| Create a schedule | “Every day at 09:00 Asia/Taipei, send me a PR report for example/app” |
| Correct an answer | Reply: “For this answer, put blockers first” |
| Save a workflow correction | Reply to its report: “For future reports, put blockers first” |
| Save an instruction | “Always put blockers first in my weekly reports” |
| Inspect/edit/forget instructions | “Show my saved instructions” or “Forget the weekly-report instruction” |
| Recall controls | “What do you remember about this?” or “Disable memory here” |
| Usage/settings | “Show recorded usage” or “What is our timezone?” |
| Change timezone | “Change the workspace timezone to Asia/Taipei” (administrator) |
| Link a group | “Help me link a Telegram group” in private (administrator) |
| Group collection | “Disable message collection in this group” (administrator) |
| Privacy | “Explain our retention policy” |
| Workspace deletion | “Delete this workspace” in private (administrator; confirmation required) |

When multiple tasks, instructions or schedules match, identify the intended item
by its name, reply to its message or use the choices the bot provides. Workspace
selection is limited to your active memberships. With no workspace selected, the
bot offers workspace buttons so you can get started without a command.

Repository choices, account sign-in, **Connect account**, **Approve / Reject** and
native **Stop** remain available. Browser sign-in alone does not connect an account.
Normal chat does not grant extra permissions or authorize unrelated writes.
Explicit schedule requests activate immediately; instruction and external-write
proposals keep their existing confirmations. See [Telegram usage](telegram-experience.md),
[GitHub](github.md), [Google](google-workspace.md) and [workflows](workflows.md).

Older typed shortcuts remain accepted for compatibility. Telegram's Start and
invitation links may carry platform command payloads automatically.
