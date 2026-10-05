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

### Plugin cards are a compact catalog with separate details

- **Preference:** Show an Installed section with Code Truth, Codex and registered
  local extensions, followed by a Markets section featuring popular Pi packages.
  Keep each card to a name, short purpose and status. Open a dedicated detail
  page from the whole card for settings, actions, file information and source
  links.
- **Scope:** Workspace Plugins page and its plugin detail routes. Market entries
  are discovery links; they do not imply installation or runtime compatibility.
- **Source:** 2026-09-29 — user requested Installed cards for Code Truth and
  Codex, a market featuring popular Pi extensions, and simple cards that open
  plugin detail pages.
- **Exceptions:** Add plugin remains a labeled action in the Installed heading.

### Codex details show configuration, repositories and tasks separately

- **Preference:** Divide the Codex detail page into three cards: a compact
  configuration summary with an Edit action that opens a configuration dialog,
  a repository list with Add repository in its heading, and coding tasks.
- **Scope:** Codex plugin detail page on desktop and mobile.
- **Source:** 2026-09-29 — user requested three parts, a configuration summary and
  edit dialog in the first card, and Add repository in the repository list card.
- **Exceptions:** Repository editing remains in its own dialog; task controls
  remain with their tasks.

### Codex sign-in shows progress and recovery

- **Preference:** Show progress while requesting a device-code sign-in. Bound the
  wait, explain failures, and offer a connection recheck in the same dialog while
  preserving unsaved settings.
- **Scope:** Codex configuration and device-code sign-in.
- **Source:** 2026-10-05 — user clicked Sign in with device code, saw no result,
  and reported that the button became disabled.
- **Exceptions:** Sign-in stays disabled while the runner is unavailable;
  connection recheck remains available.

### Coding repository forms group fields and identify maintainers

- **Preference:** Keep repository fields evenly spaced, with help text beside
  the relevant control and a distinct maintainer choice list. Show each available
  Telegram username with its numeric ID so an operator can identify the person
  before granting coding access. Keep the action row separated from the list.
- **Scope:** Add and edit coding repository dialogs in the Codex plugin.
- **Source:** 2026-09-29 — user showed the Add coding repository dialog, asked to
  fix its UI issues, and requested Telegram usernames in the user list.
- **Exceptions:** When no username is known, show the numeric Telegram ID alone.

### Codex owns environment preparation and verification

- **Preference:** Do not expose setup or check command configuration in either
  Add or Edit coding repository. Codex discovers and prepares the repository's
  environment and chooses relevant verification from project instructions.
- **Scope:** Coding repository forms and the local execution workflow, desktop
  and mobile. Remove obsolete saved command overrides rather than hiding them.
- **Source:** 2026-10-05 — user requested removing the command fields, then
  clarified that these commands should require no configuration at all. This
  supersedes the interpretation that command configuration moves to Edit.
- **Exceptions:** Application services still enforce isolated verification,
  publication permissions and task budgets; failed verification blocks publication.

### Plugin detail back links use SVG icons

- **Preference:** Pair the Plugins back label with an SVG back icon.
- **Scope:** Back links on plugin detail pages.
- **Source:** 2026-09-29 — user requested an SVG icon for the Back to Plugins
  control.
- **Exceptions:** None recorded.

### Selected checkmarks use SVG icons

- **Preference:** Render checkmarks used for selected or completed states as SVG
  icons instead of text symbols.
- **Scope:** Selected-state and completion checkmarks in the web admin and setup UI.
- **Source:** 2026-09-28 — user showed the selected workspace item and requested
  an SVG icon in place of that symbol everywhere it appears.
- **Exceptions:** None recorded.

### Admin UI follows TelegramUI's visual language

- **Preference:** Use TelegramUI as a design reference for RepoDesk's own UI:
  system typography, a soft gray canvas, white grouped sections, blue actions,
  quiet separators, rounded controls, compact status badges, and comfortable
  touch targets. Keep these patterns consistent across the admin panel and setup.
  Maintain the local CSS tokens and components rather than importing TelegramUI.
- **Scope:** RepoDesk web admin and setup surfaces. This does not turn the site
  into a Telegram Mini App or imply that it reads Telegram client theme values.
- **Source:** 2026-09-28 — user linked [TelegramUI](https://github.com/telegram-mini-apps-dev/TelegramUI)
  and asked to use its design as a reference without using the package directly.
  Reference revision: `00c87ea84f34f2869ce9d725c453349b0d1c91bc`.
- **Exceptions:** Preserve the established minimal green RepoDesk mark and the
  existing green setup illustration; they provide product identity within the
  updated interface. Existing action labels, accessible icon controls and
  permission-sensitive flows remain governed by their specific rules below.

### Logo stays minimal

- **Preference:** Use one clear vector mark with simple geometry and the
  existing restrained green palette. Avoid gradients, shadows and extra symbols.
- **Scope:** RepoDesk logo, favicon and product brand treatment.
- **Source:** 2026-09-26 — user asked for a logo and specified a super clean design.
- **Exceptions:** None recorded.

### Product branding is independent of connected GitHub accounts

- **Preference:** Use RepoDesk as the product name in the admin panel and bot.
  Show organization and personal GitHub account names only as connected account
  data or clearly labeled examples.
- **Scope:** Product identity, setup, help text, default GitHub App name and examples.
- **Source:** 2026-09-26 — user clarified that DeepX was only an example GitHub
  organization and chose RepoDesk as the project name.
- **Exceptions:** Historical deployment records and compatibility identifiers may
  retain their original values so existing installations continue to work.

### Setup entry splits background and form

- **Preference:** Give the unauthenticated setup entry a balanced two-panel layout,
  with a visual background on one half and the claim form on the other. Keep the
  form easy to read and the layout usable on narrow screens. Include Telegram,
  GitHub and team cues in the background without implying that accounts are
  already connected. Express the relationship through a static illustration:
  repository elements and Telegram chat threads connected by lines. Keep the
  illustration free of playback controls and a bottom caption.
- **Scope:** First-run administrator claim, the shared administrator sign-in
  surface, and authenticated setup. The authenticated setup uses the same visual
  panel beside its task-focused wizard.
- **Source:** 2026-09-26 — user requested a half-background, half-form setup design,
  then asked for more Telegram, GitHub and team elements in the background.
  2026-09-27 — user requested a more designed animation with repository elements,
  Telegram chat threads and connecting lines in place of the three cards.
  2026-09-27 — user requested using the setup admin layout for the authenticated
  setup page too.
  2026-09-27 — user requested removing the pause button and the “From your code
  to your conversation.” caption.
  2026-09-28 — user asked to remove the animation from the recently added
  illustration, superseding the earlier motion preference.
- **Exceptions:** On narrow screens, stack the panels to preserve form width;
  scale the illustration to fit.

### Authenticated setup shows one essential step at a time

- **Preference:** Present setup as navigable, resumable steps. Show only the
  workspace, Telegram bot and GitHub App steps. Continue saves Workspace and
  Telegram fields before moving forward; errors keep the draft on that step.
  Do not pair a separate Save button with Continue. The GitHub step shows one
  Connect GitHub action. GitHub handles authorization and installation repository
  choice; after verified repository connection, show a welcome dialog for
  RepoDesk with confetti and a Get started button that opens the workspace.
  Keep detailed GitHub controls in Plugins and show that page to the deployment
  administrator even before Telegram account linking. Keep optional workspace
  policies in Workspace settings, and model configuration and bot activation in
  the admin panel.
- **Scope:** Authenticated setup at `/setup`, including desktop and mobile.
- **Source:** 2026-09-27 — user asked to split the long setup page into several
  steps and leave unimportant options for later. The user then asked to remove
  the separate Save workspace button from the inline Workspace form. The user
  then asked for the same single-action flow on the other steps. On 2026-09-27,
  the user made Telegram owner linking optional after activation because the
  web administrator already controls the bot token. On 2026-09-27, the user
  requested Workspace → Telegram bot → GitHub App → enter panel, with model
  configuration moved into the panel. On 2026-09-27, the user removed the fourth
  step and requested one GitHub button, automatic workspace entry and confetti.
  On 2026-09-27, the user reported that choosing All repositories in GitHub
  stalled setup; the setup connection must accept all currently granted repos.
  On 2026-09-27, the user asked for the final dialog to say Welcome to
  RepoDesk with a Get started action instead of GitHub connected.
  On 2026-09-27, the user asked where extension settings went after setup;
  keep Plugins visible to deployment administrators before Telegram account
  linking so those settings remain discoverable.
- **Exceptions:** Multiple accessible installations still require review in
  Plugins to preserve workspace scope.
  Custom models still require documented capacity and token prices
  before activation. A published enabled skill and a ready Telegram receiver
  remain activation requirements. Owner-only Telegram actions require separately
  linking a personal Telegram account.

### Setup timezone is selected from IANA zones

- **Preference:** Offer a timezone selector with the browser's timezone chosen
  initially. Keep a saved workspace timezone selected when returning to setup.
- **Scope:** Workspace timezone in the authenticated setup wizard.
- **Source:** 2026-09-27 — user requested a selector for the setup timezone field.
- **Exceptions:** None recorded.

### Telegram bot token does not trigger password saving

- **Preference:** Use a regular text input for the Telegram bot token so browser
  password managers do not treat it as an account password. Disable browser
  autocomplete, capitalization and spellcheck. Clear the entered token after a
  successful save and show only configured status when returning to setup.
- **Scope:** Telegram bot token field in authenticated setup.
- **Source:** 2026-09-27 — user reported that Chrome offers to save the bot token
  to its password manager when the field uses `type="password"`.
- **Exceptions:** The administrator account password remains a password field.

### Overview shows connected services

- **Preference:** Show Telegram bot and GitHub connection cards on the workspace
  Overview, with saved status and safe identity details. Manage bot opens a dialog
  to replace the write-only Telegram token without leaving Overview; Manage GitHub
  opens the GitHub management dialog without changing the route. Keep the cards
  usable on narrow screens.
- **Scope:** Deployment administrator's workspace Overview.
- **Source:** 2026-09-27 — user requested bot and GitHub cards on the Overview
  after completing setup. 2026-09-28 — user requested editing the Telegram token
  in a dialog from Manage bot instead of navigating to Setup. 2026-09-28 — user
  requested that Manage GitHub open without changing the route.
- **Exceptions:** Connection details remain limited to the workspace's deployment
  administrator; other members keep their existing Overview.

### Overview counts lead to the matching records

- **Preference:** Make Overview count cards open their detail pages, and count the
  same records those pages list. Show assistant runs, scheduled workflows and
  coding tasks as distinct totals so active Codex work is easy to find.
- **Scope:** Workspace Overview for deployment administrators and linked members.
- **Source:** 2026-09-28 — user showed zero Runs and Workflows cards despite live
  bot work and asked for pages with details.
- **Exceptions:** An unlinked deployment administrator sees read-only run and
  workflow metadata; private conversation content still requires an eligible
  linked Telegram identity.

### Run summaries open message details

- **Preference:** Keep each run item to a compact two or three line summary.
  Open a detail dialog from the whole item, with the run's messages presented
  as a readable ordered list and technical metadata below them.
- **Scope:** Runs & delivery in the workspace admin panel, on desktop and mobile.
- **Source:** 2026-09-28 — user showed a tall run card and asked for compact
  items that open a detailed message list when clicked.
- **Exceptions:** Unlinked deployment administrators can open run and delivery
  metadata, but conversation messages remain limited to linked, eligible viewers.

### Team configuration uses one overview editor

- **Preference:** Show saved workspace configuration in the Overview team card.
  Present the labels and values in a compact responsive grid; keep explanations
  in the editor. Place one Edit action on the card and edit all changeable settings
  together in one dialog with one save action. Keep fixed policy values visible
  and read-only.
- **Scope:** Workspace Overview configuration for authorized administrators.
- **Source:** 2026-09-28 — user showed the separate Configuration list and asked
  to show its values in the Overview team card, with one edit button and one form.
  The user then asked to make that card more compact, suggesting a grid layout.
- **Exceptions:** Model capacity remains on Workspace settings because it describes
  deployment model limits rather than editable team configuration.

### Connected GitHub repositories stay compact and directly accessible

- **Preference:** Open connection details from the Overview card in a Manage
  GitHub modal on Overview. Omit a second GitHub summary card from Plugins. Show
  connected repositories in the modal as a wrapping inline list of
  compact items, each with an external link to its GitHub repository at the end.
  Show at most five by default, followed by an "N more" tag that reveals the rest
  and can collapse the list again. Keep connection-change and disconnect buttons
  out of the connected GitHub details.
- **Scope:** Workspace GitHub App details in the modal and its Overview entry.
- **Source:** 2026-09-27 — user requested an inline flex repository list with
  external links and removal of the two connection buttons shown below it.
  2026-09-28 — user requested a five-repository limit and a remaining-count tag.
  2026-09-28 — user requested moving the GitHub details into a modal opened by
  Manage GitHub. The user then asked to remove the GitHub summary card from
  Plugins.
- **Exceptions:** An unconnected workspace still shows Connect GitHub; failed
  loads may show Reload GitHub connection.

### Sidebar logout sits beside the account identity

- **Preference:** Place the sign-out icon at the right edge of the account row,
  alongside the signed-in identity. Allow long identity text to wrap within its
  column while keeping the icon accessible.
- **Scope:** Signed-in account area of the admin sidebar, including narrow screens.
- **Source:** 2026-09-26 — user requested moving the logout button to the right side
  of the account area shown in the sidebar.
- **Exceptions:** None recorded.

### New workspaces start from the workspace dropdown

- **Preference:** Put a New workspace entry in the admin sidebar workspace
  dropdown. Open a creation dialog from that entry and select the workspace
  after it is created.
- **Scope:** Workspace creation from the signed-in admin panel.
- **Source:** 2026-09-27 — user requested support for adding a workspace from the
  workspace dropdown.
- **Exceptions:** The first workspace remains part of the setup wizard.

### Workspace switching uses the panel's own dropdown

- **Preference:** Use a styled, accessible dropdown in the admin sidebar for
  switching workspaces. Show the selected workspace and a clear selected state in
  the menu, keep New workspace as its final action, and support keyboard and
  outside-click dismissal.
- **Scope:** Signed-in admin sidebar workspace selector, on desktop and mobile.
- **Source:** 2026-09-28 — user shared the native workspace select menu and asked
  to use RepoDesk's own dropdown.
- **Exceptions:** The setup timezone and other form selectors may remain native
  controls.

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

### Skill creation has a labeled header action

- **Preference:** Show the plus icon with a visible “Add skill” label in the
  Agent skills page heading so the creation action is clear at a glance.
- **Scope:** The Agent skills page header.
- **Source:** 2026-09-28 — user asked to change the Add skill control to an icon
  and label button.
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

### Member switches sit beside their labels

- **Preference:** Show active membership and whitelist permission as switch
  controls aligned to the right of their labels in the member dialog. Keep
  guidance about numeric Telegram IDs beside the ID field.
- **Scope:** Add and edit member dialogs in the admin panel.
- **Source:** 2026-09-27 — user asked to change the member checkboxes to toggles
  and move them to the right.
- **Exceptions:** None recorded.

### Member creation has a labeled header action

- **Preference:** Show the plus icon together with the visible “Add member” label
  in the page heading, so the creation action is clear at a glance.
- **Scope:** The Members & access page header.
- **Source:** 2026-09-27 — user asked to change the plus-only header control to a
  button with an icon and label.
- **Exceptions:** None recorded.

### Shareable access links use a card and copy action

- **Preference:** Display the Telegram access-request URL as text in a regular
  card with a copy icon button, rather than as a read-only input. After a
  successful copy, show a check icon for one second, then restore the copy icon.
  Do not show a separate success message.
- **Scope:** The shareable request link in Members & access → Access requests.
- **Source:** 2026-09-27 — user requested a common card and copy icon button for
  the link shown in the access-request section. 2026-09-28 — user requested a
  one-second done icon in place of the “Link copied.” message.
- **Exceptions:** None recorded.

### Workspace settings version is a title badge

- **Preference:** Show the effective settings version as a compact badge immediately
  after the page title.
- **Scope:** Workspace settings; the badge follows the saved server version.
- **Source:** 2026-09-21 — user requested moving the version beside the title as a badge.
- **Exceptions:** None recorded.

### Workspace settings show saved values before editing

- **Preference:** Show each saved Workspace setting as a labeled value with its
  explanation. Open a focused edit modal for that item instead of keeping its
  input visible on the page. Cancel discards the draft; saving updates the shown
  value and version after validation.
- **Scope:** Workspace settings in the admin panel.
- **Source:** 2026-09-28 — user requested that each setting item show the real
  configuration value and use an edit modal to update it.
- **Exceptions:** Model capacity and fixed scheduling policy are read-only
  context. Setup steps retain their guided forms.

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

### New workspaces use the setup page

- **Preference:** Open the existing guided setup page from New workspace in the
  workspace selector. Start with a blank workspace form, then continue through
  Telegram and GitHub setup for the created workspace.
- **Scope:** Operator creation of additional workspaces in the admin panel.
- **Source:** 2026-09-29 — user requested reusing the setup page when adding a new
  workspace.
- **Exceptions:** The first workspace still starts from initial setup after the
  administrator account is created.

### Add and create flows use modals

- **Preference:** Open a modal from an explicit Add/Create action instead of
  displaying the creation form directly on the page. Keep lists and summaries
  on the page, and use the same modal editor for related edit actions. Provide
  a named dialog, trapped keyboard focus, Escape and visible cancel controls,
  focus return, mobile scrolling, and validation/errors inside the dialog.
  Cancel discards the draft; failed saves keep it open; pending saves block
  dismissal and duplicate submission.
- **Scope:** Add/create management flows across the admin app: members,
  workflows, skills/imports, instructions, runs, panel accounts,
  plugins, repositories/networks and GitHub Apps. Related repository, plugin,
  member, workflow, skill and instruction editors also use these dialogs.
- **Source:** 2026-09-20 — user requested preferring modals for Add actions
  across the app instead of inline forms.
- **Exceptions:** Sign-in/bootstrap, policy forms,
  workspace creation in the setup wizard, approval decisions and
  recovery controls stay on their pages. Field editing
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
  Keep organization/personal ownership explicit, select personal initially, and
  explain the next installation step.
- **Scope:** GitHub App onboarding in setup and the workspace Plugins panel.
- **Source:** 2026-09-20 — user requested a button to create a GitHub App directly,
  referencing Coolify's guided setup. 2026-09-26 — user requested support for
  creating the App for a personal account.
- **Exceptions:** Existing Apps can still use manual environment/file configuration.
  The setup wizard uses personal ownership and a generated App name without a
  dialog; organization ownership and visibility choices remain in Plugins.

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

### Codex provider keys are configurable in the web panel

- **Preference:** Let workspace operators set, replace and remove the local Codex
  provider API key in the panel, showing only its configured status after saving.
- **Scope:** Local Podman Codex credentials. Provider endpoint/model remain deployment
  configuration; an environment key may serve as an optional fallback.
- **Source:** 2026-09-22 — user requested API key configuration in the web panel,
  superseding the earlier environment-only request for this credential.
  2026-09-29 — user requested local Codex execution only.
- **Exceptions:** None recorded.

### Codex authentication is selected per workspace

- **Preference:** Show custom provider API key and ChatGPT device-code sign-in as peer choices in the Codex configuration dialog. Show the device link, one-time code, connection status and disconnect action there.
- **Scope:** Local Podman Codex credentials for each workspace. Existing workspaces retain the custom provider method until changed.
- **Source:** 2026-09-29 — user requested device-code login at the same setting level as custom provider auth, configured through the UI for each workspace.
- **Exceptions:** Device-code tasks require trusted private repositories; custom provider credentials retain their deployment fallback.

### First setup asks only for account credentials

- **Preference:** Ask only for username and password when creating the first
  administrator. Do not require a bootstrap token, host command or confirmation field.
- **Scope:** Unclaimed deployment setup at `/setup`; retain the atomic server-side
  first-account restriction and existing sign-in protections.
- **Source:** 2026-09-27 — user requested removing the Bootstrap token and asking
  only for username and password on first setup.
- **Exceptions:** None recorded.

### Admin site domains are configured in the panel

- **Preference:** Provide custom-domain setup in the admin panel, with an editable
  hostname and the routing instructions needed to connect the site.
- **Scope:** Deployment-wide admin site address; restricted to deployment operators.
- **Source:** 2026-10-05 — user requested custom-domain setup for the admin panel
  site inside the admin panel.
- **Exceptions:** DNS, certificates and host proxy routing require infrastructure
  configuration outside the panel; availability must not be implied by saving.
