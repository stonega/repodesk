# Telegram experience

Implemented local pilot interface. A working deployment requires the operator to
finish the web setup and activate a dedicated Telegram bot. No public bot is shipped.

RepoDesk's main use is asking about selected GitHub repositories and reviewing
GitHub actions from Telegram. The AI helps interpret the request; repository access,
tool grants and write approvals come from the application. See the
[GitHub journey and capability status](../design/github-workflows.md).

## Get started

The operator first creates the local admin, configures the bot, registers the
verification webhook and verifies the owner's Telegram identity. The owner confirms
timezone and budgets, chooses skills, then activates processing. Setup can resume
before those credentials exist.

Send `/start` privately. Use `/timezone Asia/Taipei` (substitute your zone) to confirm
workspace time. `/workspace <workspace UUID>` selects an enrolled workspace. People
without workspace eligibility receive access-help only; ask an admin to enroll your
numeric Telegram ID and add it to the whitelist.

For a group, get `/linktoken` privately, then copy the complete `/link TOKEN` command
shown as inline code in the reply and send it in the intended group
within ten minutes. Both workspace-admin and Telegram-admin authority are required.
One group may be linked per workspace. Anonymous admin identities cannot link it.

The default source scope is directed messages. For whole-group recaps, an admin must
verify bot visibility and explicitly enable `/capture on`. This includes received
messages from group participants outside the whitelist. All group participants can
see group replies. Telegram old history is unavailable.

## Private conversations

Use Telegram's native Topics to organize private conversations. Just send messages
inside a topic to continue it; no Reply is needed, including while the bot is still
thinking. Different topics have separate default context. Replying inside a topic
keeps that topic's conversation, even when quoting another topic. Every answer and
streamed preview stays in the topic where you asked.

Outside Topics, a standalone message starts a new conversation. Use Telegram Reply
on a retained answer or your own message to continue it. Replying to an older answer
continues the latest conversation; it does not rewind it. Unavailable reply anchors
start a new conversation with an explanation.

Ask about an earlier conversation when you want the assistant to search your retained
private history. It can search only your threads in the selected workspace; private
history is unavailable in group requests. `/workspace` changes the workspace used
for both topic context and searches. Switching back resumes that workspace's retained
topic conversation. `/help` and other control commands do not start LLM conversations.
Inside a Topic you can naturally change subjects and return to earlier discussions.
Short follow-ups refer to the recent discussion. Replies lead with the answer,
without unsolicited context explanations, extra suggestions or closing questions.
The assistant uses reasonable low-risk assumptions and asks only when essential
information is missing; required action approvals still apply. It can organize discussion summaries, decisions and todos in the
background and retrieve retained originals when needed. Long conversations are
compressed in batches; you stay in the same Topic. Summarization uses the same run
budget and may take extra time on the turn that triggers it. Memory remains subject
to retention and model accuracy.

See [examples](../../examples/private-threads.md).

## Commands

| Command | Implemented behavior |
| --- | --- |
| `/start`, `/help` | Workspace onboarding, limitations and commands |
| `/timezone <IANA zone>` | Admin timezone confirmation |
| `/workspace <UUID>` | Select an enrolled workspace privately |
| `/linktoken`, `/link TOKEN` | Expiring one-use group linking |
| `/capture on` / `/capture off` | Admin consent to received group-message collection |
| `/ask <request>` | Bounded Pi request; `/ask@botname` works in groups |
| `@botname <request>` | Ask via a mention in a linked group, when Telegram delivers it |
| `/recap` | Recap permitted messages with coverage and source references |
| Reply to the bot | Stay in the current Topic; outside Topics, continue the replied-to private thread; in groups, join that retained public discussion in the same chat/topic |
| `/correct once <text>` | Reply to a delivered run to correct one new output |
| `/correct save <text>` | Reply to a workflow output to propose a persistent correction |
| `/status` | Latest five visible runs for this chat |
| `/cancel <run UUID>` | Persist cancellation and block pending publication |
| `/automations` | List visible workflows; use `run`, `pause`, `resume` or `delete` plus UUID |
| `/remember <text>` | Propose personal memory privately or workspace memory in a group |
| `/memory`, `/memory edit <UUID> <text>`, `/memory forget <UUID>` | List, propose replacement, forget instructions |
| `/usage` | Recorded charges/reservations and workspace cap |
| `/settings` | Current timezone, retention, access mode and version |
| `/privacy` | Collection, retention and removal explanation |
| `/privacy delete` | Private admin request for confirmed workspace removal |

Unsupported non-text requests are silently ignored, including media with captions.
Commands addressed to other bots, bot-authored requests and unrelated group messages are ignored.
Message edits update context and do not launch another request.

For example, send `@agent_bub_bot hi` using your bot's actual username. Mentions
follow the same workspace access checks as `/ask`. Telegram privacy mode can prevent
plain mentions from reaching the bot; use `/ask@agent_bub_bot hi` or reply to a bot
message in that case. Receiving broader group traffic requires the bot to be an
administrator or have privacy mode disabled; retaining unrelated messages still
requires explicit `/capture on` consent.

After an explicitly addressed group request receives its answer, clear short
follow-ups such as “再详细点” or “换成英文” can continue without @ or Reply for up to
five minutes, provided Telegram delivers ordinary messages. Each member continues
their own discussion; another member speaking does not take it over. Replying to a
bot answer can join that shared discussion. A reply or mention directed at someone
else closes automatic attention; an explicit ask can resume it later. Unclear
addressees and unrelated messages receive no automatic reply. Plain follow-ups while
an answer is pending or after `/recap` require an explicit ask/reply instead.

Group conversations support internal summaries, decisions, todos and long-history
compression. They never bring in private chat history. Temporary follow-up candidates
are cleared when ignored or rejected; unrelated traffic is retained only with the
existing collection consent. See [group examples](../../examples/group-conversations.md).

Model replies render Markdown bold, italic, strikethrough, headings, links and code
using Telegram message entities. Lists remain readable text; unsupported markup and
raw HTML remain literal. System notices stay plain text. Formatting applies to new
replies; messages already delivered are not edited or resent.

## A recurring recap

Ask: “Propose a weekly recap every Friday at 17:00 Asia/Taipei, covering the previous
seven days in this group. Put blockers first.” The model can propose only supported
daily/weekly recurrence. Ambiguous times need clarification.

Review the proposal's owner, source/destination, topic, format, timezone, budget and
next three instants. The owner-bound Approve/Reject buttons expire after 15 minutes.
Another user cannot approve it, and repeat clicks do not activate it twice. You can
also create, inspect, edit and approve a versioned proposal in the web panel.

Reply to a scheduled output with `/correct save Use bullet lists and put blockers
first`. Review and approve the persistent instruction. Future runs use that correction;
already-running work retains its starting snapshot. `/correct once` creates only a
single corrected output.

Pause under Workflows or with `/automations pause <UUID>`. Owner revocation and skill
disablement suspend dependent work. Reapproval is required after suspension. Late
occurrences over five minutes skip without a burst of catch-up messages.

## Rich and streaming replies

Model answers use native rich messages: headings, lists and checkboxes, compact
tables, quotes, code blocks, bold/italic text and safe links. Group and scheduled
answers use the same formatting. If Telegram rejects rich delivery, the bot falls
back to a text reply. Media uploads and math rendering are not enabled.

Requests do not produce a separate “Queued” reply. In a private conversation,
Telegram's native “Thinking…” placeholder appears when execution starts, then the
reply appears progressively while the model writes. This also applies to one-off
corrections. Use `/status` to inspect requests still waiting for execution.
The preview is provisional: it may change between tool calls, and Telegram expires
it after 30 seconds without updates. The completed answer contains no automatic coverage or run-ID footer. Context handling stays silent unless asked about; a specific unknown is stated
briefly only when needed for an accurate answer. Diagnostic details stay in the panel. Short answers may finish before multiple preview updates are visible.
Groups and scheduled outputs receive only the final reply.

Press Telegram's native **Stop** button on the preview to cancel generation and
pending publication. `/cancel <run UUID>` remains available. Stop affects the run
that created that preview, even after you switch workspaces. Partial responses are
not automatically saved. Already sent messages or external requests in flight cannot
be retracted by Stop; uncertain provider charges remain reserved for reconciliation.

## Web panel

Use the verified local login to manage Settings, Members & access, Group access,
Workflows, Skills, Instructions, Runs, Usage, Audit and Privacy. Workflows and
skills use labeled forms, selection lists and tool checkboxes. Stale saves fail with a
reload/review instruction instead of overwriting another administrator's change.

A skill is instruction Markdown, a requested subset of existing tools and validated
settings. Publish an immutable version before enabling it. Runs/workflows pin versions;
editing or rollback does not rewrite historical executions. Disable takes effect at
subsequent policy boundaries. “Test draft policy” is a deterministic validation and
prompt preview; it makes no paid model request.

Run status and delivery status are separate. `delivery_unknown` means Telegram may
have accepted the send; inspect the destination before resolving it. Unknown provider
charges remain reserved until an authorized admin reconciles billing. A cancellation
cannot undo a message already sent.

Files, arbitrary browsing/shell, general app connectors and proactive monitoring
are not supported. The GitHub issue and coding paths below are the bounded external
writes. Source IDs establish an authorized citation set;
the operator must still evaluate the chosen model's factual accuracy before a pilot.

## Request access (implemented)

If you are not yet authorized, send the bot a message and tap **Request access**.
Your workspace admin can approve it from **Members & access → Access requests** in the admin
panel. Until approval, the bot does not run your requests. Once approved, you receive
a confirmation and can send `/help` or a new question. Approval grants regular member
access. Repeated taps do not create duplicate pending requests.

If the bot serves several workspaces and cannot identify yours, ask your admin for
the request-access link shown in their Members page. Open it, then tap **Request
access**. In a linked group, a command directed at the bot offers the same action.
A rejected request can be submitted again after 24 hours.
The link can be used during setup before bot activation; regular requests start
only after activation.

## Repository source questions (implemented; setup required)

The operator must configure and enable Code Truth for the selected repository and
branch. Ask a source question such as “Where does example/workspace handle Telegram
updates?” The answer should carry source references;
check its indexed commit/branch coverage before treating it as current. Code Truth
does not read live issue or PR metadata. See [Code Truth setup](../implementation/code-truth.md).

## GitHub issue submission (implemented)

With a GitHub App connected under Plugins, ask: “File an issue in example/workspace
about the recap missing the last message.” The assistant drafts the issue and shows
its repository, title and full body. Click **Approve** to publish, or **Reject** to
cancel. Only the requester can approve; the draft expires after 15 minutes. The bot
returns the issue link in the same chat/topic. The App installation needs Issues:
read and write; existing installations must approve that permission update on GitHub.

If the outcome is unknown, check GitHub before requesting another draft. The bot
will not automatically retry an uncertain submission.

## Model API costs (implemented)

In private chat, ask “How much have I spent on model API calls this month?” or
“Break down today's model costs by model.” Workspace owners/admins may also ask
for workspace totals and remaining monthly budget. Regular members see their own
usage only. Today/month boundaries use UTC; retained-history queries cover only
the accounting still held by the application, up to 90 days.

The response distinguishes settled USD costs from reserved and unknown amounts.
It is an application accounting snapshot, not a provider invoice, and excludes
the subsequent cost of generating the answer. An enabled published skill must
grant `query_model_cost`; new starter skills include it. See the
[examples and existing-workspace setup](../../examples/model-cost.md).

## Codex feature and bug tasks (implemented; repository setup required)

Configured repository maintainers can ask the bot to implement a feature or fix.
The bot proposes the exact issue and target branch; the requester approves once
to create the issue, start Codex and open a draft PR. Each task has its own status
and issue/workflow/PR links. Ask for status or to stop a task using its UUID.
Remote cancellation is best-effort. Ordinary membership or administrator status
does not grant coding access. See [Codex setup](../implementation/codex-coding.md).
