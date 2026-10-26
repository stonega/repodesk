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
| Plugin detail layout | [Shared plugin layout](#plugin-details-share-card-layouts-and-a-title-switch), [Codex sections](#codex-details-show-configuration-and-tasks-separately) |
| Integration setup input | [Discover resource identifiers](#connections-discover-resource-identifiers) |
| Code Truth setup | [URL and description](#code-truth-repositories-use-a-url-and-description) |
| Card spacing after content changes | [Content layout owns card spacing](#content-layout-owns-card-spacing) |
| Repository display | [Shared repository cards](#repository-cards-share-one-style), [member GitHub details](#member-github-columns-show-only-a-view-button), [connected repositories](#connected-github-repositories-stay-compact-and-directly-accessible) |
| Action labels and controls | [One action for opposite settings](#opposite-setting-actions-share-one-button), [card action placement](#card-actions-stay-at-the-top-right), [Edit/New labels](#edit-and-add-buttons-use-short-labels), [shared icons](#common-action-buttons-use-reicon), [dropdown styling](#dropdown-inputs-share-the-workspace-selector-style), [checkbox styling](#admin-checkboxes-share-a-clear-comfortable-style) |
| Dialog actions | [Cancel order](#modal-cancel-follows-the-primary-action), [close controls](#modal-close-controls-use-a-plain-x), [secondary actions](#dialog-support-actions-use-secondary-buttons) |
| Feedback and loading | [Toasts and error placement](#routine-action-confirmations-and-request-errors-use-toasts), [visible loading layout](#loading-keeps-the-layout-visible) |
| Log pagination and density | [Shared pagination and compact log text](#logs-reuse-run-pagination-with-compact-text), [refresh menu](#logs-use-an-auto-refresh-menu) |
| Telegram Mini App experience | [Official Telegram guidance](#telegram-mini-apps-follow-official-guidance) |

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

### Group access explains Telegram mention setup

- **Preference:** Keep the setup guide for direct @mentions on Groups & Members.
  Explain that the bot can remain a regular member: disable privacy mode through
  BotFather, remove and re-add the bot, relink the group and recheck visibility.
  Describe administrator access as an alternative and distinguish message
  visibility from the message collection setting.
- **Scope:** Groups & Members setup guidance before and after linking a group.
- **Source:** 2026-10-23 — after asking whether the bot must be an administrator,
  the user requested adding the regular-member setup guide to Group access.
- **Acceptance:** Keep the instructions readable during loading, empty, linked
  and error states. Show the fallback command/reply path and official Telegram
  reference. Check desktop/mobile, both themes, list wrapping and card spacing.
- **Source update:** 2026-10-23 — disabling privacy and re-adding the bot still
  left the user's group inactive. Explain that re-adding in Telegram does not
  restore the RepoDesk link; show a New → fresh /link command reminder on inactive
  saved groups and verify relinking removes it.
- **Source update:** 2026-10-23 — the user requested receiving group messages by
  default and removing the `/capture on` instruction from the link confirmation.
  New and relinked groups enable received-message collection. Explain the default
  in the command dialog, retain the Disable action and existing explicit opt-outs,
  and keep Telegram visibility checks separate from that saved choice.
- **Exceptions:** This guidance does not replace the requirement for the person
  redeeming a group-link command to be a Telegram group administrator.

### Opposite setting actions share one button

- **Preference:** Combine opposite actions for a single setting into one button
  whose label describes the available action from the saved state. For group
  message collection, show **Enable message collection** when off and **Disable
  message collection** when on. Keep the saved status readable separately.
- **Scope:** Group message collection on Groups & Members and comparable future binary settings
  presented as action buttons. Existing switches remain switches.
- **Source:** 2026-10-23 — user requested combining Consent to collection and
  Directed messages only because they control the same setting.
- **Acceptance:** Show one collection button; update its action only from saved
  data, block duplicate requests while saving or refreshing, keep the updated
  action keyboard-accessible, and retain the saved state and retry action after
  failure. Verify both states, pending/error recovery, card spacing and
  desktop/mobile in both themes.
- **Exceptions:** Independent actions such as rechecking visibility and unlinking
  remain separate. Group collection controls stay with their scope explanation
  inside the group's Edit dialog; these actions take effect immediately.

### Group management actions open from the card's Edit icon

- **Preference:** Show a borderless pencil icon at the top right of each saved
  group card. Open an Edit dialog for visibility rechecks, the collection action
  and unlinking. Keep the group name, ID, saved status and inactive-link recovery
  guidance on the card; keep the collection scope explanation with its controls.
- **Scope:** Saved group cards on Groups & Members and their management dialogs.
- **Source:** 2026-10-24 — user requested moving the card's actions into an Edit
  dialog and placing an Edit icon at the card's top-right corner.
- **Acceptance:** The saved card has one Edit icon and no inline management
  controls. Preserve current action semantics, saved-state refresh, pending locks,
  in-dialog error recovery, focus trapping/return and mobile wrapping. Inspect
  card and dialog spacing at desktop/mobile widths in both themes.
- **Exceptions:** New group linking continues to use the Groups section’s New action and
  its separate command dialog.

### Skills use direct saves and GitHub history

- **Preference:** Remove draft, publication and version management from the admin
  Skills flow. Recommend GitHub for editing, reviewing changes and managing history;
  retain import, source update review, instruction previews and enable/disable.
  Custom editors save instructions in one action without a separate publish step.
- **Scope:** Admin skill catalog, New/Edit, Markdown/GitHub imports and source updates.
- **Source:** 2026-10-22 — user requested removing version management and drafts from
  the admin panel and recommending that users manage skills through GitHub.
- **Acceptance:** No draft/publish labels, revision counts, version selectors or rollback
  controls in this flow. GitHub is the default recommended import source, with source
  links and reviewed updates. New imports remain disabled until enabled; saved edits
  and applied updates are ready for future runs. Existing run and schedule snapshots
  stay intact. Verify saved summaries and dialogs, spacing, loading/empty/pending/error
  states and keyboard recovery in both themes at desktop and mobile widths.
- **Exceptions:** Internal revisions protect concurrent saves and immutable snapshots
  support execution history and schedule pins. Telegram's consent flow may still
  propose an unapproved procedure; admins can review and enable it directly.
  Presets retain their read-only instructions and enable/disable actions.
- **Source update:** 2026-10-26 — after reviewing the limited value of the
  deterministic **Test skill policy** check, the user considered it unnecessary.
  Remove its catalog actions and persistent sample-input/result section.
- **Acceptance update:** Custom, imported and preset catalogs expose no policy-test
  action or sample-input form. Keep instruction previews and existing management
  dialogs usable, with no leftover footer, divider or card-edge spacing. Check
  saved, expanded, loading, empty and error states at desktop/mobile widths in
  both themes. This preference applies to the Skills UI; internal policy validation
  and diagnostic APIs remain available.

### Google OAuth setup links have copy actions

- **Preference:** Put a copy icon beside the callback URL and read scope in Google
  connection editors. Keep the full values readable and selectable, show a brief
  checkmark after copying, and provide manual-copy guidance if clipboard access fails.
- **Scope:** The shared Google Web application editor for Docs, Sheets, Drive, Gmail
  and Search Console on desktop and mobile. Reuse the shared URL rows and borderless icon buttons.
- **Source:** 2026-10-21 — user showed the Gmail callback URL and read scope and
  requested copy buttons for these links.
- **Acceptance:** Each button copies its exact value without submitting the form;
  verify keyboard access, 44px targets, wrapped URLs, success/reset and failure
  recovery in both themes at desktop and mobile widths.
- **Source update:** 2026-10-22 — user approved replacing the five expanded read
  scope rows with a short read-only access summary and a collapsed **OAuth scopes**
  section. Keep the callback URL visible and copyable; retain the exact scope
  values and their copy actions inside the disclosure for consent setup.
- **Acceptance update:** Scope URLs are hidden whenever the editor opens. Verify
  keyboard expansion/collapse, visible access summary, preserved credential drafts,
  copy recovery and spacing in both disclosure states at desktop/mobile widths.
  This preference changes presentation only; OAuth requests retain their scopes.
- **Exceptions:** External navigation links retain their existing behavior.

### Admin checkboxes share a clear, comfortable style

- **Preference:** Give checkbox choices one consistent appearance across the admin
  panel: rounded boxes, a clear SVG checkmark, visible keyboard focus and labels
  that form a comfortable click/tap target. Keep long labels aligned and readable,
  with distinct selected and disabled states in both themes.
- **Scope:** Admin and shared setup checkbox controls, including modal forms,
  permission choices, resource selection and skill imports.
- **Source:** 2026-10-20 — user requested improving checkbox UI in the admin panel.
  The rounded blue control, highlighted selection row and 44px minimum label
  target are implementation choices following the existing visual language.
- **Acceptance:** Verify label clicks and Space toggle the native input, keyboard
  focus remains visible, disabled choices cannot change, and pending forms retain
  their locks. Check wrapped labels, checked/unchecked/mixed states, desktop/mobile
  layouts and both themes. Honor reduced motion and forced-color settings.
- **Exceptions:** Existing member and plugin enable switches retain their switch
  appearance and placement. Checkboxes stay inside existing editors; saved records
  continue to use readable summaries under the modal-editor rule.

### Web search providers live in Model settings

- **Preference:** Manage DuckDuckGo, DeepSeek and Exa in a separate Search
  providers section on `/admin/model`. Choose the search provider in the bot chat
  model editor and show the saved choice in its summary. DuckDuckGo is a built-in,
  read-only preset available without creating a record; New offers keyed providers.
- **Scope:** Bot chat search configuration in setup and Model settings. Provider
  records belong to the operator; each workspace chooses its own provider.
- **Source:** 2026-10-20 — user requested a new search-provider section and
  selection in model settings, with free DuckDuckGo and keyed DeepSeek/Exa.
- **Source update:** 2026-10-20 — user requested DuckDuckGo as a preset so users
  do not need to add it themselves.
- **Acceptance:** Saved records contain no form controls or readable secrets.
  New/Edit use shared dialogs, dropdowns and actions. Verify DuckDuckGo is visible
  immediately, including during loading/error states, has no Edit/Remove action,
  and can be selected and saved without adding a provider or entering a key.
  Verify selection persistence, disabled search, pending/error recovery and
  readable desktop/mobile summaries.
- **Exceptions:** Setup retains its guided chat-model form. Search selection
  does not change Codex or Review Bot model settings.
  Previously saved DuckDuckGo records remain usable and manageable for compatibility.

### Google integrations share one plugin and Web application

- **Preference:** Show one Google catalog entry and detail page for Docs, Sheets,
  Drive, Gmail and Search Console. Reuse one registered Web application client,
  one callback URL and one Enable switch. Each member connects their own Google
  account in private Telegram; Search Console property selection belongs to that member.
- **Scope:** All built-in Google integrations on desktop and mobile.
- **Source:** 2026-10-21 — user requested merging all Google-related plugins into
  one and using the same registered Web application. This supersedes the
  2026-10-20 request for four independent product plugins.
- **Acceptance:** Verify a single catalog card, old links leading to the merged
  page, shared client/enablement, personal account isolation and existing Web client reuse.
  Saved summaries contain no forms; use shared modal, action, loading and toast
  components. Callback and individual scope copy actions remain available.
  Check desktop/mobile, both themes, pending/error recovery and card spacing.
- **Source update:** 2026-10-22 — user clarified that account connection belongs
  on the user side in Telegram and requested refactoring the plugin. The admin
  panel configures only the application; remove account connection/disconnection
  and personal Search Console selection controls from that panel.
- **Acceptance update:** Verify the saved application summary and modal at desktop
  and mobile widths, loading/empty/pending/error states, both themes and card spacing.
  Telegram offers connection/status/reconnect/disconnect and personal property
  selection. Browser consent requires confirmation by its initiating Telegram user.
  One user's account, selections and disconnect never grant or remove another's access.
- **Source update:** 2026-10-25 — after Gmail and Search Console failed because
  their APIs were disabled in the OAuth client's Cloud project, the user requested
  adding the enablement guide to the Google plugin page.
- **Acceptance update:** Keep a read-only guide on the detail page during
  loading, first setup, saved and error states. Link to all five API setup pages,
  explain selecting the OAuth client's project, and distinguish API enablement
  from sign-in/consent. Explain `SERVICE_DISABLED`/`accessNotConfigured`, propagation
  time and retrying Gmail or `/google properties`; reconnecting alone cannot
  enable an API. Check wrapping and card padding at desktop/mobile widths in both themes.
- **Exceptions:** Existing registered clients can be reused. Old workspace tokens
  and service-account credentials are retired and never become personal grants.

### Admin self-check lives in a corner chat popup

- **Preference:** Keep a self-check assistant in the admin panel's bottom-right
  corner. Opening its chat button shows a compact conversation popup, like a
  customer-support widget, with messages and a composer.
- **Scope:** Authenticated admin pages with a selected, authorized workspace, on
  desktop and mobile. The popup identifies that workspace, retains the conversation
  when minimized and clears it when the workspace or signed-in account changes.
- **Source:** 2026-10-19 — user requested an admin self-check agent at the bottom
  right with a conversation popup like a common customer-service panel.
- **Acceptance:** Verify corner placement, readable empty/conversation/findings
  states, pending and failure feedback, retry, close/Escape and focus return,
  keyboard input, mobile containment, both themes, and workspace isolation.
  Reuse the shared dialog and icon controls. Diagnostic findings remain readable
  summaries; the composer is for conversation, not configuration editing.
- **Exceptions:** This is a non-modal support conversation, so the rest of the
  panel remains usable. Minimizing is allowed during read-only checks; duplicate
  sends are disabled. Existing modal editor and pending-save locks still apply
  to configuration forms. It is absent from sign-in and the setup wizard.

### Telegram Mini Apps follow official guidance

- **Preference:** Follow Telegram's official Mini App design and platform guidance
  wherever applicable. Use mobile-first layouts, Telegram theme colors that update
  with the client, accessible controls and lightweight interactions. Respect the
  changing viewport, safe areas and content safe areas. Use Telegram's native
  navigation and action controls where they fit the flow; avoid duplicating the
  client's back/close controls or adding an action button to a read-only page
  without a purpose. Reuse backend services and suitable web components while
  adapting the Mini App presentation to Telegram.
- **Scope:** All RepoDesk Telegram Mini App pages, starting with the Codex
  task conversation/history viewer. Native Topics remain the primary conversation
  interface; the task viewer supplements them. This does not restyle the admin SPA.
- **Source:** 2026-10-18 — the user requested that our Mini App follow Telegram's
  official guidance as closely as practical. Platform details were checked against
  the [official Mini App documentation](https://core.telegram.org/bots/webapps),
  including its [design guidelines](https://core.telegram.org/bots/webapps#design-guidelines).
- **Acceptance:** Verify light/dark and live theme changes, compact/expanded
  viewports, safe-area spacing, long-history scrolling, back/close behavior and
  loading/empty/error states on mobile and desktop Telegram clients. Use only
  capabilities supported by the client, with appropriate fallbacks. Authenticate
  using server-validated Telegram initialization data and enforce task/audience
  permissions independently of the launch link. These are implementation checks,
  not a claim that a Mini App has been delivered or visually verified.
- **Exceptions:** Custom transcript and tool-activity rendering is appropriate
  where Telegram supplies no native equivalent. Record any deliberate departure
  with its reason and affected scope; preserve a usable fallback on older clients.

### Content layout owns card spacing

- **Preference:** When moving, removing or hiding a row, recheck the complete
  card's spacing, including its first and last visible content. Use a container
  gap for spacing between grouped summary rows and reset those rows' default
  margins so their position or presence does not add space at the card edges.
  Remove obsolete spacing rules and empty wrappers during the same change.
- **Scope:** Admin cards and grouped summaries changed by UI layout work, at
  desktop and mobile widths, including loading, empty, pending and error states.
  Check rendered spacing and add focused browser coverage for reported regressions.
- **Source:** 2026-10-18 — after the invite countdown moved into the title, the
  user identified leftover bottom space and requested prevention of this class
  of layout regression. Container gaps are the implementation choice.
- **Exceptions:** Deliberately different section spacing and prose margins may
  remain when explicitly scoped. Do not reset margins across every card globally.

### Code Truth repositories use a URL and description

- **Preference:** Ask only for the GitHub repository URL and an optional free-text
  description in the repository modal. Generate internal repository IDs
  automatically and show the GitHub repository name in saved cards. Replace the
  network/branch mapping editor with the description; follow the repository's
  default GitHub branch automatically. Saved descriptions remain readable text,
  with New/Edit opening the shared modal.
- **Scope:** Code Truth repository configuration and summaries, on desktop and
  mobile. Descriptions explain repository purpose and usage; they do not grant
  access or authorize actions.
- **Source:** 2026-10-18 — user requested replacing Networks and branches with a
  universal text description and removing the Repository ID input because users
  should not enter internal IDs. Default-branch indexing is the implementation
  choice supporting removal of branch settings.
- **Exceptions:** Internal MCP target/snapshot identifiers remain part of the
  service protocol and code provenance, outside the repository editor.

### Cloudflare uses API tokens directly

- **Preference:** Connect Cloudflare by saving a scoped API token. Keep the saved
  token status and resource names as summaries, with token and resource editors
  in shared modals. Recommend account API tokens for credentials independent of
  a user, linking directly to the account token dashboard. Keep scoped user API
  tokens supported and distinguish their discovery permissions in setup guidance;
  secrets stay write-only.
- **Scope:** Cloudflare setup and management on desktop and mobile. Account/domain
  restrictions and exact-action approvals still apply.
- **Source:** 2026-10-18 — after checking that Cloudflare client registration needs
  a separate bootstrap token, the user requested using the token directly.
  This supersedes the 2026-10-17 browser-authorization preference.
- **Source update:** 2026-10-19 — the user supplied Cloudflare's recommendation
  for account API tokens and the [account token dashboard](https://dash.cloudflare.com/?to=/:account/api-tokens)
  link, requesting that the plugin be updated.
- **Exceptions:** Existing OAuth connections retain backend compatibility until
  replaced. The panel guides them to an API token and does not offer new OAuth
  client setup. Replacement clears local OAuth credentials; operators revoke old
  authorizations in Cloudflare.

### Connections discover resource identifiers

- **Preference:** Minimize setup input by discovering identifiers and displaying
  provider account/resource names after saving credentials. Connect first;
  automatically select an account when it is the only authorized choice. Ask for a selection
  when several accounts are available. Offer searchable domain choices instead of
  requiring account and zone IDs to be copied from another dashboard.
- **Scope:** Cloudflare connection and configuration on desktop and mobile, and
  comparable future integration setup where the provider supports discovery.
  Saved resources remain summaries; selections are edited in a modal.
- **Source:** 2026-10-18 — user requested improving the Cloudflare flow and reducing
  input as much as possible after reviewing Cloudflare's account-selection consent.
- **Source update:** 2026-10-18 — direct API tokens replace the OAuth prerequisite.
  Discover account/domain names with the saved token where permissions allow.
- **Exceptions:** Restricted tokens without account-list permission may use explicit
  account and zone IDs through a manual editor. Discovery does not grant access
  to every returned resource: allowed domains require an explicit selection, and
  no domains means account resources only. The 2026-10-19 Cloudflare expansion
  adds account metadata beyond Pages while selected-zone access stays explicit.

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
  until replaced. Bot model capacity and prices are optional overrides.
  Provider records use New/Edit dialogs and saved summaries; the setup chat-model
  selector is a guided form. API keys are edited only on the provider record.

### Provider types supply automatic model information

- **Preference:** Check the provider type and fetch model prices and context
  information where the API exposes them. Show automatic information separately
  from optional overrides, with units and source labels. Retain cached/uncached
  input rates and both DeepSeek price tiers.
- **Scope:** Shared provider New/Edit dialogs, setup/chat editors and saved model
  summaries. OpenRouter, self-hosted New API and official compatible services use
  a standalone metadata module.
- **Source:** 2026-10-14 — user requested typed metadata discovery, DeepSeek's two
  price levels and a standalone module.
- **Exceptions:** APIs without prices/limits use labeled provider-specific catalogs
  or dated official reference values where available. Unknown stays unknown.
  New API requires the key's billing group and a public pricing endpoint. Peak is
  the conservative default; an explicit tier choice changes estimates. Blank
  context overrides defer enforcement to the provider. Existing modal, currency,
  guided-setup and verified-charge reconciliation rules still apply.

### Model setup activates the bot automatically

- **Preference:** Remove the separate Activate the bot step and card. Successfully
  saving the bot chat model activates the bot automatically once setup is ready;
  no second activation action is required.
- **Scope:** Authenticated workspace setup and Model settings. Model settings keeps
  provider/model summaries and modal editors. Access requests and membership stay
  in Members & access; Telegram account verification remains available in Operations.
- **Source:** 2026-10-12 — user showed the Activate the bot card and requested
  removing this step and automatic activation after successful model setup.
- **Exceptions:** A saved bot token, ready Telegram receiver and enabled published
  skill remain prerequisites. If they complete later, activation finishes
  automatically. Webhook registration stays explicit in Site domain; deployment
  pause, membership and external-action approvals retain their existing controls.

### GitHub App creation skips manual icon setup

- **Preference:** Continue from GitHub App creation to authorization without an
  icon download, upload instructions or an upload acknowledgement. Keep cosmetic
  branding out of the connection prerequisites.
- **Scope:** GitHub App creation in setup and Manage GitHub, including creation
  dialogs and the return from GitHub registration, on desktop and mobile.
- **Source:** 2026-10-08 — user requested adding our app icon when creating a
  GitHub App for a user.
- **Source update:** 2026-10-18 — after confirming GitHub's manifest cannot set the
  icon automatically, the user requested removing the unnecessary download and
  manual upload step. This supersedes the earlier guided branding requirement.
- **Exceptions:** Owners can customize their App directly in GitHub settings;
  RepoDesk does not prompt for or require that customization.

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
- **Scope:** Scheduled workflow cards and their detail pages for all authorized
  panel administrators, on desktop and mobile.
- **Source:** 2026-10-08 — user requested improving card content, adding a workflow
  detail page and updating related APIs, with a screenshot of the workflows page.
  The labeled summary layout is the implementation choice for that request.
- **Exceptions:** Workspace boundaries still apply. Display recurrence previews
  as previews when a workflow is not active.

### Panel administrators manage workflows without Telegram linking

- **Preference:** Treat authorized panel administrators as workflow managers.
  Show full saved workflow details and New, Edit, approval and lifecycle actions
  without requiring their personal Telegram identity to be linked.
- **Scope:** Workflow lists, details and modal editors, including deployment
  operators before Telegram linking. This does not change Telegram command access.
- **Source:** 2026-10-21 — user rejected the read-only workflow notice because
  the web panel is for administrators who already have management permission.
- **Acceptance:** At desktop and mobile widths, an unlinked administrator can
  open details, create/edit in modals, approve and control schedules. Remove the
  read-only notice and its spacing. Keep saved summaries separate from editors,
  pending locks, retained failed drafts and actionable errors.
- **Exceptions:** Execution still uses an active Telegram member's permissions.
  Existing workflows retain that owner. New private schedules use their active
  recipient; new group schedules use the linked administrator's membership or
  an active workspace owner/admin. Destinations, repositories, versions, skills
  and team budgets are rechecked through the existing execution policy.

### Workflow budgets follow team settings

- **Preference:** Configure per-run and monthly spending limits only in the team
  settings. Scheduled workflows inherit those limits without a separate budget
  field, summary row or default spending cap.
- **Scope:** Workflow lists, details, New/Edit dialogs and Telegram proposals;
  both scheduled and manually triggered workflow runs.
- **Source:** 2026-10-21 — user requested removing the workflow's default $0.10
  budget and following the team's global settings.
- **Acceptance:** Verify saved summaries and New/Edit contain no workflow budget
  control or value at desktop/mobile widths, with no leftover gap from the removed
  row. Existing workflows must also follow the team limits on future dispatches,
  including None and zero. Preserve modal editing and pending/error behavior.
- **Exceptions:** Historical run snapshots and approval evidence remain intact.
  Team spending limits and normal run accounting still apply.

### Repository cards share one style

- **Preference:** Use one shared repository card for names, badges, external
  GitHub links and management actions. Share its muted surface, border, rounded
  corners, typography and spacing throughout the app. Compact lists use the
  same card frame; managed records add their saved details below the heading.
- **Scope:** Groups & Members GitHub detail dialogs, Manage GitHub,
  Codex, Review Bot and Code Truth repository summaries, on desktop and mobile
  in both themes. Long names wrap inside the card; link and action controls keep
  accessible names, focus styling and comfortable touch targets.
- **Source:** 2026-10-08 — user requested a unified repository card style across
  the app after the member repository preview/modal change.
- **Exceptions:** Codex and Review Bot have no plugin repository lists as of
  2026-10-12. Repository selectors elsewhere retain their shared dropdown style.
  Task references remain part of task summaries. Context-specific details,
  compact connection previews and New/Edit modal behavior remain applicable.

### Member GitHub columns show only a View button

- **Preference:** Show only a visible View text button in each member's GitHub column.
  Use blue text with no border or filled background at rest, themed hover feedback,
  visible keyboard focus and a comfortable touch target.
  Open account/profile information, verification or connection status, sync time
  and the complete saved repository list with permission labels in a read-only,
  scrollable modal. Keep account details and repository previews out of the table
  so repository counts and long names do not expand its rows.
- **Scope:** The Groups & Members table and its GitHub details, on desktop and
  mobile in both themes. Reuse shared repository cards and the modal's close,
  Escape, focus and scrolling behavior. Unlinked accounts still have View and show
  Not linked in the dialog; unknown/loading data must not imply that status.
- **Source:** 2026-10-08 — user showed a member row stretched by its full repository
  list and requested five entries with a modal to show all repositories.
- **Source update:** 2026-10-10 — user showed the member table and requested only
  a View button for GitHub column data, replacing the five-entry preview.
- **Source update:** 2026-10-14 — user showed the member row and requested changing
  View to a text button. This styling preference applies to the member GitHub column.
- **Exceptions:** Member New/Edit dialogs retain their GitHub account selector.
  The workspace connection modal retains its separate expandable-list preference.

### Member forms fetch GitHub account choices

- **Preference:** Include a GitHub account field in member forms and automatically
  fetch available accounts from the workspace's connected GitHub installation.
  Show the saved account and a profile link in the form and member GitHub detail
  dialog, opened from View in the member table.
- **Scope:** Add/Edit member dialogs and the Groups & Members table. Organization
  installations supply organization members; personal installations supply their
  owner directly. Do not derive member choices from repository metadata. Allow
  entering a custom GitHub username alongside fetched choices, including when
  directory lookup fails. Resolve it when saving and retain unverified status.
- **Source:** 2026-10-07 — user showed the GitHub column and requested the missing
  edit-form link and automatic GitHub member fetching.
- **Source update:** 2026-10-14 — user requested the personal owner directly,
  organization members from the API, no repository metadata, and custom usernames.
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
- **Source update:** 2026-10-09 — the mobile-sidebar retry also requested improving
  the version-label position on mobile. The mobile admin header's right edge is
  the chosen placement, keeping the label and update action clear of page content.
- **Exceptions:** At mobile widths, admin pages put the version in the persistent
  header; sign-in and setup put it in a normal-flow footer. Desktop retains the
  bottom-right label. Toasts and dialogs may cover the label while open.

### Mobile navigation opens as a left-side sheet

- **Preference:** Keep mobile page content immediately visible. Open sidebar
  navigation from a menu button as a left-side sheet over the page, with a dimmed
  backdrop, rather than stacking navigation above the content. Keep workspace,
  navigation and account controls together and scrollable on short screens.
- **Scope:** Signed-in admin navigation at widths up to 800px. Reuse the shared
  modal focus boundary, plain X close control and themed surfaces. Escape,
  backdrop taps, route changes and workspace selection dismiss the sheet.
- **Source:** 2026-10-09 — retry of “improve the sidebar on mobile， work as a
  left side sheet, not on top” and “Also the version label position on mobile”.
- **Exceptions:** Desktop retains its persistent sidebar. Sign-in and guided
  setup retain their existing layouts. The sheet is navigation, not a record
  editor, and has no Save/Cancel action row.

### Available updates open release notes from the version indicator

- **Preference:** When GitHub has a newer stable release, show an indicator
  immediately after the application version. Clicking it opens a modal containing
  the changelog, update notes and an explicit update action. Keep the visible
  circle, arrow and status dot compact and balanced with the small version text;
  retain a 44px tap target and visible keyboard focus.
- **Scope:** Shared signed-in admin/setup shell at desktop and mobile widths.
  Preserve the muted responsive version placement and shared modal close, focus, pending
  lock and primary-action-then-Cancel behavior.
- **Source:** 2026-10-09 — user requested automatic GitHub release checks, an
  indicator after the version and a modal to update with changelogs/update notes.
- **Source update:** 2026-10-10 — user showed the version/update control and asked
  for a smaller, more harmonious update icon ("更协调").
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
  optional workspace spending controls remain separate.
- **Source:** 2026-10-09 — user rejected the fixed eight-tool-call limit after two
  Telegram PR-review requests exhausted it.
- **Exceptions:** Permission checks, actor/tenant boundaries, cancellation,
  approval pauses, request timeout and provider limits still apply. Internal
  summarization and follow-up classification remain tool-free; test/evaluation
  callers may deliberately bound tool execution.

### Assistant model calls have no workspace quota

- **Preference:** Remove Model calls per run from saved summaries, editors,
  settings storage and ordinary assistant execution. Do not retain hidden saved
  overrides. Run and monthly USD budgets default to None, meaning no limit;
  clearing either field restores None. Keep an entered zero distinct from None.
- **Scope:** Workspace configuration and Pi requests, including follow-up
  classification and conversation compaction.
- **Source:** 2026-10-12 — user requested completely removing Model calls per run
  and making run/month budget defaults None with no limit.
- **Exceptions:** Explicit saved dollar caps still apply. Permissions,
  cancellation, deadlines and provider limits remain. Internal tool-free
  summary/classification passes and evaluation callers may bound their own calls.
  Historical run snapshots remain audit evidence and do not impose call quotas.

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
- **Scope:** Codex coding tasks in the plugin, on desktop
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
- **Scope:** Historical coding repository selectors, removed on 2026-10-12.
  This rule still applies to comparable repository selectors elsewhere.
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
  44px action targets and clearance from the version/update control (above the
  desktop footer, below the mobile admin header). Use a
  descriptive accessible retry name and readable connection-error wording.
  Applies to shared admin toasts in both themes at desktop and mobile widths.
- **Exceptions:** Field/form validation errors, saved readiness warnings, ongoing
  progress and setup guidance stay beside their relevant controls. Dialog errors
  stay inside the open dialog so they remain visible and keyboard-accessible.
  Copy-link feedback retains its brief check icon as specified below.
  Errors use alert semantics and a red status icon, distinct from confirmations.

### Card actions stay at the top right

- **Preference:** Put the card's management action at the top-right inside its
  padding, opposite the title. Keep the action right-aligned on mobile and let
  long titles wrap in the remaining space. Related subsection actions follow
  the same placement beside their subsection heading.
- **Scope:** Site domain and Operations cards, and comparable management cards
  in subsequent UI work. Status badges stay with their title.
- **Source:** 2026-10-14 — user showed the Admin panel address card and requested
  its button at the top-right, then requested the same rule on Operations.
- **Exceptions:** Dialog submit/cancel controls follow the modal action rules;
  contextual links and result-specific controls stay with their content.

### Edit and add buttons use short labels

- **Preference:** Use exactly “Edit” for edit buttons and “New” for add/create
  entry buttons, including hover titles. Let the surrounding section or row
  identify the object instead of repeating it in the visible label.
  Labeled New buttons include a plus icon before the text, using the shared
  IconButton component.
- **Scope:** Admin and setup surfaces, including plugin configuration,
  repositories, members, skills, workflows, workspace creation and domain
  configuration.
- **Source:** 2026-10-05 — user requested “Edit” or “New” for Edit/Add buttons
  throughout the app, instead of labels such as “Edit Codex configuration”.
- **Source update:** 2026-10-14 — user requested adding a plus icon to the New
  button label while updating Site domain and Operations card actions.
- **Exceptions:** Screen-reader names may identify the target to distinguish
  repeated controls. Dialog headings stay descriptive; save, approval, sign-in
  and other consequential submit actions retain their specific labels.

### Plugin cards are a compact catalog with separate details

- **Preference:** Show an Installed section with Code Truth, Codex and registered
  local extensions. Keep the Markets discovery section hidden, including its
  heading, package cards, catalog links and source footnote.
  Keep each card to a name, short purpose and status. Open a dedicated detail
  page from the whole card for settings, actions, file information and source
  links.
- **Scope:** Workspace Plugins page and its plugin detail routes. Market entries
  are discovery links; they do not imply installation or runtime compatibility.
- **Source:** 2026-09-29 — user requested Installed cards for Code Truth and
  Codex, a market featuring popular Pi extensions, and simple cards that open
  plugin detail pages.
  2026-10-23 — user requested hiding the Markets section shown on Plugins.
  This supersedes the earlier request to display market cards; existing direct
  market detail routes remain available.
- **Exceptions:** New remains a labeled action in the Installed heading.
  The Installed grid has no trailing skeleton after the built-in cards while
  registered extensions load. Source: 2026-10-07 — user requested “remove this
  additional skeleton loader at end” beside Code Truth and Codex. This exception
  applies to the catalog grid; plugin detail loading retains its skeletons.

### Codex details show configuration and tasks separately

- **Preference:** Show a compact configuration summary with an Edit action opening
  a dialog, followed by coding tasks. Remove the repository list and its management
  actions; GitHub owns repository access.
- **Scope:** Codex plugin detail page on desktop and mobile.
- **Source:** 2026-09-29 — user requested separate configuration, repository and task
  cards. 2026-10-12 — user removed the extra repository permission layer in Codex
  and Review Bot in favor of GitHub's native permissions.
- **Source update:** 2026-10-17 — the user approved removing Reviewed and using
  one continuous Codex task workflow, explicitly without legacy compatibility.
  Remove the execution-mode selector and mode badges from both saved summaries
  and editors.
- **Source update:** 2026-10-18 — the user requested removing the publication
  checkbox and enabling publication by default. Omit the publication control and
  its saved Enabled/Disabled row. Verified implementations publish PRs ready for
  review automatically; saved opt-outs must not remain hidden overrides.
- **Exceptions:** Task repository references remain in task summaries.
  Analysis/questions remain read-only. Passing checks and current GitHub authority
  are still required for publication.

### GitHub owns Codex and Review Bot repository permissions

- **Preference:** Do not duplicate GitHub repository permissions with plugin
  repository lists, Add/Edit/Remove controls, maintainer grants or review-owner
  selection. Explain GitHub access in the saved configuration summary. Keep
  workflow choices in one plugin-wide modal editor.
- **Scope:** Codex and Review Bot on desktop and mobile. Codex uses GitHub's default
  branch; verified user permissions govern requested work and App installation
  permissions govern automatic reviews.
- **Source:** 2026-10-12 — user described the repository permission controls as
  overdesigned and requested GitHub's existing permission system.
- **Exceptions:** Workspace membership, tenant connection scope, action approvals,
  model credentials, webhook settings and task controls remain separate concerns.
  Code Truth's repository/index configuration is outside this request.

### Plugin details share card layouts and a title switch

- **Preference:** Use the Codex detail layout as the reference for installed
  plugins: compact configuration summaries and separate cards for repositories
  and operational details where applicable. Place the Enable switch at the right
  of the page title with space between them. The switch saves independently;
  configuration editors focus on the remaining settings. Codex and Review Bot
  omit repository cards and configure their workflows once for the plugin.
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
- **Scope:** Historical Add/Edit coding repository dialogs; these controls were
  removed on 2026-10-12 in favor of native GitHub permissions.
- **Source:** 2026-09-29 — user showed the Add coding repository dialog, asked to
  fix its UI issues, and requested Telegram usernames in the user list.
- **Exceptions:** When no username is known, show the numeric Telegram ID alone.

### Completed Codex tasks show PRs ready for review

- **Preference:** Successful Codex publication leaves the PR ready for review and
  uses matching language in settings, task status and Telegram results.
- **Scope:** Codex tasks in the plugin; verified follow-ups
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
  choice; after verified repository connection, open the workspace directly
  without a welcome modal or another confirmation action.
  Keep detailed GitHub controls in Plugins and show that page to the deployment
  administrator even before Telegram account linking. Keep optional workspace
  policies in Workspace settings, and detailed model management in
  the admin panel.
- **Scope:** Authenticated setup at `/setup`, including desktop and mobile.
- **Source update:** 2026-10-18 — user requested removing the Welcome to RepoDesk
  modal. Successful GitHub repository connection now opens the workspace directly,
  superseding the earlier confetti and Get started requirement.
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
  Model capacity and token prices are independently optional overrides.
  A published enabled skill and a ready Telegram receiver
  remain activation requirements. Owner-only Telegram actions require separately
  linking a personal Telegram account.

### Completed setup stays out of navigation

- **Preference:** Hide the Setup navigation entry once deployment setup is
  complete. Show it for an inactive deployment so the operator can resume setup.
- **Scope:** Deployment navigation in the desktop sidebar and mobile navigation
  sheet. Use the server's activation state; administrator creation alone does
  not complete setup. Keep the entry absent until that state is known.
- **Source:** 2026-10-14 — user showed the Deployment sidebar and requested
  hiding Setup when setup is completed.
- **Exceptions:** New workspace still opens the guided setup wizard from the
  workspace dropdown. Direct setup URLs remain available. Deployment pause
  does not make setup incomplete.

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
  same records those pages list. Show conversation threads, scheduled workflows and
  coding tasks as distinct totals so active Codex work is easy to find.
- **Scope:** Workspace Overview for deployment administrators and linked members.
- **Source:** 2026-09-28 — user showed zero Runs and Workflows cards despite live
  bot work and asked for pages with details.
  2026-10-17 — the requested thread-list refactor changes the primary history
  count to conversations; individual request counts remain within each thread.
- **Exceptions:** Deployment administrators can read all workspace run messages
  and manage workspace workflows without linking Telegram. Individual run recovery
  actions retain their existing identity requirements.

### Thread summaries open a continuous conversation

- **Preference:** List continuous conversation threads, grouping their requests by
  saved thread identity. Keep cards compact, with the subject, latest preview,
  request count, last activity and status. Show saved Telegram names, usernames
  and user IDs; group conversations also show the group title/ID, topic ID and
  participants. Use explicit ID fallbacks when profiles are unavailable.
  Open a dedicated thread page from the whole item, with requests and assistant
  replies in chronological order and conversation statistics at the top. Keep
  execution transcripts, tool data and controls behind each request's Run details
  link. Preserve independent list and request pagination through detail/back
  navigation, refreshes and browser history. Fetch bounded summary and message
  pages. Place pagination below the list, after its loading or empty state when
  there are no cards to display.
- **Scope:** Threads in the workspace admin panel, on desktop and mobile. Overview
  counts conversation threads and links to the same list.
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
  2026-10-17 — user clarified that runs are individual requests, requested a thread
  list for continuous chats and asked to show Telegram user and group information.
  This supersedes request-level cards as the primary history list.
- **Exceptions:** Deployment administrators and eligible workspace owners/admins
  can read every retained run message in their workspace, including private runs.
  Telegram linking is unnecessary for deployment administrators to view messages;
  execution and mutation controls retain their existing authorization requirements.
  Older requests without a valid retained thread and scheduled requests remain
  separate, clearly labeled entries. Never infer continuity from a shared user,
  group, topic or timestamp. Only saved profile data supplies display names; no
  Telegram history/profile lookup is implied. Existing run-detail URLs remain valid.

### Run details lead with statistics

- **Preference:** Show a compact statistics summary at the top of each run detail
  page, before messages and technical metadata. Include messages, tool calls,
  model attempts, token usage, cache hit rate and recorded spend with readable
  labels and units. Keep the labels visible during loading, and distinguish
  missing or partial usage from a measured zero.
- **Scope:** Individual request/run detail pages, on desktop and mobile. A run
  represents one request; a thread is a continuous conversation spanning runs.
  Thread details reuse the summary layout for all retained requests, counting
  conversation requests/replies separately from execution tool checkpoints.
- **Source:** 2026-10-17 — user requested basic run statistics at the top, including
  messages, tool calls, tokens and cache ratio, and clarified that the current
  run list represents requests rather than continuous chat threads.
  The subsequent thread-list refactor retains individual run diagnostics and
  shows aggregate statistics on continuous conversation pages.
- **Exceptions:** Aggregate only retained run data. Cache hit rate uses cached
  reads divided by all input tokens, including cache reads and writes. Usage and
  spend include follow-up and compaction attempts when recorded; unavailable
  provider usage or charges must not appear as zero.

### Logs reuse run pagination with compact text

- **Preference:** Use the shared Runs pagination component inside the logs data
  card, below the table and outside its horizontal scrolling area. Show blue
  previous/next chevrons around a compact current range, with regular 14px text
  and a soft blue hover background on the arrows. Omit the separate Page label.
  Keep log rows at 12px, readable details and 44px action targets.
- **Scope:** Runtime logs in the admin panel at desktop and mobile widths.
- **Source:** 2026-10-10 — user showed the logs table's lone downward arrow,
  requested reusing Runs pagination and allowed a smaller font size.
  2026-10-10 — user requested moving pagination inside the data card and supplied
  a compact arrow/range reference, superseding the outside-card placement and
  range/page summary.
- **Exceptions:** Logs use cursor pagination and have no total count; show the
  current range rather than inventing the reference's total. Filters, search and Latest
  logs return to the first page; automatic refresh pauses on older pages.

### Logs use an auto-refresh menu

- **Preference:** Replace the auto-refresh checkbox with a compact gray
  “Auto-refresh: 1m” menu trigger. Offer Every 10 seconds, Every 30 seconds,
  Every minute, Every 5 minutes and Off, with a checkmark beside the selection.
  Put Refresh now with a refresh icon below a divider in the same menu; default
  to one minute. The Latest logs shortcut uses an outline clock to communicate
  recency, with its descriptive accessible name and hover title; a lone upward
  arrow is too ambiguous for returning to the newest entries. Support keyboard
  navigation, Escape and outside-click dismissal, visible focus and 44px targets.
- **Scope:** Runtime logs on desktop and mobile; reuse the shared dropdown surface.
- **Source:** 2026-10-10 — user supplied the Auto-refresh menu in
  `Screenshot From 2026-10-09 16-33-01.png` as the replacement for the five-second
  checkbox.
  2026-10-12 — user requested a more accurate Latest logs icon because the upward
  arrow was confusing. The outline clock is the implementation choice.
- **Exceptions:** Older pages pause automatic refresh regardless of the selected
  interval. Refresh now reloads the current page; Latest logs returns to the first
  page. In-flight requests disable Refresh now and pause the timer to prevent overlap.

### Run attempts use a horizontal timeline

- **Preference:** Present model attempts as numbered steps connected from left to
  right, with time, status and reserved/actual costs in compact cards. Use the
  detail page's full content width and contain horizontal scrolling within the timeline.
- **Scope:** Attempts in run detail pages, on desktop and mobile.
- **Source:** 2026-10-06 — user showed the run modal's long vertical Attempts list
  and requested a horizontal timeline.
- **Exceptions:** Other record lists keep their existing layouts.

### Team currency is managed in Settings

- **Preference:** Let administrators set the team's preferred currency on
  `/admin/settings`. Show the saved currency and explanation in a card, with one
  Edit action opening a focused modal using the shared dropdown.
- **Scope:** Team currency in Workspace settings. This is the assistant's default
  when a request and its sources leave currency unspecified. Preserve explicit
  source currencies; budget and usage accounting continue to use USD.
- **Source:** 2026-10-25 — user requested support for setting team currency in
  `/admin/settings`.
- **Acceptance:** Existing teams show USD. Cancel discards changes, failed saves
  retain the draft, pending saves lock dismissal and duplicate submission, and
  conflicts offer current-settings recovery. Check saved display, editor,
  loading, pending and error states at desktop/mobile widths in both themes.
- **Exceptions:** Model-price currency remains an independent price override.
  Changing team currency does not convert monetary amounts or fetch exchange rates.

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
  confirmation. Team currency has its own Settings card and focused editor.
  Model capacity is available in deployment Model settings.

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
- **Exceptions:** Setup steps retain their guided forms. Bot activation follows
  successful model setup automatically when its prerequisites are ready; there is
  no separate activation card or action.

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

### Skill previews keep settings and tools compact

- **Preference:** Keep expanded instruction previews dense and readable. Show
  setting labels above their values in a responsive grid and required tools in
  a wrapping list of small tags. Use a short empty-workflow message instead of
  a full detail row. Avoid a wide label column, nested separators and a tall
  single-column tool list. Preserve readable instructions and comfortable action
  targets.
- **Scope:** Preset and custom skill catalog previews in Agent skills, on desktop
  and mobile in both themes. Keep management actions at the top right and saved
  summaries separate from modal editors.
- **Source:** 2026-10-15 — user showed the expanded Team recap preview and asked
  to improve its UI because it wastes too much space. The grid and wrapping tags
  apply that feedback to comparable skill previews.
- **Exceptions:** Long instructions and populated dependent workflows retain
  their complete readable content; compactness must not truncate saved details.

### Preset skills use enable/disable only

- **Preference:** Show preset skills as read-only saved instructions with a Preset
  badge and one enable/disable action. Omit Edit, Archive, Publish, Test, revision
  metadata and version recovery. Hide the policy sample form when the catalog
  page contains only presets.
- **Scope:** Built-in starter skills in Agent skills, including unchanged legacy
  presets. Custom, conversation-created and GitHub-imported skills keep their
  existing editors and version management. Previously customized legacy entries
  retain custom controls so their saved work remains usable.
- **Source:** 2026-10-14 — user requested removing version management and editing
  for preset skills and supporting only enable/disable. The Preset badge and
  omission of unrelated management actions apply that instruction to the cards.
- **Exceptions:** Read-only instruction and dependent-workflow previews remain
  available. Internal revisions and runtime pins still protect concurrent changes
  and execution history. This supersedes the version-recovery rule for presets.

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
- **Scope:** Group cards on Groups & Members; IDs remain the binding and permission identity.
- **Source:** 2026-09-21 — user requested group names on the group cards.
- **Exceptions:** Groups with no known title use their ID as the heading.

### Groups, members and access share one page

- **Preference:** Combine Telegram group management, members and access requests on one
  **Groups & Members** page with one sidebar entry. Put each New action beside
  its Groups or Members section heading and retain separate modal editors. Show
  Telegram names/usernames alongside numeric IDs, with role, membership and effective-access
  states in a searchable table. All active members can use the bot; omit whitelist
  controls, access modes and policy preview/apply actions.
- **Scope:** Workspace group, member and access management. Keep numeric IDs as the
  permission identity; display names come from Telegram interactions.
- **Source:** 2026-09-21 — user requested merging Allowed users and Members and
  adding Telegram usernames to members currently shown only as IDs.
  Updated 2026-10-07 — user requested removing the whitelist feature because all
  active workspace members can use the bot.
- **Source update:** 2026-10-24 — user requested merging Members & access and
  Group access into one page named Groups & Members. Existing links continue to
  open the combined page; member pagination must not hide the linked group.
- **Acceptance:** Verify one sidebar link and page title, both saved sections and
  their separate dialogs, preserved workspace/query parameters on old links,
  independent member pagination and group loading/retry, and desktop/mobile
  spacing in both themes.
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

- **Preference:** Show the plus icon together with the visible “New” label beside
  the Members heading, so the creation action is clear within its section. The
  accessible name remains “Add member”.
- **Scope:** The Members section heading on Groups & Members.
- **Source:** 2026-09-27 — user asked to change the plus-only header control to a
  button with an icon and label.
- **Exceptions:** None recorded.

### Shareable access links use a card and copy action

- **Preference:** Display the Telegram invite URL as monospace text in a
  regular card with a copy icon button, rather than as a read-only input. After a
  successful copy, show a check icon for one second, then restore the copy icon.
  Do not show a separate success message. Refresh the displayed invite link
  automatically every 10 seconds and show a small animated circular countdown
  immediately after the card title, without a separate visible countdown text row.
  Keep the timing and refresh/paused status accessible to screen readers and on hover;
  respect reduced-motion preferences. Explain that opening it
  grants regular membership immediately and that each token works for one Telegram
  account. Keep the current link visible during refresh and offer Retry on failure.
  Keep the card's vertical padding balanced, with no extra bottom margin after
  its final guidance paragraph.
- **Scope:** The shareable invite link in Groups & Members → Access requests.
- **Source:** 2026-09-27 — user requested a common card and copy icon button for
  the link shown in the access-request section. 2026-09-28 — user requested a
  one-second done icon in place of the “Link copied.” message.
  2026-10-10 — user requested a monospace font for the access-request link.
  2026-10-14 — user requested automatic membership without approval, one account
  per token, and a link that updates every 10 seconds with a countdown.
  2026-10-15 — user requested replacing “New link in 7s” with an animated circle
  after the invite card title. This placement applies to this card.
  2026-10-18 — user requested removing the extra space below the invite card's
  guidance text.
- **Exceptions:** Ordinary access requests without an invite still need approval.
  The countdown controls the displayed link; copied links remain valid for 24 hours.

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
- **Scope:** Telegram group-linking instructions returned by `/linktoken` and
  commands generated in the admin panel.
- **Source:** 2026-09-20 — user requested code formatting for the generated link command.
- **Source update:** 2026-10-22 — user requested obtaining a group-link token from
  the admin panel, like member invitations, and using it with `/link` in the group
  instead of first verifying a personal Telegram identity.
- **Acceptance:** The Groups section offers New to open a shared dialog that generates
  a complete, copyable command. Show its one-use lifetime, pending/error/expired
  states, copy feedback and recovery. Keep saved groups as readable summaries;
  verify the handoff and summary on desktop/mobile in both themes. An authorized
  panel admin can generate the command without a linked Telegram identity; the
  sender must be an active workspace member and a Telegram group administrator.
  The dialog detects successful linking, hides the consumed command and returns
  keyboard focus to the saved group when its New trigger becomes unavailable.
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
  plugins, repositories and GitHub Apps. Related repository, plugin,
  member, workflow, skill and instruction editors also use these dialogs.
  Operations shows service/deployment status and action results as readable
  summaries; panel account creation, identity verification, access recovery and
  run inspection open focused dialogs. Deployment pause/resume uses confirmation.
- **Source:** 2026-09-20 — user requested preferring modals for Add actions
  across the app instead of inline forms.
- **Source update:** 2026-10-08 — user showed the Review Bot repository card
  with selectors, checkboxes and Save settings, and objected to using the same
  UI for display and editing. Show saved repository settings in a compact list
  or summary; open New/Edit in a modal.
  2026-10-10 — user requested refactoring `/admin/operations` to replace inline
  forms with summaries and modal editing.
- **Exceptions:** Sign-in/bootstrap, policy forms,
  workspace creation in the setup wizard, approval decisions and
  recovery controls outside Operations stay on their pages. Field editing
  within a modal may remain inline. Applying repository changes edits
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
  validation errors. Model capacity comes from catalog metadata, an explicit
  operator configuration; blank context windows defer enforcement to the provider.
  Automatic output allowances for unknown models are identified as app policy;
  cost budgets are independently configurable. Do not hide
  arbitrary pilot caps behind a generic `invalid_request`.
- **Scope:** Workspace execution limits and model configuration in the admin panel.
- **Source:** 2026-09-20 — user approved replacing unexplained fixed ranges with
  model-aware validation and clear field feedback.
- **Exceptions:** Operational retention and scheduling policies may keep documented
  fixed limits; identify them as application policies, not model capabilities.

### Model capacity and prices are optional overrides

- **Preference:** Make context window, maximum output and both token prices
  independently optional. Clearing a field restores automatic handling. Known
  models use catalog metadata; distinguish unknown prices from explicit zero.
- **Scope:** Model selection and advanced settings in setup and the admin panel.
- **Source:** 2026-10-12 — user requested making all four model settings optional.
  The user clarified that the provider should handle context limits when the
  context window is blank; do not substitute an app context-window cap.
- **Exceptions:** Unknown models use a documented automatic output allowance,
  not a claimed provider capability. Finite dollar budgets require known prices; missing prices
  leave costs unavailable instead of treating the provider as free. Explicit capacity
  overrides must leave room for input.

### Model prices have a selectable currency

- **Preference:** Let operators select the currency of model price overrides and
  show its code with saved prices. Use the shared dropdown in the existing model
  editor; keep entered prices when switching currency.
- **Scope:** Bot chat model prices in setup and Model settings. Existing prices
  default to USD. Non-USD prices include an explicit positive USD exchange rate;
  saved summaries show that rate. Currency changes clear the previous rate.
- **Source:** 2026-10-13 — user requested support for setting model-price 币种.
- **Exceptions:** Catalog prices, budgets and usage accounting remain in USD.
  Only entered overrides use the selected currency; prices remain optional.
  Exchange rates are operator-entered and retained until edited, with no automatic
  exchange-rate lookup.

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

### Telegram feels like a warm work buddy

- **Preference:** RepoDesk speaks as a dependable, approachable work partner,
  with a little energy and personality. Match the person's language and formality;
  “小伙伴”, “buddy” or a supplied name may fit naturally, without becoming a
  mandatory greeting. Use occasional light humor or emoji when the mood fits.
  Keep useful answers direct, and make fixed progress and failure notices sound
  conversational too. Maintain the model's personality in
  [SOUL.md](../../src/agent/SOUL.md), loaded into the assistant system prompt.
- **Scope:** Telegram model replies in private chats, groups and scheduled
  reports, plus application-generated task and request notices. This preference
  changes wording, not message layout, controls, delivery timing or authorization.
- **Source:** 2026-10-18 — user requested a livelier, friendlier personality as a
  work partner, suggested “小伙伴” / “buddy”, then authorized implementation of
  a dedicated soul document and its prompt integration.
- **Exceptions:** Respect personal tone preferences and formal output formats.
  Keep scheduled reports restrained. Failures, risks and approvals stay calm,
  precise and actionable, without jokes or celebratory emoji. Warmth does not
  permit unsupported progress claims or bypass permission and privacy rules.
  Fixed notices keep their existing English language; model replies follow the
  conversation's language. Native desktop/mobile Telegram rendering and live
  model tone still require pilot acceptance.

### Telegram PR messages offer Review and Merge

- **Preference:** Once a coding task has a confirmed PR, replace inline Status
  and Cancel with Review and Merge. Keep the PR actions on the progress message,
  final result, questions, blockers and requested status, including follow-up work.
- **Scope:** Telegram Codex task messages with a confirmed
  PR. Review opens the PR's changed files; Merge opens its GitHub page.
- **Source:** 2026-10-08 — user showed a waiting-for-input task message containing
  a PR link and requested Review or Merge for its inline buttons.
- **Exceptions:** Tasks without a confirmed PR retain existing Status/Cancel
  controls on the latest confirmed update, following
  [latest task controls](#codex-task-controls-stay-on-the-latest-message).
  GitHub handles review, merge permissions and merge confirmation;
  the links do not execute these actions in Telegram. Explicit task commands
  remain available. Notification permissions and chat/topic isolation still apply.
  2026-10-09 — the user requested PR write capability after a Telegram merge
  request could only read metadata. An explicit conversational merge/close request
  now creates a separate actor-bound approval with the exact PR and action;
  coding-task Merge links continue to open GitHub. Merge approvals show the target
  branch, method and head commit, and results explain confirmed outcomes or recovery.

### Codex task controls stay on the latest message

- **Preference:** Show Status/Cancel on only the latest confirmed Codex task
  message in its audience. After a newer message is delivered, remove these
  controls from older messages without changing their text. Editing an older
  progress message must not restore its controls. Keep the previous controls
  until the new message is confirmed; a failed/unknown send cannot remove the
  user's existing controls.
- **Scope:** Native Telegram Codex task acknowledgements, progress, questions,
  blockers, status replies and outcomes, separately per task, actor, bot and
  chat/topic. A terminal message can leave no Status/Cancel controls.
- **Source:** 2026-10-18 — the user showed repeated Status/Cancel keyboards under
  consecutive Codex runner messages and requested buttons only on the latest update.
- **Acceptance:** Consecutive confirmed updates leave at most one Status/Cancel
  keyboard for the task. Failed/pending sends preserve the old keyboard. Verify
  removal retries/restarts, concurrent delivery, older progress edits, revoked
  actors and task/bot/chat/topic isolation. Removed controls cannot authorize stale
  callbacks. Native desktop/mobile rendering remains a live acceptance check.
- **Exceptions:** The existing Review/Merge links on confirmed PR messages and
  unrelated URL links retain their own rules. Separate tasks
  retain separate controls. Telegram rejection of an old edit may leave a stale
  visible keyboard, whose callbacks must remain revoked; never replace that old
  message or repeatedly resend the new update to remove it.

### Telegram tasks show clear progress and outcomes

- **Preference:** Make it clear whether an accepted request is working, waiting
  for input, stopping, complete or failed. Longer coding tasks use short progress
  notices based on confirmed application/runner stages. Explain failures with a
  useful next step and identify when an administrator must act.
  Explain known failure causes with their saved repository and branch when relevant,
  rather than only asking the user to inspect the panel. Give the configuration
  location and next action for recovery; keep credentials and raw logs private.
  When a GitHub account connection is required, explicitly tell the person to
  send `/github` in the bot's private chat, follow the authorization link, return
  to confirm the account, then resend the request. Use this guidance in both
  conversational tool-failure replies and coding-task failure notices.
  Acknowledge a stop request separately from confirmed termination when execution
  is still active.
  Maintain one task progress message, editing the acknowledgement as confirmed
  stages change, including checks, repairs and longer-stage updates. Keep native
  inline **Status** and **Cancel** controls on the latest confirmed task message
  while applicable, following [latest task controls](#codex-task-controls-stay-on-the-latest-message).
  Once a PR is confirmed, use [Review and Merge](#telegram-pr-messages-offer-review-and-merge).
  New messages belong to necessary questions, actionable blockers, user-requested
  status/input receipts and final outcomes. Routine progress must not flood the
  conversation or repeat command instructions. Close the progress message when
  waiting or finished so it does not imply ongoing work.
- **Scope:** Telegram assistant requests and Codex tasks for the
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
  2026-10-18 — user showed a missing-GitHub-connection reply and requested clear
  instructions to connect the account through `/github`.
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
- **Scope:** Local runner Codex credentials for each workspace. Existing workspaces retain the custom provider method until changed. Show a clear sign-in-required state when automatic refresh cannot recover; explain that retained paused tasks continue automatically after connection. Routine task starts and token refreshes require no user confirmation.
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
  hostname and the routing instructions needed to connect the site. Include the
  current Mini App URL with a copy control under Telegram in **Update connected
  services**, alongside the provider setup guidance.
- **Scope:** Deployment-wide admin site address; restricted to deployment operators.
- **Source:** 2026-10-05 — user requested custom-domain setup for the admin panel
  site inside the admin panel.
  2026-10-18 — user requested adding the Mini App URL to Update connected services.
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

### GitHub skill imports select sources and review updates

- **Preference:** Accept GitHub links in the import modal, discover the included
  skills and let the user choose them. Show saved repository/ref/path on each
  imported card, with update review in a modal and an explicit replacement choice
  when a draft has local edits.
  Label the saved card's GitHub action **Source**, with an external-link icon and
  the same secondary button styling as **Check for updates** beside it.
- **Scope:** GitHub-backed instruction skills in Agent skills, including private
  repositories connected to the workspace. Existing modal, saved-summary and
  pending-action rules apply on desktop and mobile.
- **Source:** 2026-10-14 — user requested GitHub skill imports, connected private
  repository support, multi-skill detection and updates when the source changes.
  Selection and draft-update review are the implementation interpretation.
  2026-10-23 — user requested replacing Manage on GitHub with Source, adding an
  external-link icon and matching the adjacent update button's style.
- **Acceptance:** Source remains a keyboard-accessible link to the saved GitHub
  file in a new tab. Both actions share typography, height, padding, colors and
  hover treatment; keep their spacing and wrapping usable on desktop/mobile in
  both themes. Preserve the update dialog and archived update restriction.
- **Exceptions:** Source update checks are deliberate skill operations, so their
  labeled card action is permitted by the rule against routine refresh buttons.
  Source uses a native link with a Reicon icon to preserve browser navigation.

### Skill import lists show names only

- **Preference:** Keep each discovered skill to its selection checkbox and name.
  Open the description, source path, import issue, instructions and supporting
  files from the name, instead of repeating them below every row.
- **Scope:** GitHub skill discovery inside the import modal. Saved catalog cards
  and source-update comparisons retain their existing information and controls.
- **Source:** 2026-10-20 — user requested showing only the skill name in each
  list item to keep the skill list short, following the GitHub import discussion.
  A read-only details dialog is the implementation choice.
- **Acceptance:** Rows contain only the checkbox and name at desktop/mobile
  widths. Selection and keyboard access still work; details preserve selection,
  show unavailable reasons and return focus to the name. Pending imports lock
  selection and detail actions. Remove the old row padding and empty wrappers.
- **Exceptions:** A file without readable name metadata uses its containing
  folder's name, or `SKILL.md` for a repository-root file. Full paths and duplicate
  names can be distinguished in details. Unavailable skills keep details accessible.

### Codex runtime is configurable in the admin panel

- **Preference:** Allow the deployment operator to select Docker
  or OpenSandbox from the Codex details page, with an option to
  follow the environment-variable default. Show the effective runtime and source
  as saved values; edit in the shared modal. Clearly identify deployment-wide scope.
- **Scope:** Codex runtime configuration on desktop and mobile. Host services,
  sockets, images and secrets remain deployment configuration; the panel verifies
  readiness before changing the runtime and preserves active/retained task state.
- **Source:** 2026-10-17 — user requested admin-panel configuration in addition to
  environment-variable selection; the user subsequently removed microsandbox
  from scope after the VPS prerequisite check, then explicitly requested removal
  of Podman support.
- **Exceptions:** An unavailable runner cannot accept a saved panel selection.
  Switching the effective engine waits until retained task environments are cleaned.
