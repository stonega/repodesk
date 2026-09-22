# UI design rules

This document records reusable UI preferences expressed by the user. Read it before
designing or modifying UI, and apply the rules relevant to the current task.
These preferences guide design; they do not claim that the UI already implements
them.

## Maintenance

- When UI feedback expresses a reusable preference, record it during the same task.
  One clear request is sufficient within its stated scope.
- Capture the underlying principle, the source feedback and date, its intended
  scope, and any known exceptions. Avoid generalizing beyond the available feedback.
- Apply recorded preferences to comparable flows in subsequent UI work.
- Follow newer explicit user instructions when they conflict with a recorded rule.
  Revise the rule if the preference changes; record an exception for a local change.
- Keep illustrative examples separate from established preferences.

## Recorded preferences

### Skill cards separate routine actions from version recovery

- **Preference:** Give skill cards a clear title/status header with management icons,
  separate purpose from version metadata, and group Publish and Test below the
  preview. Keep rollback controls in an expandable section with a labeled version
  selector, so recovery actions do not compete with everyday actions.
- **Scope:** Skill catalog cards; keep the layout readable when controls wrap on mobile.
- **Source:** 2026-09-21 — user requested reorganizing the skill card, illustrated
  with the existing crowded action and rollback rows. The grouping above is the
  implementation interpretation of that request.
- **Exceptions:** None recorded.

### Group cards show names alongside IDs

- **Preference:** Use the Telegram group name as the card heading and show its
  numeric ID as secondary information.
- **Scope:** Group access cards; IDs remain the binding and permission identity.
- **Source:** 2026-09-21 — user requested group names on the group cards.
- **Exceptions:** Groups with no known title use their ID as the heading.

### Members and access share one page

- **Preference:** Combine member management, access requests and whitelist policy
  in one page. Show Telegram names/usernames alongside numeric IDs, with role,
  membership, whitelist and effective-access states in a searchable table.
- **Scope:** Workspace member and access management. Keep numeric IDs as the
  permission identity; display names come from Telegram interactions.
- **Source:** 2026-09-21 — user requested merging Allowed users and Members and
  adding Telegram usernames to members currently shown only as IDs.
- **Exceptions:** Members with no known Telegram profile retain an ID fallback.

### Workspace settings version is a title badge

- **Preference:** Show the effective settings version as a compact badge immediately
  after the page title.
- **Scope:** Workspace settings; the badge follows the saved server version.
- **Source:** 2026-09-21 — user requested moving the version beside the title as a badge.
- **Exceptions:** None recorded.

### Refresh icons rotate during loading

- **Preference:** Rotate refresh icons for the full duration of their data request,
  stop on success or failure, and disable repeated clicks while loading. Combined
  refresh controls remain busy until all their requests finish.
- **Scope:** Busy feedback for icon actions that remain in the admin app. This is
  a presentation rule, not a reason to add refresh controls.
- **Source:** 2026-09-21 — user requested rotating refresh icons while loading.
- **Exceptions:** Respect reduced-motion preferences by retaining static busy
  feedback instead of continuous rotation.

### Modal Cancel follows the primary action

- **Preference:** Place Cancel immediately after the main action in the same action
  row. Let the row wrap in that order on narrow screens; remove the separate
  cancel-only footer. Preserve keyboard order and pending-save dismissal locks.
- **Scope:** All admin modals, including nested dialogs and create/edit forms.
- **Source:** 2026-09-21 — user requested moving Cancel after the main button in
  every modal, illustrated with the Pi extension registration dialog.
- **Exceptions:** None recorded.

### Icon buttons are borderless

- **Preference:** Render icon-only buttons without borders, including destructive,
  sidebar, modal and pagination actions. Retain hover backgrounds, visible keyboard
  focus outlines, accessible names, 44px hit targets and disabled/busy feedback.
- **Scope:** All icon buttons in the admin web app.
- **Source:** 2026-09-21 — user requested borderless icon buttons throughout the app.
- **Exceptions:** None recorded. Text buttons retain their existing styling.

### Application screens use readable details and forms

- **Preference:** Present application data with readable labels, statuses, dates,
  amounts and lists. Use labeled form controls for edits; never require users to
  read or edit raw JSON to operate the app. Preserve reviewable approval details.
- **Scope:** All admin pages, including setup, approvals, skills, schedules, runs,
  recovery, access previews, operator tools and privacy.
- **Source:** 2026-09-21 — user first requested removing the Privacy JSON block,
  then explicitly requested auditing and fixing all remaining JSON interfaces.
- **Exceptions:** Copyable shell/Telegram commands and user-authored Markdown or
  code remain literal content. Internal API serialization is not a UI display.

### Group-link commands are copyable code

- **Preference:** Format the complete `/link TOKEN` command as one inline code span
  so it can be copied together without the surrounding instructions.
- **Scope:** Telegram group-linking instructions returned by `/linktoken`.
- **Source:** 2026-09-20 — user requested code formatting for the generated link command.
- **Exceptions:** None recorded.

### Usage records use a paginated table

- **Preference:** Present usage records as a readable data table with pagination,
  formatted dates and currency, clear statuses and record counts. Keep the spend
  and budget summary above it; contain horizontal scrolling within the table on
  small screens.
- **Scope:** Usage & budget in the admin panel.
- **Source:** 2026-09-20 — user requested a paginated data table instead of the
  page's raw JSON output.
- **Exceptions:** None recorded.

### Add and create flows use modals

- **Preference:** Open a modal from an explicit Add/Create action instead of
  displaying the creation form directly on the page. Keep lists and summaries
  on the page, and use the same modal editor for related edit actions. Provide
  a named dialog, trapped keyboard focus, Escape and visible cancel controls,
  focus return, mobile scrolling, and validation/errors inside the dialog.
  Cancel discards the draft; failed saves keep it open; pending saves block
  dismissal and duplicate submission.
- **Scope:** Add/create management flows across the admin app: workspaces,
  members, workflows, skills/imports, instructions, runs, panel accounts,
  plugins, repositories/networks and GitHub Apps. Related repository, plugin,
  member, workflow, skill and instruction editors also use these dialogs.
- **Source:** 2026-09-20 — user requested preferring modals for Add actions
  across the app instead of inline forms.
- **Exceptions:** Sign-in/bootstrap, existing settings and policy forms,
  approval decisions and recovery controls stay on their pages. Field editing
  within a modal may remain inline. Applying repository/network changes edits
  a draft; the existing Save Code Truth step persists it. GitHub confirmation
  still takes place on GitHub.

### Do not add routine refresh buttons

- **Preference:** Omit refresh icons from page headings, section toolbars and the
  sidebar. Load data when entering a page and update it after successful actions.
  Show explicit text recovery actions only after failed loads or conflicting edits;
  preserve drafts until the user chooses to reload.
- **Scope:** The entire admin app, including overview, settings, members, approvals,
  workflows, runs, usage, audit, setup, operations and plugin configuration.
- **Source:** 2026-09-21 — user first requested removing the overview refresh icon,
  then clarified that the app contains too many useless refresh buttons. This
  supersedes earlier rules about placing routine refresh buttons in headings.
- **Exceptions:** Logs offer manual refresh when automatic updates are off or have
  failed. Active coding tasks offer a labeled Check progress action. Rechecking
  Telegram bot visibility is a specific operation and uses a text label. Setup
  verification status updates automatically in both Telegram transport modes.

### Guided GitHub App creation

- **Preference:** Offer an in-panel creation entry that preconfigures the GitHub App
  and receives its credentials automatically after the user confirms on GitHub.
  Keep organization/personal ownership explicit and explain the next installation step.
- **Scope:** GitHub App onboarding in the workspace Plugins panel.
- **Source:** 2026-09-20 — user requested a button to create a GitHub App directly,
  referencing Coolify's guided setup.
- **Exceptions:** Existing Apps can still use manual environment/file configuration.

### Common action buttons use Reicon

- **Preference:** Use [Reicon](https://reicon.dev/) outline icons for familiar,
  contextually clear operations such as add, remove, refresh, edit, search,
  pagination and row-level pause/resume. Use the shared `IconButton` component;
  provide an explicit accessible name and hover title, visible keyboard focus,
  a 44px hit target, and stable loading/disabled states. Preserve existing
  confirmations and action semantics. Use descriptive object names for repeated
  controls where needed to distinguish their targets.
- **Scope:** The admin web panel, including setup, workspace pages, plugins,
  repository/network configuration, logs and account controls. Use
  `reicon-react` with named imports so unused icons are excluded from builds.
- **Source:** 2026-09-20 — user requested a project-wide review and replacement
  of suitable buttons with Reicon icons, citing add, delete and refresh.
- **Exceptions:** Keep visible text for primary form submission, sign-in,
  authorization, approval, publication, deployment-wide controls, destructive
  workspace confirmation and other actions whose consequences need explanation.
  Telegram controls are outside the web icon-library scope.

Use this format for each preference:

- **Preference:** The reusable design principle.
- **Scope:** The screens or interactions where it applies.
- **Source:** Date and a brief summary of the user's feedback.
- **Exceptions:** Known exceptions, or "None recorded."

### Settings explain limits and validation

- **Preference:** Show readable field labels, units, applicable ranges and adjacent
  validation errors. Model capacity comes from catalog metadata or an explicit
  operator configuration; cost budgets are independently configurable. Do not hide
  arbitrary pilot caps behind a generic `invalid_request`.
- **Scope:** Workspace execution limits and model configuration in the admin panel.
- **Source:** 2026-09-20 — user approved replacing unexplained fixed ranges with
  model-aware validation and clear field feedback.
- **Exceptions:** Operational retention and scheduling policies may keep documented
  fixed limits; identify them as application policies, not model capabilities.

### Let the model manage response language and capacity

- **Preference:** Do not show workspace Reply language, Input byte budget or Output
  token budget controls. Preserve the model's response language and manage input/output
  allowance automatically from model capacity and the remaining dollar budgets. Remove
  obsolete persisted controls rather than leaving invisible overrides.
- **Scope:** Workspace settings and assistant execution.
- **Source:** 2026-09-20 — user requested removing these three settings and following
  the LLM response. This supersedes the earlier editable byte/token budgets.
- **Exceptions:** Operator model-capability configuration remains; internal bounded
  evaluation scripts may set input/output caps.

### Telegram answers use rich messages and native Stop

- **Preference:** Render model answers with Telegram's native rich formatting and
  provide the native Stop control while streaming, so users can cancel from the reply.
- **Scope:** Telegram model answers; streaming and Stop apply to private interactive
  runs because Telegram's draft API supports private chats only.
- **Source:** 2026-09-20 — user requested rich messages and the Bot API 10.3 Stop button.
- **Exceptions:** Control/status replies retain their existing text formatting;
  rejected rich sends fall back to text. This does not authorize media, ephemeral
  group messages, or other unrelated features from the API changelogs.

### Telegram answers stay conversational

- **Preference:** Do not append automatic coverage reports, raw timestamp ranges,
  routine history-availability disclaimers or run UUID footers to model answers.
  Explain missing context briefly in natural language only when it affects the answer
  or the user asks.
- **Scope:** Ordinary Telegram model answers in private chats, groups and scheduled
  deliveries. Keep diagnostic metadata in backend records and the admin panel.
- **Source:** 2026-09-21 — user requested removing the “received messages” coverage
  block and “Run <UUID>” footer because they are not natural explanations.
- **Exceptions:** Explicit status/cancel and troubleshooting flows may show run IDs;
  incomplete responses still need a short, readable explanation. Source citations
  remain supported.

### Prefer native Telegram Topics for conversations

- **Preference:** Use Telegram's native Topics as the primary conversation interface.
  Messages in the same topic continue naturally without requiring Reply. Do not add
  a parallel New conversation / Recent conversations interface or ask users to
  manage backend thread IDs.
- **Scope:** Telegram private conversation routing and related help text. Topic IDs
  distinguish conversations within the selected workspace, user and bot.
- **Source:** 2026-09-22 — user enabled Topics and requested prioritizing this native
  thread management, after rejecting separate new/recent conversation controls.
- **Exceptions:** Private messages without a topic retain the existing reply-based
  compatibility behavior. Cross-topic history may be explicitly retrieved as reference;
  it does not change the active topic or merge conversations.

### Keep discussion management inside a Topic implicit

- **Preference:** Continue short follow-ups naturally, answer clear new subjects
  without asking to create a conversation, and retrieve earlier discussion context
  when useful. Ask only when ambiguity affects the answer. Maintain internal
  discussion summaries, decisions and todos without exposing bookkeeping.
- **Scope:** Native Telegram private Topics. Preserve growing history prefixes for
  model caching; freeze summaries between threshold-triggered compactions.
- **Source:** 2026-09-22 — user approved applying the natural-conversation scheme
  within each Topic, while explicitly requiring attention to cache reuse.
- **Exceptions:** Explicit requests to save instructions and external actions retain
  their existing approval requirements. Retention/source edits may invalidate caches.

### Group follow-ups continue naturally without interrupting other conversations

- **Preference:** After an explicit interaction, recognize clear short follow-ups
  without requiring another mention or Reply. Keep each participant's default
  discussion continuous while allowing them to join a shared public discussion.
  Stay quiet when it is unclear whether the bot is addressed; clarify only when
  the bot is clearly addressed and the intended reference is ambiguous.
- **Scope:** Authorized users in linked Telegram groups and native group Topics.
  Reuse implicit discussion records, stable cache prefixes and threshold compaction.
- **Source:** 2026-09-22 — user approved implementing per-user group continuity and
  a five-minute candidate window with local filtering and semantic reply decisions.
- **Exceptions:** Telegram must deliver ordinary messages. Pending answers, expired
  attention, controls and recap/workflow outputs retain explicit addressing. Existing
  external-action approvals and message-collection consent still apply.
