# Telegram Mini App: Codex task history

Status: implemented locally, 2026-10-18. The page is read-only. Live Telegram
client acceptance and BotFather configuration remain rollout steps; no bot settings,
webhooks or deployment were changed by this implementation.

## Open a task

Codex task notices, progress messages, results and status replies include **View
conversation**. The link opens the bot's Main Mini App with an opaque workspace/task
reference in `startapp`. The same direct-link launch works from private chats and
groups; it avoids the private-chat restriction on `web_app` inline buttons.
Forwarding the link grants no access to its contents.

The application serves the page at `/mini` and its authenticated read API at
`POST /mini-api/history`. It shares the existing deployment and database. It does
not use the admin login or expose admin endpoints to Telegram users.

To enable the entry point on a deployed bot:

1. Serve the existing RepoDesk site over HTTPS.
2. In BotFather, configure the bot's **Main Mini App** URL as
   `https://YOUR_REPODESK_DOMAIN/mini` and enable it.
3. Open **View conversation** from a task message in private Telegram and in a
   linked group. Verify the task, permissions and native client presentation.

These are operator configuration steps. An ordinary browser visit without a
Telegram launch explains how to open the task. `/mini` without a task reference
is not a general conversation directory.

## Recorded content and recovery

The viewer combines retained original requirements, Chat Agent task questions,
Codex answers, reported progress and completed native Codex assistant messages.
It distinguishes message authors, shows timestamps and current task state, and
keeps tool activity collapsed until expanded. Structured task-result envelopes
show their exact supplied summary and question; internal protocol fields are not
presented as conversational prose. Closing the page does not stop the task.

The app-server adapter allowlists completed `agentMessage`, `commandExecution`,
`fileChange` and `mcpToolCall` items. Reasoning, system prompts, raw protocol frames,
MCP arguments/results and arbitrary application logs are excluded. File activity
lists affected paths. Commands include bounded completed output. Known task
credentials and recognizable credential fields are redacted before storage;
each displayed native item is limited to 12,000 characters and labels truncation.
This is completed-message refresh, not token-by-token streaming. Interrupted
partial output is not reconstructed. Old tasks without capture show their
available retained exchanges with an explicit coverage note.

The existing private attempt channel sends native entries to the supervisor.
A private task file preserves entries during a channel outage; the supervisor
recovers it before implementation cleanup. Its private transcript log survives
supervisor restart. The worker drains pages of up to 64 entries into tenant/task
scoped `coding_task_events`, committing the cursor with each page. Stable native
item identities deduplicate retries and recovery. No SQL migration or dependency
addition is required. Task/source erasure removes database events and private
runner files through the existing lifecycle.

The page initially loads the most recent 50 items and can load earlier pages.
While active it refreshes every four seconds, catches up from its last cursor on
return or reconnect, and avoids overlapping requests. Incremental cursors follow
database arrival order separately
from displayed message time, so delayed runner records and later answers to old
questions are still delivered. Older-history loading keeps
the reading anchor; new messages scroll into view only while following the end.
Otherwise **New messages** takes the reader to the latest entry. Code blocks can
be copied and scrolled horizontally. Markdown is rendered through React nodes;
HTML stays literal, images are not fetched, and links allow HTTP(S) only.

## Identity and visibility

Every API read validates Telegram `initData` using the current bot token, rejects
duplicate fields and stale/future launches, and checks current workspace/task
permissions and bot identity. Launch authentication expires after 24 hours; reopen
the task in Telegram to refresh it. Launch references contain no credentials.

Private-task history stays with its original actor, including when another
workspace administrator has the link. Group-task viewers also need confirmed
current membership of the original linked group. Topic-bound retained source
checks prevent a source from another audience from making history readable.
Expired/deleted input or context sources hide the history before cleanup runs.
The bot must be able to verify group membership; a failed check grants no access.

Reads disable caching. The browser keeps launch credentials and messages in
memory, uses no admin cookies and clears visible history after an access/session
failure. Only `/mini` permits the official Telegram SDK and Telegram Web embedding;
the admin page's frame restrictions remain intact.

## Design and verification

Follow [the Mini App UI preference](../design/ui-rules.md#telegram-mini-apps-follow-official-guidance).
The page follows live theme colors, stable viewport height and device/content safe
areas. Its root hides the native Back/Main buttons because there is no child
navigation or write action, while Telegram retains its native close/minimize UI.
Unsupported optional capabilities fall back to a normal responsive page.

Deterministic coverage includes signed-launch validation, private/group boundaries,
source expiry, pagination/catch-up, native event capture, cursor deduplication,
recovery files and scoped embedding headers. Browser fixtures cover mobile/desktop,
live dark-theme changes, safe areas, code rendering, scroll anchoring, reconnect,
empty/error states and clearing content after revocation. Real iOS/Android/Desktop
Telegram and live group membership behavior still require acceptance on the
configured deployment.

Official sources checked 2026-10-18:
[Telegram Mini Apps](https://core.telegram.org/bots/webapps),
[inline-button restrictions](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[Codex App Server](https://learn.chatgpt.com/docs/app-server).
