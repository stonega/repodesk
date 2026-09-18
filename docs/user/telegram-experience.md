# Proposed Telegram experience

**Design preview, not an available bot.** Commands, buttons and conversations below
are the intended user experience. The current code only exposes HTTP health/status.
The actual bot username has not been registered; `@DeepXAgentBot` is a placeholder.

## Start with one useful workflow

1. Open the bot privately and send `/start`.
2. Create or select a workspace, confirm your timezone and read its data scope.
3. Add the bot to a team group and have an authorized admin link that group.
4. Choose directed interaction; optionally request broader observation after its
   visibility requirements are explained.
5. Ask for a recap of available messages. Review it and correct its format.
6. Save the useful result as an approved recurring workflow.

The bot states what it can see and the oldest available context. It does not claim
to know conversations from before it received them. Setup left unfinished stays inactive.

## Command design

| Command | Intended behavior | Phase |
| --- | --- | --- |
| `/start` | Private onboarding, workspace selection or resume | P0 |
| `/help` | Current capabilities and usage examples | P0 |
| `/ask <task>` | Start a bounded task; group form can include `@botname` | P0 |
| `/workspace` | View/switch workspace in private chat | P0 |
| `/automations` | List, inspect, run, pause and edit workflows | P0 |
| `/status <run>` | Show task state and next action | P0 |
| `/cancel <run>` | Stop future steps and report any completed effects | P0 |
| `/memory` | List/edit/forget authorized instructions | P0 basic |
| `/usage` | Show workspace usage to authorized users | P0 |
| `/settings` | Admin access, timezone, retention and budgets | P0 basic |
| `/privacy` | Explain scope, retention and deletion request flow | P0 |
| `/connect` | Authorize or manage personal app connections | P1 |
| `/files` | List authorized artifacts and attached inputs | P1 |
| `/feedback <run>` | Submit an output correction or issue reference | P1 shortcut; replying works in P0 |

Natural language and reply buttons are the primary way to do work; commands provide
discoverability and deterministic fallback. A group cannot change workspace merely
because a member switches their private-chat selection.

## Example: approved weekly recap

**Member:** `/ask@DeepXAgentBot Summarize this week's decisions and blockers here.`

**Agent:** “I have messages received since Tuesday at 10:00. I'll use that window.”

**Agent:** “Here is the recap: decisions, unresolved blockers and next steps, with
links to the source messages.” Buttons: **Revise**, **Make recurring**, **Details**.

**Member:** “Make it weekly on Fridays at 4, and put blockers first.”

**Agent:** “Draft workflow: Team recap. Fridays 16:00, Asia/Taipei. Source: this
group. Destination: this topic. Format: blockers, decisions, next steps. Owner: you.
It will publish a recap here each week within the workspace budget.” Show next runs
and buttons: **Activate**, **Edit**, **Discard**.

**Member activates. Agent:** “Scheduled. You can pause it from `/automations`.”

If the timezone is not configured, the agent asks before displaying the final draft.
The schedule is inactive until approved. Repeated taps do not create multiple schedules.

## Example: a correction compounds

**Member, replying to a recap:** “Don't include done items in the blockers section.”

**Agent:** “I'll revise this output. Also save ‘exclude completed items from blockers’
for this workflow's future runs?” Buttons: **Save to workflow**, **This run only**.

**Member saves. Agent:** “Workflow updated to version 2. The next run will use it.”

A colleague can run that workflow and receive the improved format. Personal
preferences are not silently promoted to workspace instructions.

## Example: safe follow-up drafting (P1)

**Member:** “What follow-ups from yesterday are still open?”

**Agent:** “I found three explicit commitments in the messages I can access. Two
have no completion update; one is ambiguous.” Show owners, due dates and evidence.

**Member:** “Draft reminders for the two.”

**Agent:** Produces drafts for review. It does not DM recipients or send email merely
because the user requested a draft. External delivery is a later approved action.

## Example: monitoring suggestion (P1)

After an admin explicitly enables monitoring, the bot posts a configured weekly
digest privately to its owner: “Several discussions repeat a release-check task.
Create a Friday release checklist?” Buttons: **Review workflow**, **Not useful**,
**Stop suggestions**. A rejection is remembered; no workflow is activated by silence.

## Failure and permission messages

| Situation | Intended response |
| --- | --- |
| Insufficient history | State available date range and ask for a source or smaller scope. |
| Connector not authorized | Explain the missing source and show the owner's connection flow. |
| Wrong approver | Keep the operation pending and identify the required role without revealing private content. |
| Budget exhausted | Pause new model work, show usage and notify an authorized admin. |
| Schedule owner removed | Suspend dependent workflows and ask an admin to reassign/reapprove. |
| Bot removed or topic unavailable | Stop retries after classification; record delivery failure and notify via an already authorized channel if available. |
| User cancels | Confirm future steps stopped; separately list completed effects. |
| Workspace deleted | Revoke execution immediately; show purge status and explain Telegram originals remain. |

Do not expose stack traces, provider keys, internal database IDs or infrastructure
terminology in ordinary product responses. A short run reference is enough for support.

## Planned admin web panel

Authorized administrators can open the web panel to configure bot instructions,
language/timezone, model selection, limits, connected groups, schedules and team
permissions. The same settings apply in Telegram. The panel also shows run history,
costs, audit events and privacy controls. See [the panel specification](../design/admin-panel.md).
The panel is part of the first-release plan and is not implemented yet.

Admins can configure **Access → Allowed users** using Telegram user IDs. Whitelist-only
mode allows only listed active members to use the bot; members mode allows all active
workspace members. Adding someone does not grant admin rights. Removing an eligible
user blocks new work and suspends their schedules. This controls bot access, not who
can see replies already posted in a group.

## Planned first web visit and skill configuration

The first web visit opens a guided setup: claim the deployment, create the admin
account, configure the bot and model, verify the Telegram owner, set allowed users,
choose skills, then review and activate. Setup can be saved and resumed; the bot
stays inactive until its required settings are complete.

The **Skills** page lets an admin create/import instructions, edit settings, test a
draft, publish a version and enable it for the bot or a workflow. Skill permissions
remain limited to the tools and data that user is already allowed to access.
