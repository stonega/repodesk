# UI design rules

This document records reusable UI preferences expressed by the user. Read it before
designing or modifying UI, and apply the rules relevant to the current task.
These preferences guide design; they do not claim that the UI already implements
them.

## Common UI decisions

This index points to existing preferences; each linked rule's scope and exceptions
still apply. Follow the [UI implementation and completion checks](../../AGENTS.md#ui-implementation-and-completion-checks)
when implementing or reviewing a change.

| Decision | Relevant preferences |
| --- | --- |
| Saved display versus editing | [Modal editors](#add-and-create-flows-use-modals), [workspace values](#workspace-settings-show-saved-values-before-editing), [team summary](#team-configuration-uses-one-overview-editor), [model summary](#model-configuration-uses-a-summary-card-and-one-editor) |
| Plugin detail layout | [Shared plugin layout](#plugin-details-share-card-layouts-and-a-title-switch), [Codex sections](#codex-details-show-configuration-repositories-and-tasks-separately) |
| Repository display | [Shared repository cards](#repository-cards-share-one-style), [member previews](#member-repository-previews-stay-bounded), [connected repositories](#connected-github-repositories-stay-compact-and-directly-accessible) |
| Action labels and controls | [Edit/New labels](#edit-and-add-buttons-use-short-labels), [shared icons](#common-action-buttons-use-reicon), [dropdown styling](#dropdown-inputs-share-the-workspace-selector-style) |
| Dialog actions | [Cancel order](#modal-cancel-follows-the-primary-action), [close controls](#modal-close-controls-use-a-plain-x), [secondary actions](#dialog-support-actions-use-secondary-buttons) |
| Feedback and loading | [Toasts and error placement](#routine-action-confirmations-and-request-errors-use-toasts), [visible loading layout](#loading-keeps-the-layout-visible) |

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

### Model providers are reused across services

- **Preference:** Add an OpenAI-compatible API provider with its base URL and
  write-only API key, fetch its model list, and choose the bot chat model during
  workspace setup. Later model-powered services select a model from those saved
  providers instead of asking for the URL and key again.
- **Scope:** Authenticated setup, Model settings, Codex and Code Review. Providers
  are shared across workspaces managed by the same deployment operator; each
  workspace/service saves its own model selection.
- **Source:** 2026-10-08 — user requested provider-first model setup, automatic
  API model discovery and reuse for bot chat, code review, Codex and other services.
- **Exceptions:** ChatGPT device-code sign-in remains an independent Codex option.
  Existing deployment/per-workspace model credentials remain a compatibility path
  until replaced. Custom bot models still need documented capacity and prices.
  Provider records use New/Edit dialogs and saved summaries; the setup chat-model
  selector is a guided form. API keys are edited only on the provider record.

### Newly created GitHub Apps use RepoDesk branding

- **Preference:** Use RepoDesk's existing app icon as the GitHub App icon when
  guiding users through App creation.
- **Scope:** GitHub App creation in setup and Manage GitHub, with a ready-to-upload
  PNG and an owner-appropriate GitHub settings link after registration.
- **Source:** 2026-10-08 — user requested adding our app icon when creating a
  GitHub App for a user.
- **Exceptions:** GitHub's documented manifest has no logo field; the owner uploads
  the icon in GitHub. Setup waits for the owner's upload acknowledgement before
  continuing authorization. An acknowledgement is not API verification of the icon.

### Telegram repository menus favor recent work

- **Preference:** Offer `/repos` as a native inline repository picker, showing at
  most ten active repositories. Prioritize repositories the person recently
  mentioned, then recent repository activity. Keep the current selection visible
  and make changing or clearing it straightforward.
  Make `/repos` and private `/github` account linking discoverable in Telegram's
  native command menu alongside the main conversation/task shortcuts.
- **Scope:** Repository selection in Telegram, scoped to the workspace, person,
  bot and chat/topic. Use one repository per button row so names remain readable;
  `/repos <name>` searches connected choices beyond the first ten.
- **Source:** 2026-10-08 — user requested improving Telegram's inline menu with
  `/repos` and the latest ten active repositories, preferring recent mentions.
  Later in the same task, the user also requested `/github` for connecting GitHub.
- **Exceptions:** Show only workspace-selected repositories accessible to the
  person; exclude archived/disabled repositories and private repositories in
  groups. Selection supplies default context and does not grant action permission.
  Rankings use retained personal mentions and saved GitHub activity metadata;
  they do not imply a live GitHub fetch for each command.

### Workflow cards lead to dedicated details

- **Preference:** Improve workflow card readability and provide a dedicated
  detail page. Keep the name and status prominent, group schedule information
  into labeled values, and put technical identifiers in details.
- **Scope:** Scheduled workflow cards and their detail pages, including the
  read-only deployment-operator view, on desktop and mobile.
- **Source:** 2026-10-08 — user requested improving card content, adding a workflow
  detail page and updating related APIs, with a screenshot of the workflows page.
  The labeled summary layout is the implementation choice for that request.
- **Exceptions:** Existing privacy and identity requirements still govern task
  content, destinations and management actions. Display recurrence previews as
  previews when a workflow is not active.

### Repository cards share one style

- **Preference:** Use one shared repository card for names, badges, external
  GitHub links and management actions. Share its muted surface, border, rounded
  corners, typography and spacing throughout the app. Compact lists use the
  same card frame; managed records add their saved details below the heading.
- **Scope:** Members & access previews and full-list dialogs, Manage GitHub,
  Codex, Review Bot and Code Truth repository summaries, on desktop and mobile
  in both themes. Long names wrap inside the card; link and action controls keep
  accessible names, focus styling and comfortable touch targets.
- **Source:** 2026-10-08 — user requested a unified repository card style across
  the app after the member repository preview/modal change.
- **Exceptions:** Repository selectors retain their shared dropdown style.
  Task references remain part of task summaries. Context-specific details,
  five-item preview limits and New/Edit modal behavior remain applicable.

### Member repository previews stay bounded

- **Preference:** Show at most five repositories with their permission labels in
  each member's GitHub summary. When more exist, show the total in a Show all
  action that opens the complete list in a read-only, scrollable modal. Keep long
  repository names readable without expanding the member table vertically to
  show the entire list.
- **Scope:** Repository access summaries in the Members & access table, on desktop
  and mobile. Reuse the shared modal's close, Escape, focus and scrolling behavior.
- **Source:** 2026-10-08 — user showed a member row stretched by its full repository
  list and requested five entries with a modal to show all repositories.
- **Exceptions:** Lists of five or fewer entries need no Show all action. The
  workspace connection modal retains its separate expandable-list preference.

### Member forms fetch GitHub account choices

- **Preference:** Include a GitHub account field in member forms and automatically
  fetch available accounts from the workspace's connected GitHub installation.
  Show the saved account and a profile link in the form and member table.
- **Scope:** Add/Edit member dialogs and the Members & access table. Organization
  installations supply organization members; personal installations supply their
  owner and selected-repository collaborators.
- **Source:** 2026-10-07 — user showed the GitHub column and requested the missing
  edit-form link and automatic GitHub member fetching.
- **Exceptions:** GitHub provides no Telegram IDs. An administrator chooses the
  association; the member verifies account ownership through Telegram. Existing
  verified accounts are changed by the member's connection flow.

### Expired admin sessions open sign-in immediately

- **Preference:** When an authenticated request reports an expired or revoked
  session, clear the signed-in state and open the login page directly. Do not
  leave a session-expired banner with a page reload action.
- **Scope:** Admin and authenticated setup pages, including background refreshes
  and form submissions.
- **Source:** 2026-10-07 — user showed the “Your session expired. Sign in again.”
  banner with “Reload coding settings” and requested going directly to login.
- **Exceptions:** Invalid login credentials keep the sign-in form visible with
  an error. Permission denials and ordinary request failures stay on their page.

### Dropdown inputs share the workspace selector style

- **Preference:** Use the sidebar workspace selector's muted rounded trigger,
  chevron, bordered menu, blue hover state and SVG selection check for dropdown
  inputs throughout RepoDesk. Share these styles across controls and themes.
- **Scope:** All web admin and setup dropdown inputs, including form dialogs,
  filters, timezone groups, model suggestions and searchable repository selectors,
  on desktop and mobile.
- **Source:** 2026-10-06 — user requested “update all dropdown input in repodesk
  to style like the workspace selector in left side bar.” and requested reimplementation.
- **Exceptions:** Preserve repository search and existing field behavior, including
  validation, custom model IDs, disabled states and keyboard use. Workspace creation remains a
  workspace-menu action; other selectors do not acquire that action.

### Application version stays at the bottom right

- **Preference:** Show the application version as small, muted text at the
  bottom-right of the viewport, with space for mobile safe areas.
- **Scope:** Shared web page shell, including admin, sign-in and setup pages.
- **Source:** 2026-10-06 — user requested adding a version number at the right
  bottom of the page.
- **Exceptions:** Toasts and dialogs may cover the label while open.

### Available updates open release notes from the version indicator

- **Preference:** When GitHub has a newer stable release, show an indicator
  immediately after the application version. Clicking it opens a modal containing
  the changelog, update notes and an explicit update action.
- **Scope:** Shared signed-in admin/setup shell at desktop and mobile widths.
  Preserve the muted bottom-right version and shared modal close, focus, pending
  lock and primary-action-then-Cancel behavior.
- **Source:** 2026-10-09 — user requested automatic GitHub release checks, an
  indicator after the version and a modal to update with changelogs/update notes.
- **Exceptions:** Only deployment administrators can start updates; other signed-in
  accounts can review notes. An installation without a ready host updater shows
  setup guidance. Sign-in keeps the version without an update action.

### Workspace pause belongs in Settings with confirmation

- **Preference:** Use Workspace settings for a dedicated Pause workspace action
  and saved activity status. Place the Active/Paused badge immediately after the
  Pause workspace card title in the same row. Open a confirmation dialog before
  pausing, with explicit consequences and Cancel. Provide Resume workspace when paused. Keep
  pause out of the Overview team configuration editor and place Settings directly
  below Plugins in the sidebar.
- **Scope:** Workspace administration on desktop and mobile.
- **Source:** 2026-10-06 — user requested replacing the model-capacity content with
  pause controls, removing pause from the workspace edit modal, confirming pause
  in a modal, and moving Settings below Plugins.
  2026-10-06 — user requested moving the Active badge after the Pause workspace
  title.
- **Exceptions:** Model capacity remains available in deployment Model settings.
  When Plugins is unavailable to an administrator, Settings follows the remaining
  workspace navigation.

### Coding repository selectors support search

- **Preference:** Search connected repositories by owner or repository name inside
  the selector, with a bounded results list and keyboard selection. Preserve the
  selected repository when dismissing a search; require an actual list selection.
- **Scope:** Add and Edit coding repository dialogs in the Codex plugin, on desktop
  and mobile.
- **Source:** 2026-10-06 — user showed the long native repository menu and requested
  search support for the repository selector.
- **Exceptions:** Other form selectors retain their existing behavior.

### Assistant requests have no fixed tool-call quota

- **Preference:** Let ordinary assistant requests make the tool calls needed to
  complete their work; do not stop a review after an arbitrary fixed call count.
- **Scope:** Pi chat requests and authorized application/extension tools. Existing
  workspace model-turn and spending controls remain separate.
- **Source:** 2026-10-09 — user rejected the fixed eight-tool-call limit after two
  Telegram PR-review requests exhausted it.
- **Exceptions:** Permission checks, actor/tenant boundaries, cancellation,
  approval pauses, request timeout and provider limits still apply. Internal
  summarization and follow-up classification remain tool-free; test/evaluation
  callers may deliberately bound tool execution.

### Codex tasks have no configurable execution quotas

- **Preference:** Remove maximum execution cycles, automatic check repairs,
  active execution time and token limits from both Codex settings and execution.
  Remove saved overrides instead of retaining hidden limits. Continue authorized
  work and repair until completion, a necessary question, cancellation or failure.
- **Scope:** Codex repository forms, policy storage and local task execution.
- **Source:** 2026-10-06 — user requested removing all four displayed settings
  and explicitly confirmed removal of their execution limits too.
- **Exceptions:** Actor/repository/publication permissions, cancellation,
  retention, container isolation and provider/account limits remain applicable.

### Coding task Stop uses an icon and confirmation

- **Preference:** Use the shared solid Stop icon button in task rows with an accessible
  task-specific label and hover title. Open a confirmation modal identifying the
  task and repository, explaining cancellation and retained GitHub artifacts,
  with visible Stop followed by Cancel. Send cancellation only after confirmation;
  lock dismissal while pending and keep failures in the modal.
- **Scope:** Reviewed and continuous coding tasks in the Codex plugin, on desktop
  and mobile.
- **Source:** 2026-10-06 — user requested a Stop label button and a confirmation
  modal for the coding task action shown in the screenshot.
  2026-10-07 — user requested changing the task-row Stop button to an icon button,
  superseding the earlier visible text preference for that control.
  2026-10-07 — user requested a solid Stop icon instead of the outlined square.
- **Exceptions:** Telegram Stop controls retain their existing behavior.

### Editing a repository starts with the saved selection

- **Preference:** Opening Edit shows the saved repository and keeps its dropdown
  closed. Open search on a click, typing or arrow-key interaction, rather than
  automatically when the modal focuses the input.
- **Scope:** Coding repository selectors, including Add and Edit dialogs.
- **Source:** 2026-10-06 — user requested automatic selection of the current
  repository and a closed dropdown when opening Edit.
- **Exceptions:** None recorded.

### Routine action confirmations and request errors use toasts

- **Preference:** Show successful saves and comparable action confirmations in a
  compact floating toast instead of an inline banner. Auto-dismiss after six
  seconds, pause dismissal while hovered or focused, and provide a close button
  and polite screen-reader announcement. Repeated actions show a fresh toast.
- **Scope:** Web admin confirmations, including team/model configuration,
  Telegram bot tokens, plugins, site settings and access decisions. Keep the
  toast within the viewport on desktop and mobile without shifting page content.
  Index refresh confirmations use the same toast; retain index results on the page.
  Page-level action and request errors also use floating toasts with distinct
  error styling, alert announcements and any existing retry/reload action.
  Error toasts remain until dismissed or the error clears so recovery controls
  do not time out.
- **Source:** 2026-10-06 — user showed the inline “Team configuration saved.”
  banner and requested a toast for this kind of notification, then requested a
  sweep of the remaining inline notifications.
- **Source update:** 2026-10-08 — user showed the Review Bot “Configure the GitHub
  webhook first.” error with “Reload saved settings” and requested toasts for this
  kind of notification. Applies to comparable plugin and settings request errors.
- **Source update:** 2026-10-10 — user rejected the appearance of the “Failed to
  fetch” toast with its large “Reload coding settings” button. Use a neutral
  surface, subtle border/shadow and a small colored status icon. Keep the message,
  a compact inline Retry action and the borderless close control aligned; retain
  44px action targets and clearance above the version/update control. Use a
  descriptive accessible retry name and readable connection-error wording.
  Applies to shared admin toasts in both themes at desktop and mobile widths.
- **Exceptions:** Field/form validation errors, saved readiness warnings, ongoing
  progress and setup guidance stay beside their relevant controls. Dialog errors
  stay inside the open dialog so they remain visible and keyboard-accessible.
  Copy-link feedback retains its brief check icon as specified below.
  Errors use alert semantics and a red status icon, distinct from confirmations.

### Edit and add buttons use short labels

- **Preference:** Use exactly “Edit” for edit buttons and “New” for add/create
  entry buttons, including hover titles. Let the surrounding section or row
  identify the object instead of repeating it in the visible label.
- **Scope:** Admin and setup surfaces, including plugin configuration,
  repositories, members, skills, workflows, workspace creation and domain
  configuration.
- **Source:** 2026-10-05 — user requested “Edit” or “New” for Edit/Add buttons
  throughout the app, instead of labels such as “Edit Codex configuration”.
- **Exceptions:** Screen-reader names may identify the target to distinguish
  repeated controls. Dialog headings stay descriptive; save, approval, sign-in
  and other consequential submit actions retain their specific labels.

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
- **Exceptions:** New remains a labeled action in the Installed heading.
  The Installed grid has no trailing skeleton after the built-in cards while
  registered extensions load. Source: 2026-10-07 — user requested “remove this
  additional skeleton loader at end” beside Code Truth and Codex. This exception
  applies to the catalog grid; plugin detail loading retains its skeletons.

### Codex details show configuration, repositories and tasks separately

- **Preference:** Divide the Codex detail page into three cards: a compact
  configuration summary with an Edit action that opens a configuration dialog,
  a repository list with New in its heading, and coding tasks.
- **Scope:** Codex plugin detail page on desktop and mobile.
- **Source:** 2026-09-29 — user requested three parts, a configuration summary and
  edit dialog in the first card, and Add repository in the repository list card.
- **Exceptions:** Repository editing remains in its own dialog; task controls
  remain with their tasks.

### Plugin details share card layouts and a title switch

- **Preference:** Use the Codex detail layout as the reference for installed
  plugins: compact configuration summaries and separate cards for repositories
  and operational details where applicable. Place the Enable switch at the right
  of the page title with space between them. The switch saves independently;
  configuration editors focus on the remaining settings.
- **Scope:** Installed plugin detail pages on desktop and mobile.
- **Source:** 2026-10-05 — user requested consistent plugin details based on the
  Codex screenshot and an Enable toggle to the right of the title.
- **Exceptions:** Market discovery entries have no Enable switch. New file-plugin
  registration can set its initial enabled state; repository drafts retain their
  explicit save step.

### Dialog support actions use secondary buttons

- **Preference:** Reserve the main button theme for the dialog's save or submit
  action. Use secondary styling for supporting sign-in, disconnect and connection
  recheck actions so stacked action rows do not compete visually.
- **Scope:** Plugin configuration dialogs, including Codex authentication.
- **Source:** 2026-10-05 — user requested secondary styling for Sign in and Recheck
  connection because two rows of primary buttons create a poor hierarchy.
- **Exceptions:** None recorded.

### Codex sign-in shows progress and recovery

- **Preference:** Show progress while requesting a device-code sign-in. Bound the
  wait, explain failures, and offer a connection recheck in the same dialog while
  preserving unsaved settings.
- **Scope:** Codex configuration and device-code sign-in.
- **Source:** 2026-10-05 — user clicked Sign in with device code, saw no result,
  and reported that the button became disabled.
- **Exceptions:** Sign-in stays disabled while the runner is unavailable;
  connection recheck remains available.

### Plugin enablement explains runtime availability

- **Preference:** Manage required services through deployment automatically. On
  plugin details and configuration, explain how to connect the account and recover
  unavailable services, with a link to the operator guide. Enabling a plugin grants
  workspace access; deployment owns service startup.
- **Scope:** Plugins that require an independently deployed service, starting
  with the Codex runner. Keep host commands in the linked operator guide.
- **Source:** 2026-10-05 — user asked how to start the unavailable Codex runner
  and why this requirement was not stated when enabling the plugin; then requested
  automatic runner startup for the existing Docker VPS.
- **Exceptions:** Built-in features with no separate service need no setup notice.

### Coding repository forms group fields and identify maintainers

- **Preference:** Keep repository fields evenly spaced, with help text beside
  the relevant control and a distinct maintainer choice list. Show each available
  Telegram username with its numeric ID so an operator can identify the person
  before granting coding access. Keep the action row separated from the list.
- **Scope:** Add and edit coding repository dialogs in the Codex plugin.
- **Source:** 2026-09-29 — user showed the Add coding repository dialog, asked to
  fix its UI issues, and requested Telegram usernames in the user list.
- **Exceptions:** When no username is known, show the numeric Telegram ID alone.

### Completed Codex tasks show PRs ready for review

- **Preference:** Successful Codex publication leaves the PR ready for review and
  uses matching language in settings, task status and Telegram results.
- **Scope:** Reviewed and Direct tasks in the Codex plugin; verified follow-ups
  mark an existing draft PR ready before reporting successful publication.
- **Source:** 2026-10-08 — user requested that the PR status be ready when a Codex
  plugin job finishes.
- **Exceptions:** Publication still requires passing checks and current authority.
  Unconfirmed readiness remains unknown. Historical drafts are updated only on
  an authorized published follow-up. Review Bot fixes retain their draft policy.

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
  publication permissions; failed verification blocks publication.

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
  data or clearly labeled examples. Suggest lowercase `repodesk` as the default
  GitHub App name in setup and the creation dialog, without a workspace suffix.
- **Scope:** Product identity, setup, help text, default GitHub App name and examples.
- **Source:** 2026-09-26 — user clarified that DeepX was only an example GitHub
  organization and chose RepoDesk as the project name.
  2026-10-08 — user requested `repodesk` as the default GitHub App name.
- **Exceptions:** Historical deployment records and compatibility identifiers may
  retain their original values so existing installations continue to work.
  Custom App names remain editable; GitHub may require another name if the
  suggested name is already taken.

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
  workspace, model provider/chat selection, Telegram bot and GitHub App steps. Continue saves Workspace and
  Telegram fields before moving forward; errors keep the draft on that step.
  Do not pair a separate Save button with Continue. The GitHub step shows one
  Connect GitHub action. GitHub handles authorization and installation repository
  choice; after verified repository connection, show a welcome dialog for
  RepoDesk with confetti and a Get started button that opens the workspace.
  Keep detailed GitHub controls in Plugins and show that page to the deployment
  administrator even before Telegram account linking. Keep optional workspace
  policies in Workspace settings, and detailed model management and bot activation in
  the admin panel.
- **Scope:** Authenticated setup at `/setup`, including desktop and mobile.
- **Source update:** 2026-10-08 — user requested a model-provider step during first
  workspace setup, superseding the earlier three-step sequence.
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
  usable on narrow screens. Link the configured bot handle to its Telegram profile
  and the connected GitHub account name to its GitHub profile, opening in a new tab.
  Show these links only when the corresponding identity is available.
- **Scope:** Deployment administrator's workspace Overview.
- **Source:** 2026-09-27 — user requested bot and GitHub cards on the Overview
  after completing setup. 2026-09-28 — user requested editing the Telegram token
  in a dialog from Manage bot instead of navigating to Setup. 2026-09-28 — user
  requested that Manage GitHub open without changing the route.
  2026-10-06 — user requested Telegram and GitHub links in these cards.
- **Exceptions:** Connection details remain limited to the workspace's deployment
  administrator; other members keep their existing Overview.

### Overview counts lead to the matching records

- **Preference:** Make Overview count cards open their detail pages, and count the
  same records those pages list. Show assistant runs, scheduled workflows and
  coding tasks as distinct totals so active Codex work is easy to find.
- **Scope:** Workspace Overview for deployment administrators and linked members.
- **Source:** 2026-09-28 — user showed zero Runs and Workflows cards despite live
  bot work and asked for pages with details.
- **Exceptions:** Deployment administrators can read all workspace run messages
  without linking Telegram. Unlinked administrators still see only workflow metadata;
  workflow content and mutations retain their existing identity requirements.

### Run summaries open a dedicated detail page

- **Preference:** Keep each run item to a compact two or three line summary.
  Open a dedicated detail page from the whole item, with the run's messages
  presented as a readable ordered list and technical metadata below them. Give
  each run a workspace-scoped URL that supports direct visits and refreshes, and
  a Back to Runs link that preserves the list's pagination.
  Fetch a bounded page of summaries for the list, with previous/next controls;
  fetch messages and technical detail only when opening an individual run.
  Place pagination below the run list, after its loading or empty state when
  there are no cards to display.
- **Scope:** Runs & delivery in the workspace admin panel, on desktop and mobile.
- **Source:** 2026-09-28 — user showed a tall run card and asked for compact
  items that open a detailed message list when clicked.
  2026-10-06 — user requested removing the Telegram identity/conversation access
  restriction in run details so admins can see all messages.
  2026-10-06 — user requested a new run detail page instead of the modal,
  superseding the earlier dialog preference.
  2026-10-08 — user requested less information in the runs API, a detail API
  for full records, and a paginated UI list.
  2026-10-10 — user requested moving Runs & delivery pagination to the bottom
  of the list.
- **Exceptions:** Deployment administrators and eligible workspace owners/admins
  can read every retained run message in their workspace, including private runs.
  Telegram linking is unnecessary for deployment administrators to view messages;
  execution and mutation controls retain their existing authorization requirements.

### Run attempts use a horizontal timeline

- **Preference:** Present model attempts as numbered steps connected from left to
  right, with time, status and reserved/actual costs in compact cards. Use the
  detail page's full content width and contain horizontal scrolling within the timeline.
- **Scope:** Attempts in run detail pages, on desktop and mobile.
- **Source:** 2026-10-06 — user showed the run modal's long vertical Attempts list
  and requested a horizontal timeline.
- **Exceptions:** Other record lists keep their existing layouts.

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
- **Exceptions:** Pause is managed separately on Workspace settings with
  confirmation. Model capacity is available in deployment Model settings.

### Model configuration uses a summary card and one editor

- **Preference:** Show saved model configuration as a compact responsive grid of
  labels and values, matching the Overview team card. Place one Edit icon at the
  top right to open a modal containing model selection and advanced settings.
  Saved provider summaries have their own New/Edit dialogs for the URL and key. Keep explanations and validation in the editor; show only
  configured/missing status for the write-only API key. Cancel discards the draft;
  successful saves close the modal and refresh the summary.
- **Scope:** Model settings in the admin panel.
- **Source:** 2026-10-06 — user showed the inline model form and requested the
  Overview team-card layout with an edit modal.
- **Exceptions:** Activation readiness and bot activation remain separate from
  model configuration. Setup steps retain their guided forms.

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

### GitHub repository lists update automatically

- **Preference:** Refresh repository lists while visible and when returning from
  GitHub, so renames and visibility changes appear without reloading the page.
  Match repositories by their numeric GitHub ID. Keep loaded lists, expanded
  items, selected repositories and unsaved form values visible during refresh.
- **Scope:** Connected repositories in Manage GitHub and repository lists and
  selectors in the Codex plugin.
- **Source:** 2026-10-06 — user requested realtime repository updates because
  users can rename or edit repositories on GitHub.
- **Exceptions:** The current implementation polls every five seconds (three
  seconds during pending Codex sign-in); it has no GitHub webhook receiver.
  Hidden pages and closed dialogs stop polling. Upstream failures retain the
  saved list with an update notice. Newly granted repositories still require
  workspace authorization and selection.

### Sidebar account controls stay compact and grouped

- **Preference:** Keep the account footer short, with minimal space above and
  below its controls. Group the sign-out icon directly beside the signed-in
  identity, and put the theme switch at the row's right edge. Allow long identity
  text to wrap while keeping both controls accessible with 44px touch targets.
- **Scope:** Signed-in account area of the admin sidebar, including narrow screens.
- **Source:** 2026-09-26 — user requested moving the logout button to the right side
  of the account area shown in the sidebar. 2026-10-06 — user requested reducing
  its height, grouping username and logout together, and adding a theme switch
  on the right. This supersedes placing logout at the row's far right.
- **Exceptions:** None recorded.

### Theme choice applies throughout the panel

- **Preference:** Provide a light/dark icon button in the account footer. Remember
  the selected theme in this browser and apply it before the page paints. Start
  with the system preference when there is no saved choice. Use the shared UI
  tokens for surfaces, text, controls and status colors in both themes.
- **Scope:** Admin, sign-in and setup pages; the control appears in signed-in
  account areas. The green setup illustration retains its product palette.
- **Source:** 2026-10-06 — user requested a theme switch on the right of the
  sidebar account area. Persistence and the initial system default are
  implementation choices supporting that control.
- **Exceptions:** None recorded.

### New workspaces start from the workspace dropdown

- **Preference:** Put a New entry in the admin sidebar workspace
  dropdown. Open a creation dialog from that entry and select the workspace
  after it is created.
- **Scope:** Workspace creation from the signed-in admin panel.
- **Source:** 2026-09-27 — user requested support for adding a workspace from the
  workspace dropdown.
- **Exceptions:** The first workspace remains part of the setup wizard.

### Workspace switching uses the panel's own dropdown

- **Preference:** Use a styled, accessible dropdown in the admin sidebar for
  switching workspaces. Show the selected workspace and a clear selected state in
  the menu, keep New as its final action, and support keyboard and
  outside-click dismissal.
- **Scope:** Signed-in admin sidebar workspace selector, on desktop and mobile.
- **Source:** 2026-09-28 — user shared the native workspace select menu and asked
  to use RepoDesk's own dropdown.
- **Exceptions:** The earlier allowance for native form selectors is superseded
  by the 2026-10-06 shared dropdown preference above.

### Agent skills use a compact search toolbar

- **Preference:** Place search and state filtering at the right of the catalog on
  desktop. Omit visible field labels, keep accessible names, and use a search icon,
  placeholder and clear action. Show matching results and an actionable empty state.
- **Scope:** Agent skills catalog search/filter controls. Search matches names,
  slugs and descriptions, ignoring case and extra whitespace.
- **Source:** 2026-10-07 — reimplementation request, interpreted using the supplied
  Agent skills screenshot and feedback: “improve the search and filter , remove
  the label, and improve search bar, move it to right side”.
- **Exceptions:** Controls wrap on narrow screens; form editor labels remain visible.

### Skill cards separate routine actions from version recovery

- **Preference:** Give skill cards a clear title/status header with management icons,
  separate purpose from version metadata, and group Publish and Test below the
  preview. Keep rollback controls in an expandable section with a labeled version
  selector, so recovery actions do not compete with everyday actions.
  Keep the management icons aligned as one group, with errors below the header.
  Explain unavailable enablement in plain language and show archived status.
- **Scope:** Skill catalog cards; keep the layout readable when controls wrap on mobile.
- **Source:** 2026-09-21 — user requested reorganizing the skill card, illustrated
  with the existing crowded action and rollback rows. The grouping above is the
  implementation interpretation of that request.
  2026-10-08 — user requested fixing the report skill card shown with a raw
  `publish_first` error and uneven icons. Aligned controls and readable state
  guidance are the implementation interpretation, scoped to skill cards.
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

- **Preference:** Combine member management and access requests in one page. Show
  Telegram names/usernames alongside numeric IDs, with role, membership and effective-access
  states in a searchable table. All active members can use the bot; omit whitelist
  controls, access modes and policy preview/apply actions.
- **Scope:** Workspace member and access management. Keep numeric IDs as the
  permission identity; display names come from Telegram interactions.
- **Source:** 2026-09-21 — user requested merging Allowed users and Members and
  adding Telegram usernames to members currently shown only as IDs.
  Updated 2026-10-07 — user requested removing the whitelist feature because all
  active workspace members can use the bot.
- **Exceptions:** Members with no known Telegram profile retain an ID fallback.

### Member switches sit beside their labels

- **Preference:** Show active membership as a switch aligned to the right of its
  label in the member dialog. Membership alone enables bot use; do not show a
  whitelist switch. Keep guidance about numeric Telegram IDs beside the ID field.
- **Scope:** Add and edit member dialogs in the admin panel.
- **Source:** 2026-09-27 — user asked to change the member checkboxes to toggles
  and move them to the right.
  Updated 2026-10-07 — user removed whitelist permission; retain only the active
  membership switch.
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

### Modal close controls use a plain X

- **Preference:** Use a plain X-shaped SVG icon without an enclosing circle for
  the modal header close button. Preserve the accessible name, hover title,
  keyboard focus, 44px hit target and pending-save dismissal lock.
- **Scope:** All admin modal header close controls, including nested dialogs.
- **Source:** 2026-10-05 — user requested an X-like SVG for modal close buttons,
  without a circle.
- **Exceptions:** The close glyph uses a simple inline SVG because the current
  Reicon set offers enclosed close icons. Other actions retain Reicon icons.

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

### Remove actions use a simple bin and a warning color

- **Preference:** Use a simple outline bin without a patterned basket for remove
  and delete icons. Use the existing red danger color and soft red hover background
  to make the destructive action clear.
- **Scope:** Admin remove/delete icon buttons, including coding repository rows.
- **Source:** 2026-10-05 — user requested a simpler bin and warning color for the
  coding repository remove icon.
- **Exceptions:** Preserve existing confirmations, accessible names and disabled
  states. Non-destructive actions keep their existing colors.

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
  on the page as saved labels, values and statuses, with an Edit action. Do not
  reuse the form as the normal display, including by disabling its controls.
  New and Edit may share a modal editor; display and editing remain separate.
  Provide a named dialog, trapped keyboard focus, Escape and visible cancel controls,
  focus return, mobile scrolling, and validation/errors inside the dialog.
  Cancel discards the draft; failed saves keep it open; pending saves block
  dismissal and duplicate submission.
- **Scope:** Add/create management flows across the admin app: members,
  workflows, skills/imports, instructions, runs, panel accounts,
  plugins, repositories/networks and GitHub Apps. Related repository, plugin,
  member, workflow, skill and instruction editors also use these dialogs.
- **Source:** 2026-09-20 — user requested preferring modals for Add actions
  across the app instead of inline forms.
- **Source update:** 2026-10-08 — user showed the Review Bot repository card
  with selectors, checkboxes and Save settings, and objected to using the same
  UI for display and editing. Show saved repository settings in a compact list
  or summary; open New/Edit in a modal.
- **Exceptions:** Sign-in/bootstrap, policy forms,
  workspace creation in the setup wizard, approval decisions and
  recovery controls stay on their pages. Field editing
  within a modal may remain inline. Applying repository/network changes edits
  a draft; the existing Save Code Truth step persists it. GitHub confirmation
  still takes place on GitHub. The policy-form exception does not cover saved
  repository policy records on plugin detail pages, including Review Bot.

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
  explain the next installation step. New Apps preselect Review Bot's PR/comment
  events, enable the operator-specific webhook for a public HTTPS domain and retain
  GitHub's generated secret without adding setup fields or a copy/paste step.
- **Scope:** GitHub App onboarding in setup and the workspace Plugins panel.
- **Source:** 2026-09-20 — user requested a button to create a GitHub App directly,
  referencing Coolify's guided setup. 2026-09-26 — user requested support for
  creating the App for a personal account.
  2026-10-08 — user requested webhook configuration by default for new GitHub setup.
- **Exceptions:** Existing Apps can still use manual environment/file configuration.
  Existing App settings are not rewritten. Local or non-HTTPS origins keep delivery
  inactive until a public HTTPS receiver is configured. Review Bot policies and
  verified member identities remain separate requirements.
  The setup wizard uses personal ownership and the default `repodesk` name without a
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
  Coding task rows use a solid Stop icon; their confirmation modal keeps visible text
  as specified above.
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

### Telegram PR messages offer Review and Merge

- **Preference:** Once a coding task has a confirmed PR, replace inline Status
  and Cancel with Review and Merge. Keep the PR actions on the progress message,
  final result, questions, blockers and requested status, including follow-up work.
- **Scope:** Telegram Reviewed and Direct coding task messages with a confirmed
  PR. Review opens the PR's changed files; Merge opens its GitHub page.
- **Source:** 2026-10-08 — user showed a waiting-for-input task message containing
  a PR link and requested Review or Merge for its inline buttons.
- **Exceptions:** Tasks without a confirmed PR retain existing Status/Cancel
  controls. GitHub handles review, merge permissions and merge confirmation;
  the links do not execute these actions in Telegram. Explicit task commands
  remain available. Notification permissions and chat/topic isolation still apply.
  2026-10-09 — the user requested PR write capability after a Telegram merge
  request could only read metadata. An explicit conversational merge/close request
  now creates a separate actor-bound approval with the exact PR and action;
  coding-task Merge links continue to open GitHub. Merge approvals show the target
  branch, method and head commit, and results explain confirmed outcomes or recovery.

### Telegram tasks show clear progress and outcomes

- **Preference:** Make it clear whether an accepted request is working, waiting
  for input, stopping, complete or failed. Longer coding tasks use short progress
  notices based on confirmed application/runner stages. Explain failures with a
  useful next step and identify when an administrator must act.
  Explain known failure causes with their saved repository and branch when relevant,
  rather than only asking the user to inspect the panel. Give the configuration
  location and next action for recovery; keep credentials and raw logs private.
  Acknowledge a stop request separately from confirmed termination when execution
  is still active.
  Maintain one task progress message, editing the acknowledgement as confirmed
  stages change, including checks, repairs and longer-stage updates. Keep native
  inline **Status** and **Cancel** controls on that message while applicable.
  Once a PR is confirmed, use [Review and Merge](#telegram-pr-messages-offer-review-and-merge).
  New messages belong to necessary questions, actionable blockers, user-requested
  status/input receipts and final outcomes. Routine progress must not flood the
  conversation or repeat command instructions. Close the progress message when
  waiting or finished so it does not imply ongoing work.
- **Scope:** Telegram assistant requests and Reviewed/Direct coding tasks for the
  invite-only friend and colleague beta; apply the same wording principles to
  corresponding admin task status.
- **Source:** 2026-10-06 — user endorsed clear progress, cancellation and failure
  feedback and requested an implementation plan before inviting friends/colleagues.
  2026-10-07 — user showed a successful Telegram coding task and requested inline
  status/cancel controls without repeated reminders, plus more natural progress
  follow-ups.
  2026-10-07 — user showed repeated check/repair notices and requested editing one
  progress message, with new messages only when useful, to keep Telegram conversational.
  2026-10-09 — user showed a generic Docket checkout failure and requested the
  detailed cause in the user-facing reply.
- **Exceptions:** Keep short private replies on native thinking previews without
  an extra immediate queued acknowledgement. Unaddressed group traffic stays
  silent. Revocation and destination policy can prevent a notification. Unknown
  remote outcomes require truthful uncertainty rather than a success or stopped
  claim. Execution quotas remain governed by the existing Codex preference.
  Native Stop remains the control for private streaming answers. Explicit commands
  remain available; long private queue notices also offer inline task controls.
  A confirmed deleted/uneditable progress message may be replaced once. An unknown
  original send must be reconciled before a replacement; retries of edits target
  the already-known message.

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
- **Scope:** Local Codex credentials. Shared provider records own the API URL/key;
  Codex chooses a provider/model in its configuration dialog. Existing deployment
  configuration and workspace keys remain compatibility fallbacks.
- **Source:** 2026-09-22 — user requested API key configuration in the web panel,
  superseding the earlier environment-only request for this credential.
  2026-09-29 — user requested local Codex execution only.
- **Exceptions:** None recorded.

### Codex authentication is selected per workspace

- **Preference:** Show custom provider API key and ChatGPT device-code sign-in as peer choices in the Codex configuration dialog. Show the device link, one-time code, connection status and disconnect action there.
- **Scope:** Local Podman Codex credentials for each workspace. Existing workspaces retain the custom provider method until changed. Show a clear sign-in-required state when automatic refresh cannot recover; explain that retained paused tasks continue automatically after connection. Routine task starts and token refreshes require no user confirmation.
- **Source:** 2026-09-29 — user requested device-code login at the same setting level as custom provider auth, configured through the UI for each workspace. 2026-10-05 — user approved persistent runner auth with temporary task credentials, automatic refresh and continuation after reconnect.
- **Exceptions:** Use trusted repository code with account credentials. Public and private repositories use the connected GitHub App for repository access independently of model authentication; custom provider credentials retain their deployment fallback.
- **Updated scope:** 2026-10-06 — user requested using the existing GitHub App connection for private repository access. Repository visibility does not select the model authentication method.

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

### Sign-in keeps the form visible until home is ready

- **Preference:** Keep the login card's heading, fields and entered values visible
  after submission. Disable duplicate submissions and show a spinner with
  “Signing in…” on the button through authentication, session and workspace
  loading, then enter home. Failures keep the form visible and allow retry.
- **Scope:** Admin sign-in; first-account creation uses the same pending-form
  behavior before entering setup.
- **Source:** 2026-10-06 — user reported an empty login card after clicking Sign in
  and requested button loading feedback followed by home.
- **Exceptions:** None recorded.

### Loading keeps the layout visible

- **Preference:** Show as much of the actual page as possible immediately: known
  headings, help text, sections, field labels, navigation and controls.
  Use skeletons only for values, fields or records that still need data, rather than
  replacing a page with a plain “Loading…” message. Keep loaded content visible
  during background refreshes. Disable actions that require unknown data; do not
  present unknown settings as disabled, disconnected, zero or empty.
- **Scope:** Admin and setup data-loading states, including the home Overview,
  Codex configuration, repositories and tasks. Skeletons use accessible region
  names/busy states and respect reduced-motion preferences.
- **Source:** 2026-10-05 — user rejected the “Loading Codex settings” message and
  similar text-only loaders, requesting visible elements with skeletons only where
  needed.
  2026-10-06 — user showed the home loader displaying an empty audit table and
  requested showing all known page elements, with skeletons only where loading is
  required. Select the page layout from the route and established permissions,
  independent of whether its data has arrived. Overview keeps its count cards,
  available connection cards and team configuration labels visible while loading.
- **Exceptions:** App startup uses only the centered RepoDesk logo and brand text
  while deployment status, session and workspaces are unknown; show setup or sign-in
  only after those checks finish. 2026-10-05 — user reported that a completed
  installation briefly shows the setup page when opening the app.
  2026-10-06 — user rejected the login illustration and empty card flashing on
  refresh. Keep the entire auth layout absent until startup resolves; startup
  failures use the neutral screen with retry rather than implying a signed-out
  session.
  2026-10-06 — user requested removing the startup skeleton card and keeping only
  the logo and text. This applies to the startup loader on desktop and mobile;
  data-loading skeletons within admin and setup pages retain the preference above.
  Explicit progress for an initiated action (saving, signing in,
  connecting GitHub) and actionable errors remain visible text.

### Skill import precedes creation

- **Preference:** Place Import before New in the page heading's action row.
- **Scope:** Agent skills at `/admin/skills`, on desktop and mobile.
- **Source:** 2026-10-06 — user requested moving the Import button before New in
  the Agent skills screenshot and named the `/admin/skills` route.
- **Exceptions:** None recorded.
