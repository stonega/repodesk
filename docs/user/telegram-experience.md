# Telegram experience

Implemented local pilot interface. A working deployment requires the operator to
finish the web setup and activate a dedicated Telegram bot. No public bot is shipped.

## Get started

The operator first creates the local admin, configures the bot, registers the
verification webhook and verifies the owner's Telegram identity. The owner confirms
timezone and budgets, chooses skills, then activates processing. Setup can resume
before those credentials exist.

Send `/start` privately. Use `/timezone Asia/Taipei` (substitute your zone) to confirm
workspace time. `/workspace <workspace UUID>` selects an enrolled workspace. People
without workspace eligibility receive access-help only; ask an admin to enroll your
numeric Telegram ID and add it to the whitelist.

For a group, get `/linktoken` privately, then send `/link TOKEN` in the intended group
within ten minutes. Both workspace-admin and Telegram-admin authority are required.
One group may be linked per workspace. Anonymous admin identities cannot link it.

The default source scope is directed messages. For whole-group recaps, an admin must
verify bot visibility and explicitly enable `/capture on`. This includes received
messages from group participants outside the whitelist. All group participants can
see group replies. Telegram old history is unavailable.

## Commands

| Command | Implemented behavior |
| --- | --- |
| `/start`, `/help` | Workspace onboarding, limitations and commands |
| `/timezone <IANA zone>` | Admin timezone confirmation |
| `/workspace <UUID>` | Select an enrolled workspace privately |
| `/linktoken`, `/link TOKEN` | Expiring one-use group linking |
| `/capture on` / `/capture off` | Admin consent to received group-message collection |
| `/ask <request>` | Bounded Pi request; `/ask@botname` works in groups |
| `/recap` | Recap permitted messages with coverage and source references |
| Reply to the bot | Ask a follow-up or correction in the same chat/topic |
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

Unsupported media receives text-only guidance on directed requests. Commands addressed
to other bots, bot-authored requests and unrelated group messages are ignored.
Message edits update context and do not launch another request.

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

## Web panel

Use the verified local login to manage Settings, Allowed users, Members, Group access,
Workflows, Skills, Instructions, Runs, Usage, Audit and Privacy. Advanced workflows
and skill definitions use schema-validated JSON editors. Stale saves fail with a
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

Files, arbitrary browsing/shell, external app connectors, proactive monitoring and
external writes are not supported. Source IDs establish an authorized citation set;
the operator must still evaluate the chosen model's factual accuracy before a pilot.
