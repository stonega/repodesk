# Telegram usage

Tell the bot what you want in ordinary language. There is no slash-command menu,
and commands are not required. In linked groups, mention the bot or reply to it.
Administrators configure deployment and shared services; members join the workspace.

## Get started

1. Open your administrator's invite link and choose **Start**, or **Request access**.
2. Ask “What can you do?” or send your first request.
3. If you belong to several workspaces, choose a workspace when prompted. Later,
   ask “Show my workspaces” or “Switch to the Design team”.
4. Ask “Help me choose a repository”, or name `owner/repository` in your request.

Account actions stay in private chat. Ask “Connect my GitHub account” or “Connect
my Google account”, complete browser sign-in and return to confirm the account.
See [GitHub](github.md) and [Google](google-workspace.md).

## Conversations and Topics

Use native Telegram Topics to organize separate discussions. Send messages directly
within the Topic to continue; replies and controls stay in their originating Topic.
Outside Topics, a standalone message starts a new conversation after the answer
finishes. Use **Reply** on a retained user message or bot answer to continue it.

While the bot is answering, send additional details directly. They join the active
response at the next generation boundary. Supported files, recordings and private
forwarded references can also supply input. An external operation may finish before
a correction is read. Native **Stop** remains available.

Ordinary answers do not quote your message unless a specific reference helps.
You can ask about earlier retained private discussions; group requests cannot read
private history. Long conversations may use summaries; ask for original discussions
when you need exact wording.

## Repositories and requests

Ask to choose a repository. The picker shows recent choices first; give a repository
name to search further, or choose **Clear selection**. Selection applies only to
you in the current workspace, bot, chat and Topic. Naming a repository explicitly
in a request takes precedence. Selection does not approve writes or change existing
tasks. Groups show public repository choices; private repository queries use private chat.

| Goal | Example |
| --- | --- |
| Repository progress | “List example/app's open PRs with owners and links” |
| Compare PRs | “Compare the implementation and review of PR #12 and #15” |
| Find code | “Where does example/app validate login?” (Code Truth required) |
| Create an issue | “Create a login-timeout issue in example/app; reproduction steps are…” |
| Implement a change | “Fix the login error message in example/app and verify it” (Codex required) |
| Task handoff | “Where did we leave off, and what needs my review?” |
| Scheduled report | “Every day at 09:00 Asia/Taipei, send me example/app's PR report” |

## Web pages and attachments

Send a public URL with a request, such as “Read https://example.com and summarize
its main points with sources”. The built-in reader needs no search configuration
and supports public HTML pages. It cannot log in, execute JavaScript or read private
networks; use the separately configured Browser capability for supported browsing work.

Send photos, image files, UTF-8 text/code files or selectable-text PDFs with your
request. Recordings require enabled transcription; see [audio](audio.md).
In groups, mention the bot in the caption or reply to it. Do not send credentials.

The bot may occasionally react to the current message with a native emoji while
also answering normally. Ask it to skip reactions if you prefer. A reaction does
not approve an action or indicate completion. For charts, comparisons and local
calculators, see [interactive widgets](widgets.md).

## Progress and stopping

Private execution can show native **Thinking…** previews; groups and schedules
receive final output. Ask “How is that task going?” or “Stop the previous task”.
When several tasks match, choose the intended task. You can also use native **Stop**
or the task message's **Cancel** button. “Stopping…” means cancellation is recorded
and completion is still being checked. Delivered messages and external writes may
not be reversible; check the target service when an outcome is uncertain.

## Confirmations

Account sign-in requires **Connect account** in Telegram. Issue/PR writes and
persistent instructions retain their proposal approvals. Review the target and
content before choosing **Approve** or **Reject**. A clear authorized Codex request
uses its existing task authorization policy. Explicit daily/weekly schedule requests
with a time and timezone activate immediately; see [workflows](workflows.md).

See [chat request examples](commands.md), [groups and Topics](groups.md),
[memory and privacy](memory-and-privacy.md) and [Codex tasks](codex.md).
