# Implementation evidence

## Unified Groups & Members page (2026-10-24)

The sidebar has one **Groups & Members** destination at `/admin/members`. It
combines Telegram group management, the searchable member table and access requests,
with a New action beside each management section and separate existing dialogs.
The group mention setup guide follows these sections. Old `/admin/chats` and
`/admin/access-policy` links redirect here while preserving workspace and query
parameters. Member pagination never pages the workspace's single linked group.

Group and member loads, errors and retries remain independent. Simultaneous
section errors stack without covering each other's recovery controls. Known
sections remain visible during loading; saved summaries stay separate from editors.
Closing the group-link dialog restores keyboard focus after its refresh, to New
or the saved group's Edit action. Documentation, examples and the UI preference
record use the combined page name. No dependency, API or migration was added.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and **1,190
deterministic tests across 130 files** passed with isolated PostgreSQL. All **53
final browser scenarios** passed across admin, group, combined-page and navigation
suites; member GitHub, invite-link and repository suites also passed. Checks cover combined navigation, legacy links, workspace/query preservation,
independent loading/retry, saved summaries, modal editing, focus and card spacing
at 1280px and 390px in both themes. Rendered saved, editor, loading, empty, pending
and error states were inspected. No deployment was performed.

## Google account confirmation retains its private topic (2026-10-24)

Google consent started in a private Telegram topic now persists that topic in
the personal OAuth flow. The browser callback queues account confirmation in the
same topic; it previously defaulted to General, leaving a successful browser
sign-in awaiting an easily missed confirmation. Existing flows without a saved
topic retain their previous destination. No dependency or migration was added.

The deterministic consent/confirmation journey covers both ordinary private chats
and native topics, checks the outgoing Telegram topic, and retains wrong-member,
workspace-switch and replay checks. The topic case reproduced the defect before
the fix; all 18 Google integration checks pass afterward. The correction is local;
VPS inspection was read-only and did not confirm an account or send messages.
See the [incident record](../../postmortem/2026-10-24-google-confirmation-topic.md).

Validation: lint, strict TypeScript, production build and the host Node runtime
contract passed. The full deterministic run with isolated PostgreSQL completed
1,190 cases: 1,189 passed and one unrelated coding-reference test exceeded its
five-second timeout. That case passed in 405 ms on a focused rerun with a
20-second timeout. No live Google or Telegram actions were used for verification.

## Group management in an Edit dialog (2026-10-24)

Saved Group access cards show the group name, ID and current status with a
borderless pencil icon at the top right. **Edit group** contains the visibility
recheck, collection toggle and unlink actions alongside their scope explanation.
Actions take effect immediately; saved status refreshes in both places. Pending
requests and refreshes lock dismissal and other controls. Request errors and a
failed-refresh retry stay inside the dialog; keyboard focus returns to Edit on
close. Inactive cards retain their relinking guidance, and long names wrap while
the Edit icon remains aligned. The setup guide and user documentation point to
the new dialog. No dependency or migration was added.

Validation: lint, strict TypeScript, build and **1,189 deterministic tests across
130 files** passed with isolated PostgreSQL. All **22 group browser checks**
passed, covering action recovery, pending locks, keyboard navigation, saved
summaries, loading/empty states, long names and unknown titles. Card/dialog
screenshots were inspected at 1280px and 390px in both themes, including pending
and error states. These initial local checks used no live Telegram actions.

VPS follow-up: the user-authorized deployment installed source tree
`435eb33600b278edf3dba13ebee3e9e80f260230`, based on `7ddfd76`, in bundle
`1792808351773-02844639` (package v0.1.44). Exact-image Node, CPU transcription,
offline Code Truth, Compose readiness, migration rerun and backup/restore checks
passed. The full browser run passed 382 scenarios; two stale catalog assertions
were updated for the seventh built-in plugin and passed on rerun. The test-only
correction is retained separately with the build snapshot.

App, worker, runner and Code Truth are healthy. Public and loopback health,
readiness, admin and versioned assets return HTTP 200; all 45 packaged artifacts
and served JavaScript/CSS hashes match the tested images. Configuration, secrets,
persistent volumes, PostgreSQL and the separate Actions runners were preserved.
The protected pre-release backup verified successfully. See the
[deployment record](vps-deployment.md#group-management-dialog-deployment-2026-10-24).

## Local Qwen3-ASR voice transcription plugin (2026-10-23)

Added a disabled-by-default workspace plugin for Telegram voice notes, audio
messages and audio documents. The owning deployment operator enables it from
Plugins → Qwen3-ASR; enablement starts the pinned Qwen3-ASR-0.6B download in the
background. Status, bounded polling and explicit download retry are available in
the shared plugin layout. Cached public weights persist in the shared Compose
volume and are reused after restarts or disable/re-enable. No SQL migration or
Node dependency was added; the app image includes an isolated CPU Python runtime.

The guarded attachment path supplies source-labeled transcripts to Pi and
text-authorized Codex requirements. It preserves actor/destination/bot/retention
checks, duplicate ingress handling, cancellation and existing write authorization.
Audio is limited to two minutes and 5 MiB per file. Decoding and inference use
process pipes and memory; inference is offline and serialized across the shared
cache. Downloads are fixed to a public model/revision. Credentials are excluded
from the child environment, and no raw audio is stored in the model cache or logs.

Validation: Biome, strict TypeScript, production build, Node runtime contract,
**1,189 deterministic tests across 130 files**, **111 focused development/plugin
tests**, and **four desktop/mobile browser journeys** passed. Saved, loading,
pending, downloading, ready and failed states were inspected in light/dark themes;
card actions and mobile clearance have regression assertions. The app Docker image
built, Compose validated, and Node 24 plus the installed Qwen/PyAV runtime passed.
The real pinned model downloaded, survived container recreation and reused cached
weights without network access. A public upstream WAV sample and its OGG/Opus
conversion transcribed successfully with networking disabled, including through the
Node subprocess bridge. Live Telegram acceptance and production deployment remain
outstanding. See [implementation and setup](transcription.md),
[user guide](../user/audio.md) and [runnable journey](../../examples/telegram-audio.md).

## Codex reference snapshots and application blockers (2026-10-23)

The worker prepares other workspace-selected repositories explicitly named in
authenticated task inputs as commit-pinned references before intake. Full names,
GitHub repository links and unique short names resolve separately from the
modification target. Every contributor needs verified source read access. Source
snapshots retain connection/repository generations and provenance; preparation
uses a separate Contents-read token that never enters durable job/state data or
Codex. Work and repair retain their pins; product answers can add sources, while
new intake revisions resolve their default branches again. Publication remains
scoped to the original target. No dependency or database migration was added.

The result protocol distinguishes missing reference/environment prerequisites
from product questions. Application blockers record an explicit failure without
creating another user question. Actual product questions retain the durable
waiting/answer flow. Pi sees source/blocker state and is told that task conversation
cannot replace preparation with an unpinned fallback. Historical waiting tasks
require an authorized continuation after upgrading all runner components; they
are not automatically replayed. See the [incident](../../postmortem/2026-10-23-codex-reference-source-question-loop.md)
and [runnable journey](../../examples/codex-reference-sources.md).

Local validation passed Biome, strict TypeScript, the production build, Node runtime
contract, **1,177 deterministic tests across 128 files**, and **168 final focused
collaboration/runner tests**. Coverage includes the reported short source name and
historical continuation, source read-only grants, revocation during preparation
and before publication, transient lookup recovery, immutable commit pins,
duplicate dispatch, real Git checkout despite a newer branch tip, reference
integrity and credential erasure. The cancellation fixture now publishes its
request trace atomically to prevent readers observing partial JSON.

The task and supervisor images built successfully and passed the real Docker
smoke, including prepared reference paths/commits and credential isolation, real
pinned Codex sandbox restrictions, OCR source proof, continuation, restart and
publication fences with fake external services. Merged Compose configuration
validated. Both incident repositories are selected on the VPS and the requesting
member has read access. The initial implementation checks did not deploy or
continue the live task.

Operator-authorized VPS deployment completed later on 2026-10-23 from commit
`b4bac2e15e7083f7800cc0a36813a11ed8187483` (package v0.1.44), bundle
`1792747504017-26715920`. The exact four deployment images passed Node 24 runtime,
Code Truth real-index/MCP and Docker Codex lifecycle/reference smoke checks.
Archive/source checksums, the protected database backup and deployed artifact
hashes verified. App, worker, runner and Code Truth are healthy; public health,
readiness and admin endpoints return HTTP 200. The original task remains waiting
at revision 4 with no live attempt; deployment did not replay it. Live model
interpretation after an authorized continuation remains unverified.

## Plugins hides Markets (2026-10-23)

The Plugins landing page omits the Markets heading, discovery cards, catalog links
and source footnote. Its description now focuses on installed extensions, and the
obsolete section spacing is removed. Installed cards, registration and existing
direct market detail routes remain available. This supersedes the 2026-09-29
catalog layout below. No dependency or migration was added.

Focused browser checks cover desktop/mobile loading, empty, saved and failed-load
states, retry recovery, absence of market links and trailing section margins.
Screenshots were inspected at both widths in light and dark themes.
Validation: lint, strict TypeScript, production build, **1,163 deterministic tests**
with isolated PostgreSQL and **19 browser checks** passed. No deployment was made.

## Codex patch output preserves UTF-8 across pipe chunks (2026-10-23)

The trusted job command helper now decodes stdout and stderr as UTF-8 streams.
Multibyte characters split across subprocess output chunks remain intact in
exported Git patches and diagnostics. Explicit command environments, output
limits and publication authority checks remain unchanged. No dependency or
migration was added. The VPS incident reached successful independent checks but
failed to apply a corrupted patch before any GitHub write; the original work is
retained. See the [incident and recovery boundaries](../../postmortem/2026-10-23-codex-publication-utf8-patch.md).

Deterministic regressions force one-byte fragments, round-trip a multilingual
patch through Git's index/worktree and verify diagnostics, line callbacks and a
real subprocess. Restoring the previous decoder reproduces the failures. The
correction is local; deployment and recovery of the historical task remain
outstanding.

Validation: Biome, strict TypeScript, production build, the Node runtime contract
and **1,163 deterministic tests across 127 files** passed using an isolated
PostgreSQL container. No production state or GitHub publication was changed.

## Telegram forwarded reference handoff (2026-10-23)

Telegram ingress retains all four forward-origin variants and marks original
text/captions as quoted reference content. Original commands and mentions cannot
execute bot controls or act as the forwarding member. Explicit requests replying
to a forward receive its text and supported media from the reply payload, including
when ordinary collection did not previously retain the message.

A human forward received within one minute of the same member's latest directed
request can enter the existing tool-free follow-up classifier in the same
bot/group/topic, even while the request is queued or running. Ordered execution
keeps in-flight snapshots intact; an earlier answer can arrive before the forward
is processed. Accepted candidates continue the request; unrelated forwards remain
silent. Duplicate updates, source retention, closed attention, cancellation and
current membership boundaries are enforced. No dependency or migration was added.

Validation: lint, strict TypeScript, production build, the Node runtime contract
and **1,151 deterministic tests across 126 files** passed with isolated PostgreSQL.
Regressions cover the reported mention → forward-during-answer sequence, duplicate
ingress, worker reconstruction, classifier isolation and quiet rejection,
replied-to content/media, original command suppression and sender/topic/bot/access
boundaries. Live Telegram/model acceptance and deployment remain outstanding.
See [group examples](../../examples/group-conversations.md).

## Codex authenticated checkout handoff (2026-10-23)

The coding handoff now names the application-authenticated repository and pinned
base commit, explains the intentional detached checkout and retains checkpoint
work. It tells Codex to use that snapshot when repository instructions request a
pull, instead of attempting network Git without credentials and reporting an
account connection failure. New remote-source requirements remain explicit
application-side blockers; arbitrary authenticated in-turn fetch/pull is not added.
Preparation and publication keep their separate scoped GitHub tokens. See the
[confirmed cause and limits](../../postmortem/2026-10-23-codex-redundant-git-pull.md).

Validation: Biome, strict TypeScript, production build and **1,144 deterministic
tests across 126 files** passed with isolated PostgreSQL. Regression coverage
checks all ordinary prompt modes, pinned metadata, retained work, repair-plan
preservation and missing-metadata fallback. No dependency, migration or deployment
was added. Live model adherence after deployment remains unverified; production
inspection was read-only.

## Default group collection and mention setup (2026-10-23)

New and relinked Telegram groups enable received-message collection and record
the verified linking administrator and time. The panel command dialog and legacy
private link-token response explain the default before redemption. The link
confirmation no longer instructs administrators to run `/capture on`. Existing
saved collection choices stay unchanged until explicitly edited or relinked;
administrators can still disable collection, and directed requests continue.

Visibility checks use current Telegram privacy and group-administrator status.
They no longer change the saved collection setting. Enabling collection is separate
from Telegram delivery: only received messages can be retained, and old history
remains unavailable. Actor, tenant, group ownership, token lifetime, issuer
revocation, duplicate-update and collection opt-out boundaries remain enforced.

Group access includes a persistent **Group @mentions** guide covering the
regular-member BotFather setup, removal/re-addition, mandatory relinking and
visibility recheck. Inactive saved groups show the New → fresh `/link` recovery
instruction. The guide explains the administrator alternative, fallback
commands/replies and collection setting, with Telegram's official reference.

Validation: lint, strict TypeScript, production build and **1,143 deterministic
tests across 126 files** passed with isolated PostgreSQL. All **16 group browser
checks** passed, including inactive-to-linked recovery, default-collection dialog
copy, opt-out controls, pending/error recovery, keyboard navigation and card
spacing. Desktop/mobile layouts at 1280px/390px were inspected in both themes.
No dependency, migration or deployment was added. Live diagnostics confirmed
privacy disabled, regular-member bot status and a restored active group link;
no production setting or Telegram message was written by this task.

## One group message collection action (2026-10-23)

Group access shows one collection button: **Enable message collection** when off,
**Disable message collection** when on. Saved status remains visible separately;
pending requests and refreshes disable the action, and failed writes keep the
saved state available for retry. Existing visibility, consent, authorization and
retention behavior is unchanged. No dependency or migration was added.

Validation: lint, strict TypeScript, build and **1,139 deterministic tests across
125 files** passed with isolated PostgreSQL. All 12 focused group browser checks
passed, including both toggle directions, duplicate submission prevention,
refresh locks, failed-write recovery, reload persistence and keyboard access.
Desktop/mobile screenshots were inspected in both themes for saved, pending and
error states, with card spacing and overflow checks. No deployment or live
Telegram action was performed.

## Panel-generated Telegram group linking (2026-10-22)

**Group access → New** generates a complete, copyable `/link@bot TOKEN` command
in a shared dialog. The owning deployment operator needs no personal Telegram
identity verification. An active workspace member who is a Telegram group admin
redeems the command; the dialog detects the linked group and the page shows its
saved name, ID and access summary. The operator can manage visibility, collection
and unlinking through the panel without an identity link.

Commands are bot-bound, single-use and valid for ten minutes. Only their hashes
are stored; replacement invalidates older group tokens, and redemption rechecks
the issuer's current authority. Existing membership, Telegram administrator,
tenant, exclusive group ownership, pause/deletion and collection-consent checks
remain enforced. Legacy private `/linktoken` commands remain actor-bound. No
dependency or migration was added. See [the API example](../../examples/group-linking.http)
and [the group guide](../user/groups.md).

Validation: lint, strict TypeScript, build and **1,139 deterministic tests across
125 files** passed with isolated PostgreSQL. All 21 focused browser checks passed
across group linking, shared copy controls and sidebar navigation. The eight group
checks were rerun after the mobile pending-layout correction and passed, including
overflow assertions. Desktop/mobile screenshots were inspected in both themes for
saved displays, command dialogs, loading/empty, pending, error and expired states.
Live Telegram acceptance and VPS deployment remain outstanding; no live messages,
group binding, account verification or production configuration was changed.

## Default-enabled Obsidian organization notes (2026-10-22)

Existing and new workspaces receive an independent managed vault, enabled by
default without credentials, a desktop process or a migration. Native Markdown,
properties, aliases, tags, tasks, links/backlinks, templates, daily notes, Canvas
and Bases files are available through three bundled Pi tools and the plugin panel.
Saved summaries, modal editors, recoverable Trash, bounded ZIP import and native
vault export share the current admin components. Desktop Obsidian renders native
maps/views; live synchronization, Publish and community-plugin execution remain
outside the implementation. See [behavior and limits](obsidian.md),
[user guide](../user/obsidian.md) and [runnable examples](../../examples/obsidian.http).

All active members can read shared notes; owner/admin mutations require an
interactive run. Tenant, run, actor, execution-fence and current permission checks
run inside the workspace transaction. Revisions protect concurrent edits, native
validation makes imports atomic, and durable call receipts prevent duplicate
daily-note appends. Disable/re-enable invalidates retained history, derived
answers, skill-source reads and pending delivery. Workspace deletion purges notes.
The added `fflate` dependency provides portable ZIP handling; no deployment
configuration or filesystem mount is required.

Validation: lint, strict TypeScript, production build, **1,139 deterministic tests
across 125 files** with isolated PostgreSQL, and the Node runtime contract passed. Four focused
browser journeys passed at 1280px/390px. Saved displays, New/Edit, import/Trash,
loading/empty, pending/error recovery and both themes were visually inspected.
Native desktop Obsidian rendering and live Telegram/model acceptance remain
staging checks. No deployment, account connection or external message was performed.

## Direct skill saves and GitHub history (2026-10-22)

Admin Skills recommends GitHub for instruction changes and history, with GitHub
as the default recommended import source and **Manage on GitHub** links on saved
imports. Removed revision counts, Publish draft, version selectors and rollback
controls. Custom New/Edit uses **Save skill**; Markdown/GitHub imports save skills
ready to enable, and reviewed source changes use **Apply update**. Imports remain
disabled until explicitly enabled; edits and source updates preserve enablement.

Saves and source updates validate and approve an immutable execution snapshot in
one transaction. Existing run and workflow pins remain intact. Legacy unpublished
entries can be reviewed and enabled directly, while conversation-source validity,
preset restrictions, optimistic revisions, duplicate-source checks and workspace
permissions remain enforced. Legacy publish/rollback API actions are retained for
compatibility without panel controls. No schema migration or dependency was added.

Saved cards remain readable summaries, with modal editors, toast feedback and
layout-preserving loading. Card spacing uses container gaps; obsolete version and
rollback styles were removed. Updated the skill design, scoped UI preference,
English user guide and runnable workflow/API examples.

Validation: **1,104 deterministic tests across 122 files** and **52 browser
scenarios** passed, including new direct-save, snapshot preservation, stale-save,
legacy enablement, missing-source and duplicate-import checks. Biome, strict
TypeScript, production build and the packaged Node runtime contract passed for
the skill changes. Desktop/mobile (1280px/375px), light/dark saved summaries and editors, loading/empty/pending/error states, GitHub update review,
keyboard recovery and card spacing were inspected. GitHub used deterministic
fixtures; no live integration change or deployment was performed.

## Compact Google OAuth setup (2026-10-22)

The Google Web application editor keeps its callback URL visible and copyable,
summarizes read-only access in one sentence, and starts with **OAuth scopes**
collapsed. Expanding it reveals all five exact permission identifiers with the
existing copy controls and manual-copy recovery. Credential drafts survive
expansion/collapse; authorization requests and required grants are unchanged.
Setup documentation and the scoped UI preference describe the new presentation.

Validation: lint, strict TypeScript and production build passed. **1,101
deterministic tests across 121 files** passed with disposable PostgreSQL, plus
**15 focused browser scenarios** for Google and the shared URL controls. Checks
cover default collapse, keyboard toggling, copying every scope, draft retention
and copy failure. Saved summaries, collapsed/expanded editors, loading/empty,
pending/error states and spacing were visually inspected at 1280px/390px;
summaries and both disclosure states were checked in light/dark themes.
No dependency, migration or deployment was added.

## Review Bot Standards and Spec assessments (2026-10-22)

Review instructions now call for surrounding implementation, affected callers,
contracts and relevant tests, with merge-base comparison for suspected regressions.
Defect candidates need a supported trigger, reachable path and consequence, and are
checked against existing safeguards. Criteria now follow the linked Matt Pocock
code-review skill's separate Standards and Spec assessments: documented rules are
cited, design heuristics are advisory and repository choices override them. Spec
checks cite requirements and explicitly skip when no usable source exists. PR commit
messages are available through the pinned read-only source tool for reference
discovery. New finding output requires an axis; inline and unanchored publication
preserve it, while historical results without axes remain compatible. The model
uses two passes in one session, not isolated parallel subagents. Severity ordering,
deduplication and omission disclosure apply within each axis. The affected user
guide is now in English, and AGENTS.md records English-only documentation.

Validation: lint, strict TypeScript, production build and **1,101 deterministic
tests across 121 files** passed with disposable PostgreSQL. Axis labels and pinned
source access have deterministic regression coverage. The offline proof passed
with real OCR and the pinned Codex app-server in hardened Docker, covering new and
resumed sessions, commit context, structured finding axes and credential protection.
Assessment quality remains model-generated and unverified without live model
acceptance. No dependency, migration, deployment, live model call or external
message was added.

## Codex tasks isolate unrelated GitHub repository changes (2026-10-22)

New coding authority snapshots retain the GitHub connection generation and target
repository revision/visibility. Metadata refresh still advances the workspace
revision for ordinary reads, approvals and member permission freshness, while
only changed/removed target IDs advance their repository generations. Unrelated
changes hold progression for fresh permissions, then continue the same attempt.
Target changes, connection replacement, current actor permissions, Codex settings
and publication policy remain enforced. Reverting target metadata cannot revive
an old grant.

Permission-sync cancellation now targets affected repositories, including tasks
with collaborator inputs. Account/identity loss and connection replacement retain
full cancellation. Existing tasks without scoped snapshots retain their global
revision check; terminal tasks are not replayed. Optional JSON fields require no
SQL migration or dependency. The user guide, staging recovery example and
[VPS incident](../../postmortem/2026-10-22-coding-task-global-github-revision.md)
describe the correction and historical boundary. Production rollout and live
acceptance remain pending.

Validation: lint, strict TypeScript, production build and **1,098 deterministic
tests across 121 files** passed with disposable PostgreSQL. Regressions cover the
original metadata-refresh/permission-sync journey through same-attempt publication,
duplicate sync/polls, target changes before publication, same-installation
reconnection, collaborator revocation and historical grants. No deployment,
task replay, live model call or external message was performed.

## Personal Google accounts through Telegram (2026-10-22)

The Google panel now configures only the shared Web application client and plugin
Enable switch. Active members use `/google` in private Telegram for connection,
status, reconnect and disconnect. Browser consent uses the same callback URL for
all members/services, requires no admin session, and grants access only after the
initiating member confirms the displayed account in Telegram. Webhook and polling
use the same controls; callbacks resolve their original workspace after switching.

Encrypted tokens, refresh claims and Search Console property selection belong to
each member within the workspace and bot. `/google properties` offers paginated
selection, explicit Save/Cancel, up to 20 properties and upstream access checks.
Account and property changes fence in-flight reads, retained/derived evidence and
queued delivery without disabling other members. Group/scheduled reads are denied;
member revocation and workspace purge remove personal credentials. Existing admin
history-inspection permissions remain unchanged.

Migration `020_google_personal_accounts.sql` retires shared tokens, pending admin
consent and Search Console service-account credentials, preserving reusable OAuth
clients. Members must reconnect; legacy admin account/property APIs and editors
are removed. User guides, design preferences, runtime instructions and runnable
examples describe the personal flow. No dependency or deployment was added.

Validation: lint, strict TypeScript and production build passed. **1,078 deterministic
tests across 121 files** passed with disposable PostgreSQL, including personal
account/tenant boundaries, duplicate updates, consent replay/expiry, refresh races,
property selection and delivery revocation. **11 browser scenarios** passed at
1280px/390px, covering Google and the shared site-URL copy controls. Application
summaries/editors, loading/empty, pending/error and both themes were visually
inspected. Live Google consent and native Telegram presentation remain staging
checks; no real account connection or deployment was performed.
See [setup and migration](google-workspace.md).

## Unified Google plugin (2026-10-21)

Docs, Sheets, Drive, Gmail and Search Console now share one Google catalog card,
detail page, registered Web application client, account connection, callback URL,
Enable switch and runtime plugin. Search Console retains its explicit property
selection in a modal on the same page. Saved summaries, individual scope/callback
copy actions, pending locks and error recovery use the existing shared components.

The editor can reuse an existing encrypted OAuth client secret. Saving the shared
configuration clears the old product connections and Search Console service-account
credentials; fresh consent must grant all five read scopes. Legacy access stays
within its previous permissions until that explicit upgrade, and the merged switch
can disable it even when no OAuth client exists. Old page links redirect to Google.
Shared reads require a private interactive owner/admin request. Refresh claims,
revisions and connection identity fence concurrent reads, retained evidence and
delivery. Disconnect disables all five services; reconnecting clears properties.

Validation: lint, strict TypeScript and production build passed. **1,079 deterministic
tests across 120 files** passed against disposable PostgreSQL, including **19 focused
Google integration tests**. All **19 Google/Search Console browser scenarios** passed
at 1280px/390px. Saved summaries, connection/property editors, loading/empty,
pending and error states were visually inspected, including both themes and card
spacing. No dependency or SQL migration was added. Live Google consent and account
permissions remain staging checks; no account connection or deployment was performed.
See [shared setup](google-workspace.md) and [runnable requests](../../examples/google-workspace.http).

## Admin workflow management without Telegram linking (2026-10-21)

Authorized panel administrators can view full workspace workflow details and
create, edit, approve, pause/resume, run and delete schedules without linking
their own Telegram identity. The read-only notice and separate operator summary
were removed. Workflow counts match the complete admin list; saved summaries and
modal editors remain separate, with Edit at the card's top right on mobile too.

Existing workflows retain their execution owner. New private schedules use the
active recipient; new group schedules use the linked administrator or an active
workspace owner/admin. Manager authority is rechecked inside each transaction and
audited separately. Owner membership, destinations, repository scope, skills,
approval hashes/expiry, version conflicts and team budgets still govern execution.
Operator workflow approvals survive normal reconciliation; other approval kinds
and individual run recovery retain their existing actor requirements.

Validation: lint, strict TypeScript, production build and **1,073 deterministic
tests across 120 files** passed with disposable PostgreSQL in an isolated checkout
containing this workflow change, avoiding concurrent Google integration edits.
All **30 browser scenarios** across workflows, admin and Overview passed.
Desktop (1280px) and mobile (390px) summaries, New/Edit, loading/empty, pending and
error states were inspected. Tests cover unlinked and cross-owner management,
approval replay, tenant/CSRF/Origin boundaries, revoked admins/owners, source
revocation, duplicate ticks, budgets and preserved execution/audit identities.
No dependency, migration, deployment or external message was added.

## Workflow budgets follow team settings (2026-10-21)

Workflow lists, details and New/Edit dialogs no longer expose a separate per-run
budget or the former $0.10 default. Both scheduled and manually triggered workflow
runs inherit the team's per-run and monthly limits at dispatch, including None
and zero. Existing saved workflow caps are ignored; older clients' `budgetUsd`
fields are discarded on save. Historical run snapshots and approval evidence
remain intact. Telegram proposals say that budgets follow team settings.
The UI preference, API documentation, user guide and runnable proposals were updated.

Validation: lint, strict TypeScript, production build and **1,066 deterministic
tests across 119 files** passed with disposable PostgreSQL. All **six workflow
browser scenarios** passed, including editing legacy records, saving without a
workflow budget, draft retention, pending locks, permissions and navigation.
Desktop (1280px) and mobile (390px) summaries, New/Edit dialogs, loading/empty,
pending and error states were inspected for the removed row and leftover spacing.
Budget tests cover unlimited/zero/finite team limits, legacy caps, current settings
at dispatch, reservations and duplicate scheduler ticks. No dependency or migration
was added; no deployment, live model call or external message was performed.

## VPS Review Bot sandbox failure and source-tool correction (2026-10-20)

Operator-authorized inspection found two automatic reviews of `stonega/wallshader`
PR #2 that returned `needs_input` after bubblewrap failed before reading the OCR
plan. Both assessed zero files; neither recorded a published review ID. They
were subsequently cancelled. A third retained review task was cancelled without
a result; its cause remains unverified.

Credential-free probes of the current VPS task image reproduced the review
policy's namespace startup failure, while ordinary read-only Landlock startup
passed. App/worker/runner health and application version 0.1.42 do not establish
review compatibility. The earlier intake fix deliberately retained the review
policy's credential-denying paths.

Read-only review/answer sessions now investigate through an application-owned
source tool, with native shell/image/subagent tools disabled. OCR plans, committed
files and literal-path diffs are pinned to the task's base/head/merge-base commits;
runtime files, symlink targets, arbitrary commands/revisions, inherited credentials
and external Git drivers are unavailable. Pagination, read limits and explicit
errors preserve coverage gaps. Startup revalidates the plan and complete rule
coverage before model execution, failing preparation directly when invalid. The
credential-denying split policy and Docker restrictions remain in place.

The real OCR/pinned app-server proof passed under Node 24 in hardened local Docker
and on the VPS using a bundled correction in a disposable container. It covers
source/diff/plan/list reads, new/resumed sessions, native shell exclusion and
credential/process-path rejection with a local fake provider. Production rollout
and successful live review acceptance remain open. No configuration change, task
replay, paid model call or external message was performed. See the
[VPS incident](../../postmortem/2026-10-20-review-bot-vps-sandbox.md).

Validation: lint, strict TypeScript, production build and **1,060 deterministic
tests across 119 files** passed with disposable PostgreSQL. App, task and
supervisor images built; the packaged Node runtime contract, Compose validation
and full Docker lifecycle smoke passed, including the real review source proof.
New tests cover immutable commits/merge-base diffs, literal paths, traversal,
runtime files, symlink targets, binary reads, pagination, invalid/stale plans,
external Git drivers, start/resume policies and terminal preparation failures
without publication. No dependency, migration, UI or container-policy change.

## Compact GitHub skill selection (2026-10-20)

GitHub import discovery rows now show only a checkbox and skill name in a compact
44px selection row. Names open the shared read-only dialog with the source path,
description, instructions, metadata, supporting files and any import issue.
Unavailable entries retain working detail links; their selection stays disabled.
Files without readable name metadata display the containing folder's name, or
`SKILL.md` at the repository root. Closing details preserves selected skills and
returns keyboard focus to the name; pending imports lock both selection and
detail actions. Saved catalog cards and update review retain their existing UI.
Removed the old description/path blocks and row padding. The scoped preference
is recorded in [UI rules](../design/ui-rules.md#skill-import-lists-show-names-only).

Validation: lint, strict TypeScript, production build and all **1,053 deterministic
tests across 118 files** passed with disposable PostgreSQL. All **10 GitHub skill
browser scenarios** passed, including name-only row content/height, keyboard
selection, Enter/Escape and focus restoration, preserved selection, metadata and
supporting-file review, unavailable reasons, pending locks, empty/error recovery
and saved summaries at 1280px/375px. Desktop/mobile light/dark list, detail,
pending and error screenshots were inspected. No deployment was performed.

## Harness-compatible skill packages (2026-10-20)

Markdown and GitHub skill imports now parse YAML frontmatter with the explicit
`yaml` 2.9.0 dependency. Descriptions accept 1,024 characters and names accept 64;
quoted/multiline values, comments, string/list tool declarations, `license`,
`compatibility` and string-valued `metadata` are preserved. Invalid YAML, duplicate
fields, aliases/custom tags, unavailable tools and excessive descriptions have
specific import errors. The four reported files from `~/Documents/harness` passed
unchanged through deterministic GitHub discovery; `new-project` included all five
linked guides.

GitHub discovery bundles recursively linked Markdown/text guides within each
skill directory from the pinned commit, capped at 32 files, 64 KB each and 256 KB
combined. Missing guides, secrets, binary text, symlinks and links into another
skill package cannot supply supporting content. External/outside-directory links,
scripts and archives are not fetched or executed. Import review, saved previews
and source-update comparisons expose metadata and guides as read-only details.
Standalone Markdown uploads still contain only the selected file.

Published versions retain their resource snapshots. `load_skill` can read an exact
resource path only through the existing workspace, actor, run, enabled-skill and
version-pin checks, with argument-bound durable replay. Guide-only changes trigger
source update review without modifying published versions or existing pins.
Stable draft hashing avoids false local-edit warnings after PostgreSQL JSONB key
reordering and accepts legacy schema-ordered hashes.

Validation: `bun run check`, strict TypeScript, production build and packaged Node
runtime contract passed; **1,053 deterministic tests across 118 files** passed
against disposable PostgreSQL. **29 browser scenarios** passed across GitHub
imports, presets and search, including the four harness regressions, source
metadata, supporting files, guide-only update comparisons, explicit errors and
saved summaries at 1280px and 375px. Desktop/mobile layouts and pending/error
screenshots were inspected. No migration or deployment was performed. See
[skill format and bounds](../design/agent-skills.md),
[user guide](../user/skills.md) and [API examples](../../examples/github-skills.http).

## Consistent admin checkboxes (2026-10-20)

Admin and shared setup checkboxes use rounded controls with SVG checkmarks,
themed selection/hover backgrounds, visible keyboard focus and 44px minimum
label targets. Long labels wrap without shrinking the checkbox. Disabled and
mixed states, reduced motion and native forced-color rendering are supported;
member and plugin enable switches retain their appearance.

The shared styles replace separate form, plugin, resource and skill-import label
rules, including the form width override that could shrink checkbox inputs.
Saved summaries and modal editing remain separate. The reusable preference and
exceptions are recorded in [UI rules](../design/ui-rules.md#admin-checkboxes-share-a-clear-comfortable-style).

Validation: lint, strict TypeScript, the production build and deterministic tests
with disposable PostgreSQL passed. All 27 focused browser scenarios passed,
including four new checkbox scenarios at 1280px/390px in both themes, the admin
suite and Search Console resource selection. Screenshots were inspected for
checkbox states, wrapped labels, editors, pending saves, failed saves and forced
colors, plus saved Search Console summaries and resource editors. No dependency
or migration was added.

## Built-in Defuddle web reader (2026-10-20)

Added `read_web` as an internal preset for authorized chat and scheduled runs,
independent of search-provider configuration, API keys and skill grants. It
returns clean Markdown and bounded source metadata with the final URL and an
explicit truncation flag. Defuddle 0.19.5 and linkedom 0.18.13 are pinned runtime
dependencies. A separate extraction worker executes no page scripts or extra
extractor requests and suppresses raw parser diagnostics.

Public-address validation covers URL schemes/credentials/ports, all DNS answers
and each redirect; connections pin the checked IP while preserving TLS and Host.
Requests carry no application credentials or cookies. A twenty-second deadline,
five-redirect cap, 2 MiB encoded/decompressed limits and 24,000-character Markdown
limit bound reads. Deployment, membership, destination, run status and fence guards
protect requests and cached reuse. Durable reservations deduplicate completed
calls, reject conflicting arguments and prevent unknown-call replay; revocation
discards in-flight results. Web contents remain untrusted reference data.

Validation: lint, strict TypeScript, production build and the packaged Node runtime
contract passed. All **1,043 deterministic tests across 117 files** passed against
disposable PostgreSQL, including 18 reader tests for extraction, metadata,
truncation, address/redirect/size boundaries, cancellation, transport pinning,
durable replay and permission revocation. Search registration and citation tests
also cover the always-available reader. No UI layout or database migration was
changed. The Docker image built and passed its offline Node 24 runtime smoke,
including extraction and pinned HTTP transport; Compose configuration validated.
No live model/Telegram calls, account connections or deployment were performed.
See [implementation and boundaries](web-reader.md) and
[runnable examples](../../examples/web-reader.md).

## Built-in DuckDuckGo search preset (2026-10-20)

DuckDuckGo is now a read-only preset in Search providers and is immediately
available in the bot chat model editor. Selecting it needs no saved provider
record or API key; search remains disabled until selected. New provider dialogs
offer DeepSeek and Exa. The preset stays visible while saved settings load or fail
to load. Existing saved DuckDuckGo providers and selections remain usable, and
operators can switch to the preset before removing their old record.

The semantic `duckduckgo` selection resolves to an operator-bound runtime pin and
retains the existing workspace/run authorization and revocation checks. Preset
edits/removal and creation of duplicate DuckDuckGo records are rejected. Catalog
reads do not write deployment settings. No migration or dependency was added.

Validation: lint, strict TypeScript and the production build passed. All **1,024
deterministic tests across 115 files** passed against disposable PostgreSQL,
including **15 focused search tests**. All **28 model-provider and eight search
browser scenarios** passed. Desktop/mobile light/dark screenshots were inspected
for preset summaries, saved selection, new and legacy editors, loading/error,
pending and retry states. Provider calls use deterministic fixtures; no live
search/model/Telegram call or deployment was performed for this follow-up.

## Bot chat web search providers (2026-10-20)

Model settings now includes a separate Search providers section with saved
summaries and New/Edit/Remove dialogs. Operators can save free, keyless DuckDuckGo
or encrypted DeepSeek/Exa API credentials and reuse them across their workspaces.
The chat model editor selects one provider or Disabled; existing configurations
default to disabled. The saved choice appears in the chat model summary. Provider
management is session/origin/CSRF/operator protected; selection requires workspace
ownership, revisions and a provider belonging to the same operator. In-use removal
is rejected, and changing paid provider types requires a new key.

The worker exposes `search_tool` only for configured chat runs, pins search
provider/selection versions and rechecks membership, run/fence and configuration
around network calls and cached-result reuse. Started calls are durable; duplicate
completed calls reuse their result, conflicting arguments are rejected and unknown
calls are not replayed. Responses have time/size/result limits and safe URL/summary
normalization; provider errors exclude raw response bodies and credentials. Web
results are untrusted references with URL citations. DeepSeek uses the official
`/v1/tools/search` endpoint; Exa uses `/search`; DuckDuckGo parses public HTML and
reports challenges/rate limits as failures. Paid search fees remain outside model
token budgets and Usage totals. Codex and Review Bot selections remain independent.

Validation: lint, strict TypeScript and production build passed. All **1,021
deterministic tests across 115 files** passed against disposable PostgreSQL.
All **34 browser scenarios** across model providers and web search passed; the
six search scenarios passed again after final layout refinements. Desktop/mobile
screenshots were inspected for saved/empty/loading states, provider/model editors,
pending and failure/retry states, including both themes. The affected provider
cards reuse the shared heading layout and have explicit spacing regression checks.
No dependency or migration was added. Provider requests use injected test fixtures;
live search/model/Telegram calls and deployment were not performed.
See [runnable API examples](../../examples/web-search.http) and
[user configuration](../user/configuration.md#聊天网页搜索).

## Independent Google Docs, Sheets, Drive and Gmail plugins (2026-10-20)

Historical implementation; superseded by the shared Google plugin on 2026-10-21.

Added four standalone built-in plugins with separate catalog/detail pages, OAuth
clients, account connections, enable switches and Pi tools. Docs reads text across
document tabs; Sheets reads metadata and explicit formatted A1 ranges; Drive
searches filenames and reads metadata; Gmail searches messages and reads headers,
snippets and plain-text MIME parts. Lists preserve provider pagination. Editing,
sharing, deletion, email sending and attachment downloads are unavailable.

Configuration is operator/workspace/session protected. OAuth uses offline consent,
S256 PKCE and one-use ten-minute state bound to the product, workspace, operator,
session, revision and callback. Credentials are encrypted per workspace/product;
refresh claims serialize workers and fence late disconnect results. Connections
remain disabled until explicitly enabled. Runtime reads require an active owner
or admin in a private interactive conversation. Revocation applies to cached
tool results, retained/derived evidence and delivery. Local disconnect affects
only the selected plugin; operators revoke provider grants separately. Shared
OAuth clients can couple revocation at Google.

Validation: `bun run check`, strict TypeScript, production build and the Node
runtime contract passed. **1008 deterministic tests across 113 files** passed
against disposable PostgreSQL, including **15 focused Google tests**. All **15
Google browser scenarios** passed at 1280px/390px, covering independent catalog
entries, saved summaries/modal separation, first setup, blank-secret retention,
pending locks, errors/retry, cancellation, local disconnect and consent navigation.
Desktop/mobile light/dark layouts and affected card spacing were inspected.
Live Google consent and real account/API behavior remain staging acceptance
steps. No dependency, migration, account connection, Telegram/model call or
deployment was added/performed. See [setup and boundaries](google-workspace.md)
and [runnable requests](../../examples/google-workspace.http).

## Google Search Console plugin (2026-10-20)

Historical implementation; the Google plugin now shares OAuth and enablement.

Added a built-in, read-only Google Search Console plugin for finalized search
performance, sitemap metadata and indexed URL inspection. Operators save encrypted
service account credentials, discover properties and explicitly select an allowlist.
The panel uses saved summary cards, modal editors and an independent Enable switch.
Active members query through private interactive Telegram runs. Revision, tenant,
permission and destination checks apply to provider calls, retained/derived answers,
handoffs and delivery. Rotation clears selections and disables access; duplicate
completed tool calls replay through the existing durable ledger.

Validation: 12 focused unit/integration tests and 20 browser regressions across
Search Console, Cloudflare and Code Truth passed. Search Console's six desktop/mobile
scenarios passed again after the final UI adjustment; screenshots were inspected
for saved/empty/loading, credential/property editors, pending and error states at
1280px and 390px. Lint, strict typecheck and production build passed. A full run
had 1005 passes and three failures in concurrently edited Google/Codex tests; all
106 tests in those two files passed on an isolated rerun. This is not a clean full
suite result. No migration or dependency was added. No live Google account,
Telegram/model call or deployment was performed; live provider permissions and
quotas remain staging checks. See [setup and boundaries](search-console.md) and
[runnable requests](../../examples/search-console.http).

## Code Truth in the standard deployment (2026-10-19)

The base Compose stack now builds and starts the private Code Truth service and
automatically connects both API and worker. A network-isolated one-shot app
container atomically initializes a token in `code_truth_auth`; the long-running
containers mount it read-only. Repeated/concurrent initialization preserves the
token, invalid saved credentials stop startup, and `code_truth_data` retains
existing indexes. The legacy host-file token overlay remains compatible.
Workspace enablement controls repository indexing/tools, without deploying
containers or granting the web app Docker access.

The host updater builds and smoke-tests the fourth image, pins its immutable ID,
starts Code Truth before the writers and checks authenticated readiness from
both clients before promoting a release. Incomplete old updater bundles fail
before stopping existing services; the first upgrade requires installing the
current host updater. Cleanup retains Code Truth with complete rollback sets.
CI now builds the service and runs offline real-index/MCP and Compose connection
checks. User/operator setup and upgrade instructions were updated.

Validation: Biome, strict application/service typechecks and the production build
passed. **969 deterministic tests across 108 files passed** against disposable
PostgreSQL. The verification pass also corrected an existing random invitation
test whose attempted mutation could equal the original first character; no
invitation runtime behavior changed. Both exact Docker images built; the Node runtime contract and offline
real CodeGraph/MCP smoke passed. A disposable Compose stack verified automatic
startup, API/worker authentication, retained token/index volumes after recreation,
application readiness and the legacy host-file override. The fixture host's
SELinux bind mounts required a test-only label override. Live VPS SSH timed out;
no deployment, account connection, live GitHub/model call or Telegram send occurred.

## Admin self-check chat (2026-10-19)

The authenticated admin panel now has a bottom-right self-check chat button for
the selected workspace. It opens a non-modal conversation popup with quick
checks, follow-up messages, expandable findings and links to the relevant settings.
Minimizing preserves the conversation; switching workspace/account or reloading
clears it. Sign-in and setup do not show the widget.

The server checks saved workspace/deployment activity, worker heartbeat, Telegram
receiver readiness, chat model selection, active members, published skills, recent
retained failed requests and saved GitHub selections. The configured workspace
chat model provides read-only explanations through Pi, with no action or extension
tools. Missing/unavailable models and exhausted budgets retain basic findings.
Checks do not test external credentials or repository permissions. No private
messages, raw logs or credentials enter the diagnostic snapshot.

The endpoint enforces session, origin, CSRF, tenant and current admin authorization,
duplicate request IDs, concurrent-call exclusion and the existing account throttle.
Authorization is rechecked during generation and before returning findings.
Provider accounting participates in existing workspace budgets/usage; uncertain
calls retain reservations. Only accounting/deduplication metadata is persisted,
with settled records retained for 90 days and workspace deletion removing all
records. Diagnostics never enqueue bot runs or Telegram delivery.

Validation: Biome, strict TypeScript and the production build passed; **958 tests
across 107 files** passed with disposable PostgreSQL, including **10 new self-check
integration scenarios**. **38 browser scenarios** passed across self-check, admin,
Overview loading and sidebar behavior; the six self-check scenarios were rerun
after final focus/layout refinements. Desktop/mobile light/dark screenshots were
inspected for empty, conversation/findings, pending, failure, retry/fallback and
compact viewport states. Live provider/Telegram behavior remains unverified; no
deployment, webhook registration or live external messages were performed.

## Container-compatible Codex intake sandbox (2026-10-19)

Ordinary new/resumed Codex sessions explicitly select the pinned CLI's Landlock
backend. Intake, factual analysis and result-only corrections retain their
read-only filesystem/network boundaries; work retains its existing container
isolation. Credential-denying PR review split policies keep bubblewrap and fail
closed when unsupported. No dependency, migration, environment variable or Docker
privilege change was added. Target-quote guidance also distinguishes local
validation failures from GitHub availability and preserves short repository names.

The real Docker smoke now probes the pinned Codex sandbox before substituting its
fake executable: source reads succeed while repository/temporary writes and network
socket creation are denied. New/resumed-session protocol regressions preserve the
separate review policy. Biome, strict TypeScript, production build and **948 tests
across 106 files** passed with disposable PostgreSQL. Matching app, supervisor and
task images built; the Node 24 runtime contract, Compose validation, full Docker
lifecycle smoke and pinned-CLI fake-provider protocol proof passed.

The supplied screenshot's exact live attempt remains unverified because SSH to
the documented VPS timed out and no authenticated admin session/task ID was
available. No deployment, live model/Telegram call, GitHub mutation or historical
task replay was performed. See the [investigation and evidence limits](../../postmortem/2026-10-19-codex-intake-sandbox-startup.md).

## Recovery of infrastructure-interrupted coding tasks (2026-10-19)

New continuous coding attempts opt into recovery across repository preparation,
setup, implementation and independent checks. A job-generation SIGTERM marker
or changed Docker host boot ID with a confirmed non-OOM signal exit distinguishes
interruption from ordinary failure. The runner persists a recovery identity,
retains the work volume and releases capacity. The application revalidates the
current lease, actors, sources, bot, configuration and live repository access,
refreshes credentials and resumes the same attempt. Account recovery uses the
current sealed credential generation; shared providers retain their pinned model
and version. Partial preparation clones can be recreated; partial implementation
and the frozen check plan remain preserved. Missing partial-turn usage is unknown.

Recovery requests are idempotent across duplicate calls, lost acknowledgements
and supervisor restarts. A running recovery is adopted; an uncertain created or
missing container is not blindly started. Stop, revoked access, sign-in pauses,
capacity waits and retention remain enforced. Publication retains unknown-outcome
and read-only reconciliation handling. Old terminal failures and attempts without
recovery opt-in/evidence are not automatically replayed. Review Bot and separate
factual-question executions keep their existing recovery behavior.

Recovery uses the existing Telegram progress message and Stop controls. The admin
status reads **Restoring interrupted task**. No dependency, migration or new
environment variable was added. The runner contract adds a private authenticated
resume endpoint; app, worker, supervisor and task image must be updated together.

Validation passed Biome, strict TypeScript, the production build and **947
deterministic tests across 106 files** with disposable PostgreSQL. Focused tests
cover all four phases, signal recording, host-boot fallback, OOM/ordinary failure
exclusion, tenant/recovery identities, fresh credentials, revocation during token
minting, cancellation, capacity, retention and ambiguous starts. All **12 focused
browser scenarios** passed; recovery/Stop layouts were inspected at 1280px/390px.
Pending/rejected Stop and completion races retain regression coverage. Matching
Docker images built, the Node 24 runtime contract passed, Compose validated and
the real Docker lifecycle fixture passed a SIGTERM interruption, supervisor
restarts, duplicate recovery, retained partial code and independent checks.

No live Telegram/model request, GitHub publication, historical-task recovery or
deployment was performed. Actual host/daemon restarts and native Telegram rendering
remain staging acceptance steps. See [runner behavior](codex-runner.md#lifecycle-and-recovery),
[the repeatable fixture](../../examples/codex-interruption.md) and
[incident evidence](../../postmortem/2026-10-18-codex-task-interrupted-by-vps-reboot.md).

## Expanded Cloudflare operations (2026-10-19)

The built-in plugin now exposes 45 query choices (including capability discovery),
covering fixed zone traffic analytics and 42 metadata resources across DNS/TLS,
security, Pages, Workers, KV, R2, D1, Queues, Vectorize, Hyperdrive, Turnstile,
load balancing, health checks, email routing, waiting rooms and Web Analytics site
metadata. Saved account and explicit domain grants apply to all requests, with
current private/member authorization and revision checks around provider reads.
Account-only configurations now say **Account resources only**. Field allowlists
exclude credential/configuration secrets and stored content; no arbitrary API,
GraphQL, SQL, source-code or object-data access is exposed.

Exact reviewed writes now also support 14 named zone settings and Worker-route
create/update/delete. Updates/deletes pin the current target; noneditable settings
are rejected. Existing actor approvals, tenant scope, durable sending reservations,
concurrent-send deduplication and no replay after ambiguous outcomes are retained.
Pages uses ten results per page after a read-only live check isolated the prior
failure to the twenty-result request. See the [incident analysis](../../postmortem/2026-10-19-cloudflare-pages-pagination.md).

Validation: Biome, strict TypeScript, production build and the Node runtime contract
passed. All 980 tests in the full deterministic suite passed; the final focused
Cloudflare pass included 59 tests. All 18 focused browser scenarios passed with
disposable PostgreSQL; desktop/mobile saved display, token/resource editors,
loading/empty, pending/error and light/dark renders were inspected. Focused coverage
includes every catalog entry, foreign scope/parameter denial, GraphQL read guards,
partial-error rejection, daily date bounds, pagination, nested secret exclusion,
revocation, changed targets and concurrent approved sends. A direct read-only
GraphQL overview smoke check succeeded with the existing saved token and selected
zone. No provider settings changed or Telegram messages were sent. Expanded
provider/product acceptance and deployment remain outstanding. No dependency,
migration or deployment configuration was added.

## Cloudflare direct API token setup (2026-10-18)

New Cloudflare settings default to API tokens. The panel replaces OAuth client
setup with a write-only token modal and a separate resource-selection modal.
Saving a token opens account/domain selection; a sole account is selected in the
draft, domains remain explicit and Pages-only access needs no domain selection.
Existing summaries remain readable values. Token replacement clears cached names
and pauses the plugin; removal disables it. Restricted tokens can enter IDs
manually without claiming verified provider permissions.

The token-backed inventory endpoint enforces the current operator, workspace,
session, Origin, CSRF and plugin revision before and after provider reads. Named
selection saves verify the account and each domain's account association before
persisting names. Discovery grants no tool scope. Local OAuth credentials and
pending consent are cleared only when explicitly replaced with a token; legacy
backend OAuth behavior remains compatible, and late callbacks cannot restore a
replaced connection. Old remote authorizations must be revoked in Cloudflare.

UI preferences, the implementation/user guides and runnable token requests are
updated. The isolated Cloudflare snapshot passed Biome (one existing unused-import
warning in development tests), strict TypeScript, production build, the Node runtime
contract and **919 deterministic tests across 104 files** with disposable PostgreSQL.
An earlier shared-tree run passed **930 tests across 105 files**. All **18 browser
scenarios** passed at 1280px/390px in the isolated snapshot, including saved
display, both editors, loading/empty, pending, error/recovery, manual IDs and legacy
replacement. Light/dark screenshots were inspected, and card edge spacing has
browser assertions. No package, migration or environment variable was added.
Live token permissions remain an acceptance step; no Cloudflare account was
connected, provider mutation sent, Telegram/model call made or deployment run.
See [setup and compatibility](cloudflare.md).

## Free-form scheduled tasks with optional skills (2026-10-18)

Telegram and admin workflow proposals now accept free-form tasks without a
`skillId`. Approval, pause/resume, dispatch and run creation support an empty
skill catalog. Runs without a selected skill have no skill pins or dependency on
unrelated catalog changes; existing selected skills retain their published version
pins and revocation behavior. Schedule proposals are application-owned tools,
independent of a skill's requested tool list. Unpinned scheduled runs can read
their authorized chat context and scoped model costs; connector grants and
external-action policies remain separate. No migration or dependency was added.

The shared modal editor defaults to **No skill**, allows clearing an existing
selection, and saved details show a readable value without a fictitious version.
Assistant guidance distinguishes scheduling from tool availability: a missing
weather skill cannot itself block a proposal, while live weather still requires
an authorized live-data tool. Daily/weekly recurrence, explicit local time/zone,
approval, destination checks, budgets and capacity limits remain in force.

Validation of the isolated scheduler snapshot passed Biome, strict TypeScript,
production build and **914 deterministic tests across 103 files** with disposable
PostgreSQL. All **6 focused browser scenarios** passed, with desktop/mobile
inspection of saved details, modal
editors, the empty skill catalog, pending saves and retained drafts after failure.
Coverage includes approval/replay, restart persistence, duplicate and missed
occurrences, dispatch capacity, owner revocation and unchanged tool boundaries.
No deployment, live Telegram/model call or live weather retrieval was performed.

## Telegram Mini App for Codex task history (2026-10-18)

The read-only `/mini` page opens a task from **View conversation** on Telegram
task messages. It combines retained original inputs, Chat Agent questions, Codex
answers/progress and completed native assistant messages, with expandable bounded
command/file/tool activity. It follows live Telegram themes, stable viewport and
safe-area settings. Older-page loading preserves the reading anchor; reconnect
and foreground activation catch up without duplicating messages or forcing a
reader away from earlier content. Arrival cursors remain separate from displayed
message time so delayed runner records and answers to older questions are visible.

The existing private attempt channel captures an explicit native-item allowlist.
A separate private file queue preserves messages while channel requests stall;
the supervisor recovers those files before container cleanup. Private logs and
application events survive restarts, deduplicate native identities and follow task
erasure. Reasoning, internal prompts and raw protocol streams are excluded;
structured task results expose their supplied summary/question. Older tasks and
interrupted partial output have explicit coverage limits. No dependency or SQL
migration was added.

Every read validates signed Telegram initialization data and current task,
workspace, bot, repository and retained-source permissions. Private tasks remain
with their original actor. Group reads additionally verify current membership of
the original group and Topic-bound sources. Deleted factual-question sources also
hide their answers before asynchronous cleanup. Access/session failures clear
displayed history. Admin login/cookies remain separate, and only the Mini App page
permits Telegram Web embedding and the official SDK.

Validation of the isolated Mini App snapshot passed Biome, strict TypeScript,
production build and **908 deterministic tests across 103 files** with disposable
PostgreSQL (`bun test --timeout 15000`). An earlier shared-workspace run hit the
existing auth-pause recovery test's five-second timeout; its focused replay and
full rerun passed.
Focused capture/authorization tests and **5 browser tests** cover native events,
cursor recovery/deduplication, expiry/revocation, clipboard copying, scroll
anchoring, loading/empty/error states, theme changes and mobile/desktop rendering.
The app, supervisor and job images built; the app passed the Node 24 runtime
contract, Docker lifecycle smoke retained native messages across supervisor
restart and erased them with the task, and the Docker Compose overlay validated.

BotFather Main Mini App configuration at the deployment's `/mini` URL, live
iOS/Android/Desktop acceptance and live group membership checks remain rollout
steps. No deployment, bot registration, account connection or live Telegram/model
call was performed. See [setup and boundaries](telegram-mini-app.md).

**Site domain → Update connected services → Telegram** now includes a copyable
**Mini App URL** using the effective site address plus `/mini`, with BotFather
guidance. It follows domain changes and restoring the default address, remains
visible while loading, and is available in both polling and webhook modes.
The URL follow-up passed lint, strict TypeScript, the production build, all
919 deterministic tests and six focused browser scenarios. Desktop/mobile
light/dark, loading, clipboard failure and unavailable-settings layouts were
visually reviewed.

## Latest-message Codex task controls (2026-10-18)

Native Telegram Status/Cancel controls now remain only on the latest confirmed
task message, independently per task, requester, bot and chat/topic. Confirming a
new message revokes old callbacks and queues durable keyboard-only edits. An older
routine progress edit keeps its original message order and cannot restore controls.
Pending, failed or unknown new sends preserve the previous controls; confirmed
terminal outcomes can remove them all. PR Review/Merge and other URL links
retain their existing behavior.

Cleanup edits target known sent message IDs and retry safely after rate limits,
ambiguous edits or worker restart. Further updates reuse a pending cleanup and its
retry time. A permanently uneditable old message is never replaced; its visible
buttons may remain, but its stale callbacks are denied. Retained legacy deliveries
are included after the next confirmed update. No dependency or SQL migration was
added. The scoped UI preference, implementation contract and manual acceptance
example are updated.

The isolated button-fix commit passed Biome, strict TypeScript, production build,
the host Node runtime contract and **896 deterministic tests across 101 files**
using disposable PostgreSQL. Coverage includes legacy deliveries,
consecutive/duplicate updates, failed/unknown sends, retry/restart recovery,
backoff reuse, concurrent sends, older progress edits, final outcomes, preserved
URL links, stale callbacks and audience/permission boundaries. Earlier shared-tree
validation passed 919 tests across 104 files with concurrent routing/transcript
and Mini App work present; those independent changes are excluded from this commit.
Native Telegram desktop/mobile rendering and deployment remain unverified;
no live Telegram messages were sent.

## Repository target routing and task correction (2026-10-18)

Chat Agent distinguishes modification targets from documentation/example sources.
Coding tools carry a quoted human target alongside the repository ID; application
checks reject contradictory IDs, invented quotes, document-URL substrings and
ambiguous abbreviations before creating work. An implicit contextual target can
use an empty quote. This validates repository identity and input evidence; the
model's semantic target/reference interpretation remains a live pilot gate.

An explicit current correction can replace an idle task with an independently
exported empty patch, no PR/verified artifact, no active execution/conversation
or cleanup, and current target permissions. A never-started task is also eligible.
The workspace transaction fences/stops the old task and links one replacement;
duplicate corrections reuse it. Original retained requirements remain references,
while the current correction authorizes fresh intake. Existing patches, uncertain
patch state, changed/expired sources and oversized history refuse replacement.
No old patch, Codex session or implementation/publication grant is transferred.
Old runner records without empty-patch evidence are not automatically recovered.

Text/captioned question replies first reach Pi for intent handling; captionless
media and accepted-input edits retain direct routing. Source identity deduplicates
inputs across both routes. Up to five owned tasks in the same bot/conversation
provide current state, repository and blocker context, with source-hash, retention
and permission dependencies on derived replies. Handoff summaries report the
saved state instead of always claiming queued. Tool/skill guidance explains
repository versus branch mismatch without asking users for checkouts or containers.

Validation passed Biome, strict TypeScript, production build, the host Node runtime
contract and **897 deterministic tests across 102 files** with disposable PostgreSQL
in the shared working tree. One intermediate full run hit the five-second timeout
in the existing access-recovery scenario; its isolated replay and final full run
passed. Fixtures cover target/reference separation, atomic/idempotent correction,
existing work and live-lease refusal, source edits/expiry, tenant/actor/bot/topic
and repository boundaries, patch evidence across runner restarts and factual
waiting-state summaries. Synthetic examples retain no live conversation IDs or
private transcripts. No dependency or SQL migration was added. Live model routing,
native Telegram presentation and deployment remain unverified; no external model
call, Telegram send, account connection or rollout was performed.

These receipts cover the completed routing snapshot. Subsequent parallel transcript
and mini-app edits appeared in the shared checkout; the final whole-tree Biome
check reported formatting/import-order errors in that ongoing work. The routing
files' focused Biome check and a fresh whole-tree TypeScript check still pass.
Those parallel edits were preserved; this is not a claim that their current
working tree has passed the complete validation suite.

## Telegram work-buddy personality (2026-10-18)

The assistant now loads [SOUL.md](../../src/agent/SOUL.md) into its private,
group and scheduled reply prompts. It defines a warm, dependable work partner,
natural language matching, optional “小伙伴” / “buddy” forms of address and
sparse humor/emoji. Failures, risks, approvals and formal reports use a calmer
tone. The base policy permits friendly phrasing while retaining concise answers,
evidence requirements, approvals and private/group boundaries.

Fixed queue, investigation, implementation, repair, waiting and generic failure
notices use conversational wording. Confirmed-state routing, controls,
deduplication and delivery timing retain their existing contracts. The Markdown
is copied beside bundled Node entrypoints and loaded using the module URL;
source processes load it directly. Restart source processes, or rebuild and
restart bundles, after editing it. No dependency, setting or migration was added.

The UI preference, user guide and runnable pilot acceptance examples are updated.
Validation passed Biome, strict TypeScript, production build, **887 deterministic
tests across 101 files** in the shared working tree, the host Node runtime
contract and the Node 24 runtime
contract in the built application image with networking disabled. Compose config
also validates. Coverage includes prompt integration, factual notices, safe
failure guidance and the existing delivery/permission/cancellation contracts.
Live model tone and native Telegram desktop/mobile display, including waiting,
failure and final states, remain unverified. No live model call, Telegram send,
account connection or deployment was performed.

## Code Truth repository descriptions and automatic IDs (2026-10-18)

Code Truth repository modals now ask only for the GitHub URL and an optional
description of up to 2,000 characters. Internal IDs are generated automatically;
existing IDs survive edits. Saved cards show the GitHub repository name and
description as text. Network/branch controls and their nested modal were removed.
Descriptions and repository URLs reach the assistant through `list_code_targets`
so it can select generated target IDs without asking users for them.

Indexing resolves the repository's current default GitHub branch on each refresh
and retains its actual branch name and immutable commit as provenance. The
upstream MCP adapter retains one internal snapshot selector. Legacy saved network
mappings remain readable, are omitted from settings responses and are removed on
save; they no longer select branches. Legacy duplicate-URL records remain editable.
Matching app/worker and Code Truth service builds are required for this behavior.
The runtime skill, API example, setup docs and scoped UI preference were updated.

Validation passed Biome, strict TypeScript for both packages, production build,
Node runtime contract, **882 deterministic tests across 100 files**, and **25 admin
and repository browser scenarios**. The four focused Code Truth browser scenarios
passed again after final spacing cleanup. Desktop/mobile saved displays, editors,
loading/empty, pending, validation and recoverable error states were visually
inspected. The real CodeGraph/MCP smoke passed with automatic branch discovery.
No dependency or SQL migration was added; live GitHub calls and deployment were
not performed.

## Cloudflare connection discovery (2026-10-18)

Cloudflare OAuth now starts without account/zone IDs. The callback discovers
authorized accounts, automatically selects a sole account for Pages-only access,
and asks for a named workspace account when several are available. Configuration
uses named account choices and searchable, paginated domain checkboxes in the
shared modal. Saved summaries show verified names; manual API-token setup remains
an explicit fallback. No domains are granted automatically. Operators still
register/configure their OAuth client once.

Inventory endpoints project only names/IDs and require the authenticated workspace
operator, Origin, CSRF and current revision. Provider responses are fenced against
disconnect, role/credential revocation and settings changes. Saving a new account
or domain selection verifies provider access and each domain's account before
the local grant changes. Discovery works while configuring a disabled plugin and
does not expose inventory to model tools. Missing Zone Read still allows an
explicit Pages-only selection. UI rules and runnable API examples are updated.

Validation passed Biome, strict TypeScript, production build, Node runtime contract,
all **875 deterministic tests across 98 files**, and **22 Cloudflare browser scenarios**
at 1280px/390px. Desktop/mobile saved displays, editors, account choice,
loading/empty, pending, failure/recovery and dark theme were visually inspected.
No dependency, migration,
live Cloudflare connection, provider mutation, Telegram send or deployment was
introduced; live Cloudflare consent remains an acceptance gate.

## Automatic Codex PR publication (2026-10-18)

Removed the publication checkbox from the Codex configuration dialog and its
Enabled/Disabled summary row. Verified implementations automatically publish PRs
ready for review. Policy parsing fixes `publishByDefault` to true, including saved
false values, so removing the control leaves no hidden opt-out. Task authority
snapshots retain the fixed value; existing tasks with a different snapshot stop
at the configuration fence instead of acquiring new publication authority.
Analysis, questions, evidence checks, current GitHub permissions and verification
requirements retain their existing boundaries.

Validation passed Biome, strict TypeScript, build, **867 deterministic tests**,
**35 admin/loading browser scenarios** and **20 plugin permission/modal scenarios**.
Desktop/mobile screenshots cover saved summaries, light/dark editors,
loading/empty states, pending saves and recoverable errors. Regression tests cover
automatic publication without an explicit PR request, duplicate polling, read-only
analysis and cancellation of retained tasks with the old opt-out authority snapshot.

## GitHub App setup without icon uploads or a welcome modal (2026-10-18)

GitHub App creation no longer offers an icon download, upload instructions or an
upload acknowledgement in setup or Manage GitHub. Setup proceeds directly from
manifest registration to account authorization. Failed authorization remains
retryable, and an already authorized or connected workspace does not restart
authorization. Owners may customize the default badge independently in GitHub.
Once repository connection succeeds, setup opens the workspace directly; the
Welcome to RepoDesk modal, Get started action and confetti were removed.
The unused icon component, asset, styles and build copy were removed. The current
[UI preference](../design/ui-rules.md#github-app-creation-skips-manual-icon-setup)
supersedes the earlier guided branding step.

Validation: Biome, strict TypeScript and production build passed. All **27** admin
and focused onboarding browser scenarios passed with fake GitHub transports.
Desktop (1280px) and mobile (390px) creation/saved displays, loading, authorization
pending/error, installation waiting and direct workspace entry were visually
inspected. The final full Bun run passed **863 of 864** tests in the concurrently
edited workspace; the unrelated Review Bot test "Telegram follow-ups wait for a
Review Bot fix on the same PR" reproducibly received `cancelled` instead of
`queued`. Earlier access-link and Cloudflare OAuth failures passed in isolation
and on the final full run. No live GitHub account was connected for validation.

## Fresh VPS installation (2026-10-18)

The operator-requested reset of `169.58.58.71`, explicitly including application
data, deployed clean commit `cea5d410fa06b0e3c9cf2b420b1a3d7020238c99` (v0.1.39)
in bundle `1792281550088-85350776`. Previous database/runner/task volumes,
credentials, backups and deployment history were removed; fresh secrets were
generated. All four services became healthy. Public readiness and setup returned
HTTP 200; the fresh database had zero admins/workspaces and setup was unclaimed.
Public JavaScript/CSS matched the verified image. The host updater, cleanup timer
and separate Actions runners remained available.

Validation passed Biome, types, build, **863 deterministic tests**, exact-image
Node 24 runtime and full-stack Compose migration/rerun, readiness and backup/restore
smoke checks. The full browser suite could not start because port 3107 was already
occupied by another local test server; rendered UI was not verified. No bot/model
test, external account connection or webhook registration was initiated. First-run
setup and connections must be configured again. See the
[fresh-installation receipt](vps-deployment.md#operator-requested-fresh-installation-2026-10-18).

## v0.1.40 release preparation (2026-10-18)

Version advances to **0.1.40**, covering continuous Codex conversations and the
single coding workflow, scoped long-term memory, conversation-thread history and
statistics, and the Cloudflare plugin with browser authorization.

Release preflight found remaining admin/loading browser assertions for the removed
execution summary and Reviewed/Direct selector. They now check the publication
summary, absence of the selector and persistence of the independently saved PR
publication setting. Application behavior is unchanged by this correction.
Local Biome, strict TypeScript, build, Node runtime contract, **863 deterministic
tests** and **35 admin/loading browser scenarios** passed. Stable publication
requires the full Verify workflow to pass for the release commit.

The Reviewed removal is intentionally breaking: `executionMode`, issue-only runner
starts and the separate `developmentTasks` response collection are removed without
compatibility or migration. App/worker/supervisor/job builds must be upgraded together.
See [the current Codex workflow](codex-coding.md) and the release notes before upgrading.

## One Codex task workflow (2026-10-17)

Codex now uses one continuous task workflow. Removed Reviewed proposals, the
`coding_task` approval kind, legacy workspace task model/executor, and the old
Issue/`codex exec` runner path. There is no migration or compatibility bridge.
The strict settings contract rejects the removed `executionMode` field; publication
by default remains independent. Requests without that optional publication setting
can start source-bound intake normally. Existing GitHub issue/PR action approvals
remain separate application features.

The runner requires a continuous task envelope and rejects issue-only starts before
reserving execution. Questions and ordinary chat cannot grant implementation or
publication. Verified actor/repository access, original request evidence, audience,
cancellation, retention and durable publication checks remain enforced. Review Bot
fixes retain their own enabled setting and GitHub write checks without a Codex mode
dependency. A regression checks revocation before execution.

The admin configuration summary/editor has no mode selector or task-mode badges.
GET/PUT/logout return the same `tasks` collection, also used by Overview counts and
Stop. Saved summaries, editing, loading/empty, pending and failed-save recovery were
checked at 1280px/390px, including dark theme. The shared modal and Stop confirmation
contracts remain in use. Documentation, bundled tool guidance and examples agree.

Validation: Biome, strict TypeScript, build and **829 deterministic tests across
95 files** passed in the isolated feature checkout with disposable PostgreSQL.
The merged shared checkout also passed Biome, types, build and **863 tests across
98 files**, including the independent Cloudflare changes present there.
The relevant **40 browser scenarios** passed; the final configuration copy/assertions
and Stop flow were rechecked independently. App, supervisor, Docker job and
OpenSandbox job images built; the final app passed the Node 24 runtime contract.
Both Compose overlays validate. The full Docker lifecycle smoke passed with
continuous provider/device tasks, live questions across restart, checkpoint recovery,
repair, publication fencing, auth continuation, usage, erasure and cancellation.
A fresh one-iteration Docker benchmark fixture also completed with no failures.

No dependency or database migration was added. Upgrade app/worker/supervisor/job
builds together. No live model, GitHub/Telegram write or deployment was performed.

## Conversation-thread history and Telegram identity (2026-10-17)

The admin history list now shows continuous conversation threads at
`/admin/threads`, grouped by valid saved routing identity before pagination and
ordered by latest activity. Equal timestamps follow retained request order.
Cards show the initial subject, latest preview, request count, status, Telegram
names/usernames/IDs, group titles/IDs, topic IDs and participants. Missing profiles
use IDs. Legacy requests without a valid thread and scheduled requests stay separate;
ignored or unaccepted automatic follow-up classifiers are excluded.

Thread detail pages show chronological request/reply pairs, whole-conversation
statistics and per-request links to existing run diagnostics/actions. Thread and
request pages retain independent pagination through navigation and refreshes.
Sidebar/Overview use Threads and the matching count; old run-list URLs redirect
with their query parameters. Existing run-detail URLs and the request-summary API
remain available. Both new read endpoints preserve workspace admin/operator access,
including private histories; non-admin members, revoked members and foreign
workspaces remain denied. Telegram metadata is saved display data, not authority.
No dependency, database migration or live Telegram profile lookup was added.

Validation: `bun run check`, `bun run typecheck`, `bun run build`, all **869
deterministic tests across 97 files** with disposable PostgreSQL, and all **45
browser scenarios** across Threads, run details, Overview loading and admin passed.
Desktop/mobile screenshots at 1280px/390px were reviewed in light/dark themes,
including conversation identity, ordered requests/replies, pending/partial usage,
loading, empty and error/retry states. Checks cover pagination before/after grouping,
equal timestamps, legacy isolation, shared participants, profiles/ID fallbacks,
unlinked operator reads, member/revocation denial, cross-workspace IDs and retained
run navigation. No deployment, live model call or Telegram message was performed.


## Cloudflare plugin (2026-10-17)

Plugins now includes Cloudflare with a saved summary, title switch and shared modal
editor. Operators configure an encrypted write-only workspace token, account and up
to 20 explicit zones. Private interactive Pi requests can query selected zones/DNS
records and account Pages projects/deployments. Owners/admins can propose exact DNS
create/update/delete requests and URL/whole-zone cache purges. Existing actor-bound
approval controls authorize the reviewed payload; application services reserve and
execute writes. Duplicate workers cannot repeat mutations, and ambiguous outcomes
stay unknown without automatic retry. Pages environment variables and configuration
secrets are excluded. Current permissions/scope apply to reads, approvals, execution,
pending delivery and retained/derived evidence, including group-handoff exclusion.

Cloudflare saves preserve legacy file-plugin fallbacks and other built-ins; Code
Truth saves now preserve other built-in settings too. No package, migration or new
environment setting was added. Configuration changes apply without restart.
Workers, deployment creation, secrets and arbitrary API access remain outside scope.

Validation: Biome, strict TypeScript, production build, Node runtime contract and
all **863 deterministic tests across 96 files** passed with disposable PostgreSQL,
including **20 focused Cloudflare tests**. All **8 Cloudflare browser scenarios**
passed at 1280px/390px; saved/editor, empty, loading, pending, error/recovery and dark
theme screenshots were inspected. The expanded browser run passed **49 of 50**:
an existing Codex mobile loading test still measures its unchanged “Deployment
runtime” value at 48px against a 32px limit, reproduced in isolation. No live
Cloudflare/model/Telegram calls or deployment were performed. See
[configuration, API contracts and limits](cloudflare.md) and
[runnable examples](../../examples/cloudflare.http).

### Cloudflare browser authorization (2026-10-17)

Historical behavior, superseded by the direct-token panel above. New Cloudflare
connections originally defaulted to browser OAuth; existing API token connections
retain their authentication method. Operators register a Cloudflare client once,
then save its write-only secret, client ID and API scopes in the shared Authorization
editor. Connect uses Authorization Code, S256 PKCE and session/workspace/revision-bound
state. The callback verifies the configured account before enabling the plugin,
including the same tool-collision checks as manual enablement. Existing account,
zone, actor, destination and exact-action approval restrictions still apply.

Access/refresh tokens are encrypted per workspace and connection generation.
Durable refresh claims serialize workers without changing the plugin revision;
failed, ambiguous or interrupted refresh requires Reconnect without token replay.
Disconnect removes local authority before provider revocation, reports unconfirmed
revocation and fences late refresh results. Client/scopes/authentication changes
require disconnect first. Client registration, public-client domain verification
where applicable and live Cloudflare consent acceptance remain operator prerequisites.

Validation: all **863 deterministic tests across 98 files**, including **34 focused
Cloudflare tests**, and **14 Cloudflare browser scenarios** passed. Desktop/mobile
saved summaries, both editors, loading, pending, failure,
reconnect and disconnect states were visually inspected, including dark theme.
Biome, strict TypeScript, production build and Node runtime contract passed. No
package, migration or environment variable was added. No live account connection,
Cloudflare API mutation, Telegram send or deployment was performed. See the
[existing-connection compatibility notes](cloudflare.md#existing-oauth-connections).

## Codex task conversation (2026-10-17)

Direct continuous development tasks have a durable conversation separate from
implementation requirements. Chat Agent can formulate factual questions with
`ask_development_task`, read bounded history and receipts with
`development_task_conversation`, and relay new requirements through the existing
source-bound input tool. Questions never advance requirement revisions or grants.
Requirement receipt, dispatch, completed-turn reading and verification are separate.

Active implementation processes use an attempt-scoped mailbox and pinned app-server
`turn/steer`. Only explicit read/reply/progress tools cross this channel; other
server requests remain unsupported. Tokens stay out of the Codex child and other
phases, survive supervisor restart and rotate between launches. Claims persist
before steering. Idempotent mailbox acknowledgement retries cannot resend native
input; unconfirmed native delivery stays unknown. Replies and meaningful progress
arrive asynchronously in the original audience, with history available to Chat Agent.

Completed/waiting tasks can answer through a separate read-only execution without
changing their result, product question, PR or authorization. The existing unique
live-attempt constraint and a conversation pointer serialize subsequent coding
behind cleanup. Usage settles once. Frozen attempt identities handle unknown starts;
durable erasure tombstones also fence starts delayed until after cleanup. Source
expiry/deletion covers the dialogue and all recorded executions.

Validation on an isolated v0.1.39 checkout plus this feature passed Biome, strict
TypeScript, production build and **807 deterministic tests across 91 files** with
disposable PostgreSQL. This avoids unrelated concurrent UI, memory and Cloudflare
work in the shared checkout. The real pinned CLI **0.155.1** passed a local fake-provider
proof for initial/live questions, reading, answers, progress, token accounting and
restored tools on session resume. App, supervisor, Docker job and OpenSandbox job
images built; the app passed its Node 24 contract and both Compose overlays validated.
The full Docker lifecycle smoke passed, including duplicate questions and an
active conversation surviving supervisor restart. Earlier smoke failures exposed
a fake GitHub transport intercepting the private channel; the fixture now permits
only those two scoped channel endpoints through its real local transport.

No dependency or database migration was added. Matching app/worker/supervisor
builds are required. Live model quality, Telegram delivery and a deployed OpenSandbox
repeat remain separate rollout checks. Reviewed legacy task coverage is not implied
by this Direct-task evidence. See [the conversation journey](../../examples/codex-task-conversation.md).

## Private and shared long-term memory (2026-10-17)

RepoDesk now extracts source-linked historical memory from successful idle
conversations and consolidates a small recall index. Personal recall crosses
the same user's private Topics; shared recall crosses participants only within
the same bot/group/Topic. Workspace, actor, bot and source permissions remain
enforced. Existing discussion records and context compaction remain separate.

The independent worker checks once per minute, with a 30-minute idle window,
bounded tool-free Pi extraction/consolidation, durable leases and checkpoints,
hourly retry backoff, and no automatic replay of unknown provider outcomes.
Charges use the originating request's pinned model and remaining dollar budgets
and are recorded as separate memory attempts. Recent input is bounded while full
retention dependencies remain tracked. State uses existing workspace JSONB;
there are no added dependencies or SQL migrations.

`query_memories` supports bounded historical recall; direct `manage_memory`
requests remember the human's actual message, forget a selected record, or toggle
scoped recall. Shared settings and deletion of another speaker's or mixed-speaker
records require a workspace owner/admin. Source edits, retention, forgetting and
workspace deletion invalidate derived context. Content-free tombstones prevent
forgotten sources from being automatically re-extracted. Memory cannot grant
external-write authority or become an approved instruction.

The **31 dedicated deterministic memory tests** passed with disposable PostgreSQL.
An isolated v0.1.39 checkout containing only this feature passed all **820 tests**,
Biome, strict TypeScript, the production build and the Node runtime contract.
Coverage includes JSONB identity stability, private/shared isolation, current-user
intent, ownership, source edits/deletion, long input, redaction, budget failures,
concurrent claims, usage replay and checkpoint recovery. No live model call,
Telegram send or deployment was performed. Recall fidelity and live Telegram
acceptance remain release gates. See [design and limits](../design/long-term-memory.md)
and [examples](../../examples/long-term-memory.md).

## Run detail statistics (2026-10-17)

Individual run detail pages now lead with message/tool-call counts, model attempts,
reported total tokens, cache hit rate and recorded actual USD spend. Message counts
share the displayed transcript's entries; tool calls merge retained call IDs with
durable records without counting tool results again. Tokens and charges aggregate
all recorded attempts, including follow-up and compaction. Cached reads and writes
count toward input; only cached reads count toward the hit rate. Missing and
partially reported usage/charges remain explicit. No API, dependency or migration
was added. Runs remain individual requests; continuous chat threads are distinct.

Validation: strict TypeScript, production build, scoped Biome checks, all **794
deterministic tests** with disposable PostgreSQL, and all **15 Runs browser
scenarios** passed. Desktop/mobile screenshots were reviewed for populated,
loading, error, pending, partial and empty usage states, including light/dark
themes. Repository-wide Biome reported formatting/import issues in concurrently
edited Codex conversation files outside this change. No deployment or live
provider/Telegram call was performed.

## v0.1.39 release preparation (2026-10-17)

Release preflight caught Docker-specific credential ownership checks leaking into
the simulated runtime under the CI runner's UID, plus browser fixtures missing
the new runtime endpoint and expecting the previous configuration label. Ownership
preparation now belongs to the Docker driver; real Docker retains its private
credential permissions and job UID requirements. Browser fixtures supply a valid
runtime response and assert the current deployment-runtime label.

Biome, strict TypeScript, the production build and all **789 deterministic tests
across 90 files** passed with disposable PostgreSQL. The **32 runner tests** also
passed in a network-disabled UID-1001 container, and **23 browser scenarios** passed
for loading, connection-error recovery and session expiry. Full GitHub Verify and
exact-image checks remain separate release gates until their results are recorded
in the published release notes.

## Telegram PR code and review evidence (2026-10-17)

The default GitHub extension now registers `query_github_pull_request` alongside
the existing metadata tool. Members can read each connected-repository PR's
changed files/patches, review records and inline comments for implementation
comparisons. The bundled GitHub skill directs comparisons to actual code evidence
and distinguishes a summary-tool capability gap from a failed GitHub permission
check. Missing installation grants return specific recovery guidance.

Reads request only a fresh, single-repository Pull-requests-read installation
token. Existing tenant, member, upstream repository, private-chat and approved
workflow-source boundaries apply throughout network reads. Each page checks PR
identity and head/base commits before and after fetching; later pages require the
returned commit pins. Changes reject mixed-commit evidence. Response budgets,
missing patches, pagination and the 3,000-file/150-page limits remain explicit;
review records are live and retain their own commit provenance.

Validation: Biome, strict TypeScript, production build and the Node runtime
contract passed. All **789 deterministic tests across 90 files** passed with
disposable PostgreSQL, including ten new PR-detail scenarios and default-agent
tool registration. Coverage includes differing PR patches, read-only token scope,
pagination and missing evidence, commit changes, permission revocation at each
network stage, tenant/member/private-group boundaries and missing-grant guidance.

No dependency, migration, write grant or new deployment configuration was added.
Live GitHub/model comparison quality and rollout to the existing app/worker remain
release gates. See [setup and limits](github-app.md#read-pr-code-changes-and-reviews-from-telegram)
and [the runnable comparison journey](../../examples/github-pr-comparison.md).

## Admin-panel Codex runtime selection (2026-10-17)

**Plugins → Codex → Runtime → Edit** selects Docker or
OpenSandbox for the whole deployment, or follows `CODEX_CONTAINER_ENGINE`.
The saved panel override survives supervisor restarts. Optional per-engine images,
OCI sockets and shared sandbox paths prepare alternate host profiles; the panel
never returns or edits their management credentials.

Operator/session/Origin/CSRF checks protect changes, followed by the supervisor's
authenticated management API. Revision checks reject stale writes; task starts and
switches are serialized. A different engine must pass readiness before saving and
cannot replace an engine with retained tasks/checkpoints, including completed work.
Corrupt, oversized or symlinked saved selection files fail closed. Unconfirmed
saves, including a failed audit acknowledgement after the runner commits, instruct
the operator to read the current selection before retrying.

Validation: Biome, strict TypeScript, production build and **789 deterministic
tests across 90 files** passed with disposable PostgreSQL. **36 relevant browser
scenarios** passed across runtime selection, account authentication, Codex Stop,
overview and logs. Runtime saved/editor, pending, loading, error and unavailable
states were inspected at 1280px and 390px, including dark mode. The mobile Edit
action stays at the top right. Final app/supervisor images built; Node runtime and
authenticated runtime API/persistence/restart image checks passed. Docker
Compose validation and the full Docker smoke passed, including checkpoint repair,
publication fencing, device continuation, erasure and cancellation. No application
deployment or production backend switch is implied. microsandbox and Podman were
removed at the user's request, including adapters, profiles and panel options;
removed environment/saved selections fail closed and browser coverage asserts
that the choice is absent. See [configuration and limits](codex-sandboxes.md).

The default and local startup script use Docker. Shared container helpers moved
to `container.ts`; no Podman executable is installed in the supervisor image.
Its uncompressed size dropped from 951,122,785 to 849,540,010 bytes (about 97 MiB).
Native UID 1000 supervisors retain private task credentials without a root-only
ownership change; the root container path preserves the job UID before copying.
The runner guide is now `codex-runner.md`. Existing approval/protocol wire values
remain stable, with no Podman execution path or automatic data migration.

## Landing-page live-test environment (2026-10-17)

The dedicated [landing repository](https://github.com/stonega/repodesk-landing)
has a committed `baseline-v1`, a published Cloudflare page and a manually triggered
branch preview. Local/CI checks and desktop/mobile browser acceptance passed. The
existing VPS Codex job image also passed a credential-free fresh-clone/install,
check, typecheck, unit-test and build preflight in disposable isolated storage.
The existing GitHub App can access the new repository; a host-operator action
selected it for the workspace and synchronized the existing verified user account.

The requester approved the concrete proposal through the existing Reviewed flow.
The real Docker task produced [PR #2](https://github.com/stonega/repodesk-landing/pull/2)
with passing Verify jobs and a native Cloudflare `github:push` preview. The earlier
automatic-preview gate is resolved by that observed deployment. Additional VPS
OpenSandbox acceptance produced [PR #3](https://github.com/stonega/repodesk-landing/pull/3),
also with passing Verify/Cloudflare checks and desktop/mobile deployed-preview
acceptance. The five-trial fixture comparison, failed first OpenSandbox attempt,
prepared-browser retry and microsandbox exclusion are recorded separately in the
[VPS comparison](../research/sandbox-vps-2026-10-17.md). See the
[acceptance receipt](codex-landing-acceptance.md).

## Alternative Codex sandboxes and benchmark harness (2026-10-17)

The local supervisor supports deployment-selected OpenSandbox
alongside Docker through a typed phase-runtime interface. Existing workspace
policy, authentication ordering, task fencing, repair and publication remain in
the supervisor. The OpenSandbox SDK dependency is pinned to 1.1.1 and loaded only
when selected. OpenSandbox uses private authenticated management and shared host
storage.

Fresh phase environments retain task-scoped work storage, read-only inputs,
implementation-only account credentials/model tokens and separate publication
storage. Durable sandbox/job identities survive restart; uncertain launches do
not replay. Cleanup retries after failures, and retained records reject backend
switches. OpenSandbox has a dedicated execd-compatible image target, pinned
companion images, deny-default egress and documented SELinux storage labeling.

`bun run benchmark:sandboxes` runs a credential-free Git/file/check/patch and
simulated-publication fixture across selected engines. It records phase and
operation timings, P50/P95, host/SDK metadata and explicit failures, and cleans
only its own task identities. Real Docker and self-hosted OpenSandbox have each
completed the entire fixture on this host. The earlier microsandbox experiment
was removed at the user's request after the VPS lacked KVM; its SDK, adapter and
configuration are absent. This does not measure live model execution, dependency
downloads or remote GitHub publication.
Prewarmed pools, memory snapshots and cross-task dependency caches are not enabled.
See [setup, commands and verification boundaries](codex-sandboxes.md).

Validation: Biome, strict TypeScript, production build and all **767 deterministic
tests across 87 files** passed with disposable PostgreSQL. The 48 focused runner
tests include new phase/credential isolation, restart/deduplication, uncertain
launches, cleanup retry, artifact bounds/symlinks, backend mismatch and SDK command
identity/ownership checks. Initial full runs encountered two unchanged flaky
fixtures; their focused reruns and the final full suite passed. That initial local
implementation pass performed no migration, production backend switch, live
model/account call or GitHub/Telegram write. Subsequent authorized VPS acceptance
is documented separately above.

Final app, supervisor, ordinary job and OpenSandbox job images built. The app's
isolated Node runtime contract, Docker Compose validation and the real
Docker smoke passed, including fake provider/device auth, parallel capacity,
restart, question reconstruction, repairs, publication fencing, erasure and
cancellation. The initial local sandbox comparison also passed without failures;
its small-sample timings and limits are recorded in the sandbox guide. Temporary
test database, task containers, comparison network and OpenSandbox server were
removed/stopped.

## Invite links use a circular countdown (2026-10-15)

The invite card replaces its visible countdown text row with a small animated
circle immediately after the title, keeping the final word and circle together
when the title wraps. The ring counts down the existing ten-second refresh,
spins while refreshing and pauses on errors. Screen-reader text and a hover
tooltip retain timing/status; reduced motion disables transitions and rotation.

Verification: Biome, strict TypeScript, production build and all 751 deterministic
tests passed with disposable PostgreSQL. Eight focused browser checks passed at
1280px and 390px, covering placement, countdown/reset, copying, member updates,
loading, pending, errors/retry, navigation cleanup and reduced motion. Light/dark
saved cards and desktop/mobile loading, pending and error previews were inspected.

## Compact skill instruction previews (2026-10-15)

Preset and custom skills share a compact saved preview: labeled settings in a
responsive grid, required tools as wrapping tags, and a short empty-workflow
message. Complete instructions and populated dependent-workflow details remain
readable. Management actions stay at the top right when titles wrap; custom
editing remains in its modal and presets retain toggle-only controls.

The same Team recap browser fixture shrank from 756px to 393px at a 1280px
viewport (48%) and from 968px to 625px at 375px (35%). Both themes, expanded and
collapsed previews, pending/error toggles, long content, empty tools/dependencies
and saved display/editor separation were checked with deterministic fixtures.
Biome, strict TypeScript, the production build, all **751 deterministic tests**
with disposable PostgreSQL and **48 browser scenarios** across skills, GitHub
imports, workflows and admin management passed. A broader run encountered a
missing trace artifact during browser cleanup; the 26-scenario admin/preset rerun
passed with an isolated server and output directory. No dependency or database
migration was added.

## VPS deployment of invites and member account updates (2026-10-14)

The VPS at `https://dev.stonegate.me` serves package v0.1.37 from clean commit
`1afd6f5f58b2a5b31a9e1006ec6bcdc7ffadd526`, deployed through manual archive bundle
`1791965539905-97510167`. This includes single-account invites with the ten-second
link countdown, corrected GitHub member sources/custom usernames and the member
GitHub View text button.

The commit's [Verify run](https://github.com/stonega/repodesk/actions/runs/38523891650)
passed. The exact release images also passed local Node runtime, Compose health,
migration rerun, protected backup and disposable restore checks before transfer.
The VPS verified the image/source checksums and coding checkpoints, created and
verified its protected pre-release backup, and completed migration/startup checks.
All four production services are healthy. Public health, readiness and admin
requests returned HTTP 200; all three served JavaScript/CSS assets matched the
verified image. The bundle retains CI, source and post-deployment receipts.

Runtime configuration, encryption key, runner token, persistent database/runner
volumes and the existing PostgreSQL/CI runner container identities were preserved.
No migration was added. This verifies a manual archive cutover; the published
release updater's direct local-image path remains a separate live gate.

## Single-account invites and link countdown (2026-10-14)

Members & access now shows a signed Telegram invite that refreshes every 10 seconds
with a countdown. Its first actual Telegram sender receives regular membership
automatically, without an approval decision. Each token binds to one account in
the workspace's locked inbox transaction. Concurrent claims and duplicate events
cannot enroll another account; replay after revocation cannot restore access.
Existing active roles are preserved, inactive administrators rejoin as members,
and revoked owners still require recovery. Bot identity, tenant, private-chat
sender, signature and expiry checks remain application boundaries.

Copied links remain valid for 24 hours independently of the display refresh.
Only hashed claims are persisted; expired claims and workspace purge remove them.
Redemption records membership/audit and default private selection, resolves a prior
pending request, and queues the fixed welcome reply without model/tool execution.
It also works before activation. Ordinary requests and old workspace-ID links
still require manual approval.

The read-only link card retains its monospace URL and one-second copied icon,
keeps the URL visible during refresh, and pauses with an error toast and Retry on
failure. Membership changes discovered by refresh update the member table.

Verification: `bun run check`, `bun run typecheck`, `bun test` against isolated
PostgreSQL (751 passing tests), and `bun run build`; eight focused Playwright
checks cover countdown/rotation, copying, member refresh, loading, pending,
error/retry, navigation cleanup and existing manual decisions. Rendered states
were inspected at 1280px and 390px. No live Telegram calls were used.

## GitHub member choices and custom usernames (2026-10-14)

Member lookup now returns the personal installation owner directly or organization
members from `GET /orgs/{org}/members`. It no longer inspects repositories or their
collaborators. Personal lookup requests no installation access token. Organization
lookup retains Members-read permission checks, pagination, stable-ID deduplication
and the cancellable 60-second directory budget.

New/Edit member dialogs also offer **Enter a username**, usable during directory
loading, empty results or lookup failures. Saving resolves the username through
GitHub's public user API and stores its canonical login and numeric ID as an
unverified association. Invalid/unavailable users and organization names retain the
draft. Duplicate identities, stale membership/connection revisions, changed workspace
authority and replacing verified identities are rejected. Saved custom accounts can
be reopened, reselected and cleared; assignments create no repository grants.

Biome, strict TypeScript, the production build and **751 deterministic tests** with
disposable PostgreSQL passed. All **22 member browser scenarios** passed, including
custom input, failed lookup/save recovery, draft retention, Cancel, verified-account
protection and pending-save locks. Rendered New/Edit and saved View dialogs were
inspected at 1280px and 390px, including loading, empty, pending and error states.
GitHub calls used fake transports; live GitHub acceptance remains pending. No new
dependency or database migration is needed.

## VPS deployment of skills and provider metadata (2026-10-14)

The earlier VPS rollout deployed package v0.1.36 from clean commit
`2dd613aae9fe14abf07fcbc15abfc4d87e940571`, deployed through manual archive bundle
`1791958130084-55435898`. The bundle retains the checksum-verified source archive,
image metadata and local verification report. This rollout includes GitHub skill
imports, read-only presets, typed provider metadata, completed-setup navigation
and the saved-card action layout changes documented below.

Biome, strict TypeScript, the production build, **737 deterministic tests** with
disposable PostgreSQL and all **239 browser scenarios** passed. All three release
images built locally. The exact application's Node 24 runtime contract, isolated
Compose configuration and service health, migration rerun, backup and restore
rehearsal passed. Disposable test containers and volumes were removed.

The protected cutover waited for durable coding checkpoints and verified the
mode-600 backup
`/opt/repodesk/backups/pre-release-1791958130084-55435898.dump`. All 19 existing
migrations remain applied; this release adds none. App, worker, Codex runner and
PostgreSQL are healthy. Public health, readiness, the admin page and its scripts
and stylesheet returned HTTP 200. Running app, worker and supervisor image IDs,
and the runner's configured task image, match the imported release images.

Runtime configuration, the encryption key and runner token passed preservation
checks. Database and runner-state volumes, PostgreSQL and all three Actions runner
container identities were preserved; the host updater remains active. The source
archive transfer resumed after an SSH disconnect while production remained healthy.
This verifies the manual archive rollout, without completing the published-release
local-image updater gate or live GitHub/provider/Telegram acceptance checks.

## Preset skills use enable/disable only (2026-10-14)

Team recap and Follow-up draft are read-only presets. Their cards show a Preset
badge, saved description/instruction preview and one enable/disable action, with
no editor, archive, publishing, policy test, revision counts or rollback controls.
Catalog pages containing only presets omit the sample policy form. Custom,
conversation-created and GitHub-imported skills retain their editors and version
management.

The API rejects preset edits, tests, publishing, rollback and archive with
`preset_skill_read_only`. Admin authorization and optimistic revisions still guard
enable/disable, and disabling keeps existing run/workflow revocation behavior.
Internal published snapshots and pins remain intact. New seeds are marked as
presets; unchanged legacy seeds are recognized without rewriting their contents
or tool grants. Previously customized or archived seeds remain custom, including
when a customized draft is restored to the original text.

Validation passed Biome, strict TypeScript, production build, the **737-test full
suite**, and focused policy/API tests after the legacy classification check was
strengthened. **46 browser scenarios** passed across presets, existing skill search,
GitHub imports, admin management and team workflows. Seven new preset scenarios
cover toggle-only controls, read-only previews, pending locks, errors and retained
custom editing. Desktop (1280px) and mobile (375px), light/dark presets and
pending/error states were inspected. The initial full run had three unrelated
budget/model test timeouts; the isolated 51-test suite and full rerun passed.
No dependency or SQL migration was added. See [preset API examples](../../examples/preset-skills.http).

## GitHub skill imports and source updates (2026-10-14)

Agent skills imports accept GitHub repository, folder and `SKILL.md` links. The
modal discovers nested skills, reports incompatible files and imports the selected
files as disabled, unpublished drafts. Connected private repositories use the
workspace operator's GitHub App with a repository-restricted Contents-read token;
public reads carry no credentials. No dependencies or SQL migrations were added.

Saved cards show repository/ref/path and imported commit. **Check for updates**
compares the tracked file, previews current and incoming instructions, and saves
an update draft. Local edits need explicit replacement. Stale source commits,
stale skill revisions, removed files and revoked connections preserve saved
content. Published versions, enablement and scheduled version pins remain intact.
Updates are initiated in the panel; no automatic syncing or publication is claimed.
Imports retain the existing Markdown/frontmatter/tool limits and do not include
supporting bundles or executable files.

Validation passed Biome, strict TypeScript, production build and **732 deterministic
tests** against disposable PostgreSQL. **22 browser scenarios** passed across the
GitHub imports, existing skills catalog and team-workflow suites, including eight
new GitHub scenarios. Desktop (1280px) and mobile (375px) saved summaries, import
discovery, pending locks, update review and failures were inspected; update review
and saved updates also passed dark-mode inspection. GitHub API responses were
deterministic fixtures; live GitHub App acceptance remains unverified.
See [skill design](../design/agent-skills.md) and
[runnable API examples](../../examples/github-skills.http).

## Typed provider pricing and context discovery (2026-10-14)

Provider New/Edit dialogs now include a type: automatic detection, OpenRouter,
self-hosted New API, OpenAI, DeepSeek, Mistral, Groq, xAI or another compatible API.
The standalone [model metadata module](../../src/model-metadata/README.md) fetches
model IDs and available API context/output/token-price data on provider saves.
OpenRouter token prices are normalized to USD per million tokens. New API adds
anonymous public pricing discovery, preserves proxy prefixes and requires the
key's configured billing group before applying token/group/cache ratios. Price
failures preserve model discovery; per-call and expression billing remain unknown.

Official APIs without price/capacity data use provider-specific bundled Pi catalogs,
clearly labeled separately from API data. Current DeepSeek Flash/Pro aliases retain
both peak/off-peak prices and separate cached/uncached input rates from an official
reference checked 2026-10-14. Peak is the default conservative estimate; advanced
chat settings can explicitly select Off-peak estimates. This choice is not automatic
clock/holiday billing. Manual input/output/cache-read/cache-write overrides remain
independently optional and support the existing currency conversion contract.

Saved summaries and modal editors show automatic information separately from
overrides, with sources and units. Tier comparisons expand on demand; missing
metadata is explained without inventing free prices or context caps. A blank context
override still defers enforcement to the provider. Chat runs pin fetched metadata,
the selected price tier and overrides; provider updates never revalue history.
Reservations cover the highest input/cache rate. Ownership, encrypted keys,
version checks, bounded responses and redirect denial remain enforced. Model lists
still do not prove inference protocol support.

Validation passed Biome, strict TypeScript, production build, the Node runtime
contract and **732 deterministic tests** against disposable PostgreSQL. All **20
model-provider browser scenarios** passed, covering type/group selection, cached
price overrides, tier persistence, cancellation, pending locks, failed saves,
loading/empty states and the existing setup/currency/service choices. Saved
summaries, editors and pending/error states were inspected at 1280px and 390px in
both themes. No dependency or database migration was added. No deployment or live
provider inference, account connection or Telegram send was performed.

## Completed setup navigation (2026-10-14)

Deployment navigation hides Setup when the authenticated progress API reports an
active deployment. Inactive deployments retain the resumable link. The entry is
absent until the activation state is known; navigation rechecks it and ignores
responses from earlier routes or sessions. Deployment pause does not reopen setup.
New workspace and direct setup routes remain available. Ordinary members do not
request operator-only setup progress.

Validation passed Biome, strict TypeScript, the production build and **721
deterministic tests** against disposable PostgreSQL. **29 browser scenarios**
passed, including 11 focused setup-navigation checks and existing sidebar,
sign-in and session-expiry checks. Desktop (1280px) and mobile (390px), both themes,
complete/incomplete, pending and failed status views were inspected. No dependency,
migration or deployment was added.

## Model-price currency selection (2026-10-13)

Bot chat model price overrides in setup and Model settings now support USD, CNY,
TWD, HKD, EUR, GBP, JPY and SGD. Existing prices default to USD. Non-USD selections
require an explicit positive `usdRate` (USD per currency unit), retained until edited.
The runtime converts only entered overrides, including input overrides used for
cache pricing; catalog fallback costs already use USD. Budgets and usage totals
remain USD. Original prices, currency and rate are pinned in each run, so later
edits do not revalue history. Prices remain independently optional, with unknown
custom prices distinguished from zero. No automatic exchange-rate lookup is used.

The shared dropdown and modal editor retain entered prices when currency changes,
clear the previous rate, and show currency codes and the saved rate in summaries.
Cancel discards drafts; failed saves retain them; pending saves lock dismissal and
duplicate submission. Model save errors scroll into view with Save and Cancel on
mobile.

Validation of the isolated currency change passed Biome, strict TypeScript, the
production build and **704 deterministic tests** against disposable PostgreSQL.
All **16 model-settings browser scenarios** passed, including non-USD setup,
reload persistence, validation, cancellation, save failure and pending locks. Saved
summaries/editors were inspected at 1280px and 390px in both themes; loading, empty,
pending and error states were also inspected at both widths. No dependency or
migration was added, and no deployment or live provider/Telegram call was performed.

## VPS deployment of GitHub plugin permissions (2026-10-13)

The recorded VPS serves package v0.1.36 from manual archive bundle
`1791874171029-72300379`. Its immutable source snapshot is
`bd6c3dc446f33b72e3bd68793b31769de0617a4f`, based on `68630a5` plus the
GitHub permission changes below. The bundle retains its source archive and image
checksum metadata; this snapshot does not identify a published GitHub release.

The app, worker, Codex runner and PostgreSQL are healthy, and
`https://dev.stonegate.me/readyz` returned HTTP 200 after cutover. Running app,
worker and supervisor image IDs match the verified snapshot. Migrations 018 and
019 are applied; no workspace retains legacy Codex or Review Bot repository arrays.
The deployment waited for durable coding checkpoints and verified the mode-600
backup `/opt/repodesk/backups/pre-release-1791874171029-72300379.dump` before
migration. Existing configuration, secrets, volumes, updater and all three Actions
runners remain in place.

All three release images built locally. The Node runtime contract, isolated
Compose app/worker health and migration rerun, offline Open Code Review preparation
and deterministic Docker Codex checkpoint/authentication/publication smoke checks
passed. Local fixture containers and volumes were removed. These checks do not
complete the live Telegram/model pilot or the published-release local-image updater
gate.

## GitHub permissions for Codex and Review Bot (2026-10-12)

Codex and Review Bot no longer have repository lists, Add/Edit/Remove actions,
maintainer grants or automatic review owners. Their saved configuration summaries
open shared modal editors for plugin-wide workflow settings. GitHub owns repository
permissions; Codex uses the repository's GitHub default branch. Verified write access
is required for coding. Tagged fixes use the PR’s actual base/head instead of a
separate configured branch. Tagged reviews/answers require verified read access;
fixes require write access. Automatic reviews use the enabled operator-owned App policy.
Workspace membership, tenant connection scope, request approvals and scoped App tokens
remain enforced before execution/publication. Task initiators can still stop their own
work after losing GitHub access.

Migration `019_github_plugin_permissions.sql` removes current plugin repository grants,
advances affected revisions and preserves historical task/approval evidence. Mixed
legacy execution choices become Reviewed; publication and review options remain enabled
only when all previous targets agreed. Fixes also require the resulting Direct policy.
Conflicting Review Bot destinations retain the lowest workspace ID and disable the
others for operator review. Later connection overlaps route once to the same stable
workspace choice. Tasks in other workspaces reauthorize before further execution
or publication. Reapplying the migration makes no further change. Older clients
cannot restore repository grants on save.

Validation passed Biome, strict TypeScript, production build, the host Node runtime
contract and **707 deterministic tests** against disposable PostgreSQL. **82 browser
scenarios** passed across the affected plugins, authentication/loading/task/card flows
and the existing admin journey. A final **44-scenario** pass verified the Codex feedback
placement and device/authentication flows; two focused Review Bot page-error recovery
checks also passed. Desktop (1280px) and mobile (390px), both themes, saved summaries,
editors, loading, empty, pending, errors and conflict recovery were inspected. Save
failures retain drafts and keep feedback, Save and Cancel visible together. No dependency
was added. No deployment, live account connection, GitHub/Telegram send or model call
was performed; existing live release gates remain.

## Optional assistant limits and model settings (2026-10-12)

Model calls per run has been removed from Team summaries, editors, workspace
settings and ordinary assistant execution. Follow-up classification and conversation
compaction no longer consume a workspace call quota; each internal tool-free pass
still has its own one-call bound. Migration `018_remove_model_call_limit.sql` removes
current saved overrides and advances affected workspace versions once. Older clients'
`maxTurns` is discarded on save. Historical run snapshots remain audit evidence and
do not enforce call quotas.

Run and monthly USD budgets default to None (`null`), meaning unlimited. Clearing
a field restores None; entered zero permits only zero-cost requests. Existing
explicit budgets remain configured. Atomic reservations still enforce configured
caps, including current and pinned run budgets, concurrent requests and unknown
charges. Summary/editor, Usage and Telegram accounting show unlimited values clearly.

Context window, maximum output and both token prices are independently optional.
A blank context window leaves enforcement to the provider for known and custom
models; there is no invented app context-window cap. Catalog context metadata
remains available for conversation-memory planning, while the provider-context
choice is pinned separately on runs. Explicit context/output overrides retain local
validation. Output allowance uses configured/catalog values or the documented
automatic allowance for unknown models. Missing custom prices remain unknown,
retain token usage and are excluded from dollar totals. Finite dollar budgets require
known prices and reconciliation of earlier unpriced charges. Verified charge
reconciliation retains authorization and replay protections.

Team save errors now appear above the primary action and Cancel, keeping both
buttons together on mobile. Version conflicts preserve the reload action and draft.
Local verification passed lint, strict TypeScript, production build, **701 deterministic
tests** against disposable PostgreSQL and **19 focused browser scenarios** on an
isolated port and fixed UI build. Desktop (1280px) and mobile (390px) summaries,
editors, loading, empty, pending, error, clearing, zero and conflict recovery states
were checked. No application deployment or live provider/Telegram calls were made
by this change.

## Automatic activation after model setup (2026-10-12)

Model settings now contains provider and chat-model summaries with their shared
modal editors. The separate Activate the bot card, activation action and duplicate
inline access form are removed. Members & access retains enrollment, revocation
and access requests; Operations retains optional Telegram account verification.
Setup and token-replacement guidance describe automatic activation.

A successful workspace chat-model save attempts activation on the server. Saved
bot credentials, a ready receiver and an enabled published skill in a workspace
with a valid operator-owned model selection remain prerequisites. If Telegram or
skills complete later, receiver/worker recovery activates automatically, including
after restart. Legacy model credential saves also reconcile readiness. Activation
locks and rechecks configuration, commits its audit once, preserves deployment
pause and accepts empty membership without granting anyone access. Failed writes
leave activation inactive and retain the saved model for recovery. The manual API
remains compatible and validates receiver readiness before returning idempotently.
Webhook registration remains explicit in Site domain; no model generation call is
used as a setup test.

Validation: lint, strict TypeScript, production build and all **701 deterministic
tests** across 79 files passed with disposable PostgreSQL. **27 admin/provider
browser scenarios** passed in webhook mode and **five focused setup/loading/save
scenarios** passed in polling mode. A final **13 focused model/setup browser
scenarios** also passed before commit. Desktop (1280px) and mobile (390px) saved,
empty, editor, loading, pending and error screenshots were inspected. This change
adds no dependency or migration and performs no deployment, live account
connection, Telegram send or model call.

## Three isolated Actions runners (2026-10-10)

The Actions Compose deployment now provides `runner`, `runner-2` and `runner-3`.
Each service has separate registration/work and Docker-data volumes, so up to
three jobs can execute concurrently without sharing Docker daemons, CI database
ports or disposable stacks. The original service and volume names are preserved.
Each runner has a two-CPU ceiling and 2 GiB memory limit, for a combined 6-GiB
memory ceiling on the recorded four-CPU, 8-GiB VPS. CPU capacity remains shared
with production; the browser suite still executes on one Playwright worker.

Validation: lint, strict TypeScript, build, **683 deterministic tests** against
disposable PostgreSQL, the Node runtime contract and shell/Compose checks passed.
The runner image built locally and passed Docker-in-Docker resource-limit and
cleanup smoke tests locally and on the VPS under the new 2-GiB limit. All three
deployed daemons passed simultaneous HTTP checks on the same internal port and
nested CPU/memory/PID-limit checks. See [runner operations](self-hosted-runner.md).

The recorded VPS now has `repodesk-vps` (original ID 21), `repodesk-vps-2` (ID 22)
and `repodesk-vps-3` (ID 23) online with healthy Compose containers. The original
registration and Docker volumes remain. Production readiness is HTTP 200. No
application release or workflow dispatch was performed by this change; complete
Verify timings with three runners remain unmeasured.

## Operations summaries and modal controls (2026-10-10)

`/admin/operations` now shows labeled health values, deployment activity,
workspace setup status and operator audit records without inline forms. New
panel accounts, identity verification, workspace access recovery and redacted
run inspection open focused dialogs. Account and verification results stay in
separate readable summaries. Cancel discards drafts; failures retain input;
pending actions show operation-specific progress and lock dismissal/duplicates.

Deployment pause/resume requires confirmation with the loaded revision. A
conflict keeps the error in the dialog and requires reloading before confirming
again, with the primary action and Cancel kept together. Initial loading keeps
labels and skeleton values visible; failed loads show unavailable states and a
retry toast. Workspace-dependent actions require loaded, non-removed choices.
Background refresh retains content and the dialog trigger's focus.

Validation: lint, strict TypeScript, build, **683 deterministic tests** against
disposable PostgreSQL and **18 Operations browser scenarios** passed. Desktop
(1280px) and mobile (390px) summary/editor, loading, empty, pending and error
screenshots were inspected, including light/dark layouts. No dependency,
migration, deployment, live account connection or external message was added.

## In-card log pagination and refresh menu (2026-10-10)

Runtime logs now keep the shared pager inside the entries card, below the table
and outside its horizontal scroll area. Blue chevrons surround a regular 14px
current range; the separate Page label is removed. Cursor history, filter/search
resets, loading locks and empty/error recovery remain supported. The API still
has no total count, so the reference's total is not invented.

The five-second checkbox is replaced by an Auto-refresh menu with 10-second,
30-second, one-minute (default), five-minute and Off choices. A left checkmark
identifies the selection; Refresh now sits below a divider and reloads the current
page. Latest logs still returns to the newest page. Changing intervals replaces
the timer without fetching immediately; pending requests and older pages pause
automatic refresh. Refresh now disables during requests. The shared popup supports
a bounded wider menu and upward placement when needed on mobile; its existing
dropdown defaults remain unchanged. Arrow/Home/End navigation, Escape, Tab and
outside dismissal preserve focus and touch targets.

Validation: lint, strict TypeScript, production build and all **683 deterministic
tests** passed with disposable PostgreSQL and host proxies disabled. **39 browser
scenarios** across Logs, Runs, dropdowns and admin passed, including a corrected
timer-test selector; the focused dropdown/log run passed all 12 scenarios.
Populated and open-menu screenshots were inspected in both themes at 1280px and
390px, plus loading/error/empty states at both widths. No dependency or API change
was added; no deployment was performed.

## Automatic Docker storage retention (2026-10-10)

Added an optional daily host cleanup timer and a dry-run-first release image
policy. It retains the current release, two complete app/job/supervisor image
sets, fresh builds and every existing container reference. Image aliases share
protection; changed/newly referenced images are rechecked. Host containers,
volumes, credentials, backups and metadata are outside the deletion policy.
Unused host build cache has a 4GB retention target. Cleanup and verified host
builds share a storage lock; direct cutovers retain their deployment lock.

The Actions runner image enables Docker-driver cache GC with a 2GB target and
a bounded synchronous post-job hook. Only a daemon labeled `repodesk.ci=true`
can remove old unused CI images, unused build cache and unreferenced disposable
CI volumes. The outer runner/registration and production state stay intact.
See [retention and activation](storage-cleanup.md).

Verification: lint, strict TypeScript, build, **683 deterministic PostgreSQL tests**,
Docker runner/application builds, Node runtime contract, Compose configuration,
shell syntax and systemd units passed. The real isolated runner smoke removed an
unreferenced test volume and retained a stopped container's volume/image. A
read-only VPS preview found 50 eligible old release tags. This initial validation
did not delete VPS resources or restart services.

The operator then approved activation and immediate cleanup. Installed matching
host scripts using the VPS's existing Node binary and verified their hashes
against the checked-in working files. The daily timer is enabled and active;
host cleanup removed the 50 eligible tags and completed with exit status zero.
The updated runner image passed its real isolated VPS smoke before replacement
while GitHub reported it idle. Runner ID 21 remains online with its existing
registration and both outer volumes. Its labeled Docker 29.9.0 daemon and
configured post-job hook passed immediate live CI cleanup. The filesystem now
has **60GB free, 39% used**, compared with 7.9GB free before this rollout. Core
container identities, volume names and the current-release marker are unchanged;
all containers are healthy and public readiness is HTTP 200. A future naturally
completed GitHub job remains the live event check for automatic hook invocation.

An unexpected VPS reboot occurred during CI image export. Services recovered
after boot, and the new image subsequently passed smoke and installation. The
available journals do not establish its cause; no reboot command was issued by
this workflow. See [the reboot incident](../../postmortem/2026-10-10-vps-reboot-during-cleanup-rollout.md).

## In-app update disk-space recovery (2026-10-10)

The first v0.1.34 host update built and smoke-tested its images but failed while
creating an image archive on a full VPS disk. It never entered cutover, so the
app/worker stayed healthy on v0.1.33. Capacity recovery removed the incomplete
archive, unused old build cache and obsolete unreferenced RepoDesk release image
tags while retaining current/recent/requested images and all container references.
The operator's signed-in Retry update action completed a fresh verified attempt,
`065610d4-768a-4f7f-8517-46b7b0a2bf12`, installing release bundle
`1791614204914-36610498`. The reloaded browser shows v0.1.34 and the new member
GitHub View action.
App, worker, PostgreSQL and Codex runner are healthy; public readiness returns
HTTP 200. The updater is active, the backup is mode 600, and 7.9GB remains free.
See [the incident report](../../postmortem/2026-10-10-in-app-update-disk-space.md).

The local correction deploys same-daemon images by recorded immutable IDs,
rejects retagging before writers stop, checks a minimum 1GiB reserve before
checkout/build/cutover, and reports disk-space failures explicitly in the modal.
Manual archive deployments keep checksum/import verification. This correction
requires a future published release; the v0.1.34 recovery uses its original
archive-based updater.

Validation: lint, strict TypeScript, build, **673 deterministic tests**, five
focused update browser scenarios, Docker app build/Node runtime smoke, Compose
configuration and host-script syntax passed. Desktop/mobile error and retry
states were inspected. Tests cover local-image cutover, changed app/task image
IDs, low disk space, duplicate/interrupted jobs and existing backup, migration,
checkpoint and readiness boundaries.

## Member GitHub details behind View (2026-10-10)

The Members & access GitHub column now contains only a View button for every
member. Its shared read-only modal shows the account/profile link, connection or
verification status, sync time and complete saved repository access list. Unlinked
accounts show Not linked; verified accounts with no repositories show an explicit
empty state. Shared repository cards preserve permission labels, wrapping names
and external links. X/Escape closes the dialog and restores focus to View. Opening
it makes no additional GitHub request or write. Add/Edit retains its separate
account selector. Member-load failures now use the shared compact retry toast.

Validation: lint, strict TypeScript, build and all **669 Bun tests** passed against
disposable PostgreSQL. The combined member, repository-card and admin browser run
passed **34 scenarios**; the final member suite passed **13 scenarios**, including
load failure/retry, unlinked/pending accounts, zero/one/five/six repositories, the
complete 60-repository list, permission labels, focus and editing. Desktop/mobile
display and dialog screenshots were inspected in both themes, plus loading,
empty, pending and error states at 1280px and 390px. This replaces the earlier
five-entry member preview. No dependency, migration or deployment was added.

## Shared runtime log pagination (2026-10-10)

Runtime logs now reuse the Runs pagination component below the table, with
previous/next chevrons, a current range/page summary and 12px row/pagination text.
Cursor history supports returning through older pages without changing the API
or inventing a total count. Filters, search and Latest logs reset history;
automatic updates pause on older pages and resume on return to the latest page.
Loading disables both navigation actions, failed pages retain previous-page
recovery, and empty pages keep the pager visible. Log request errors use the shared
retry toast; mobile admin toasts sit below the header to avoid covering pagination.

Deterministic browser coverage includes desktop/mobile cursor navigation,
filter/search resets, loading/error/empty recovery, keyboard pagination, 44px
action targets and paused/resumed polling. No dependency or API change was added.

Validation: `bun run check`, strict TypeScript, production build and all **669
deterministic tests** passed with disposable PostgreSQL. All **50 browser
scenarios** across Logs, Runs, admin and loading/recovery passed with isolated
server/artifact settings after a shared-output run lost a Playwright trace during
cleanup. Populated light/dark and loading/error/empty screenshots were inspected
at 1280px and 390px; error toasts leave the mobile pager accessible. No deployment
was performed.

## Retryable GitHub verification for coding tasks (2026-10-10)

Temporary GitHub permission-sync failures no longer permanently cancel Reviewed
or Direct coding tasks. Unavailable/expired verification blocks new execution,
auth resume, result processing and publication while retaining the task attempt.
Already-running isolated work can finish under its original grant; successful
permission sync resumes progression without repeating start or publication.
Rate limits are distinct from permission denials, respect server cooldowns and
increase sync backoff after repeated failures. Last confirmed permission data
remains comparison-only while unavailable and keeps its original timestamp.

Confirmed permission loss atomically fences pending durable tasks for the actor
and tasks containing that actor's inputs. Stop, membership and configuration
revocation remain effective during recovery. Completed review-state results and
confirmed PRs retain their saved status; follow-ups still reauthorize access.
The panel and Telegram give specific verification/denial guidance. A safe
`github_user_sync_failed` runtime event records the failure category without raw
upstream diagnostics. Old cancelled records are not automatically restarted.
See the [incident evidence](../../postmortem/2026-10-09-github-access-task-cancellation.md)
and [recovery journey](../../examples/github-coding-permission-recovery.md).

Validation: Biome, strict TypeScript, production build, Node runtime contract and
**669 deterministic tests** passed with disposable PostgreSQL and host proxies
disabled. **10 coding-task browser scenarios** passed at 1280px and 390px;
desktop/mobile permission recovery and denial displays were visually inspected.
Tests cover unchanged-attempt recovery, duplicate polls, publication blocking,
undispatched reservation cleanup, rate-limit cooldown/backoff, explicit Stop,
confirmed loss, contributor boundaries and preserved completed PR status.
No dependency or migration was added. No deployment, live model call, GitHub
mutation or Telegram send was performed.

## PR #9 conflict resolution (2026-10-10)

Reconciled PR #9 (`a325040`) with main (`13d7932`), retaining the mobile
navigation sheet and responsive version placement alongside main's compact
notifications and below-list run pagination. Both implementation-history entries
are preserved. Toast layout coverage now checks clearance above the desktop
version footer and below the mobile version header; the UI documentation records
that responsive distinction.

Validation: lint, both strict TypeScript checks, **661 deterministic tests** with
disposable PostgreSQL, production build and Node runtime checks passed through
`bash scripts/verify-skills.sh quality`. All **158 browser tests** passed across
the three `release-N-browser` phases (58/54/46). Two initial browser processes
were terminated before completion; the complete rerun in terminal sessions passed
without skipped tests. Desktop/mobile screenshots were inspected for navigation,
version placement, loading/empty states, toast errors, sign-out pending/error
states and update dialogs. Physical mobile browsers remain unverified. No remote
publication, deployment or `.github/` changes were made.

## Compact shared notifications (2026-10-10)

Shared admin toasts now use a neutral surface, subtle border/shadow and small
colored status icon. Recovery actions show Retry inline beside the message, with
descriptive accessible names; retry and close controls keep 44px touch targets.
Network failures read “Couldn’t connect to RepoDesk.” Long messages wrap on narrow
screens, and notifications leave clearance above the version/update control.
Error persistence, manual dismissal and confirmation auto-dismiss/hover/focus
behavior are retained. Dialog errors remain inside their editors.

Validation: lint, strict TypeScript, production build and **661 deterministic
tests** passed with disposable PostgreSQL. **45 focused browser scenarios** passed
across loading/recovery, Review Bot, provider/configuration editors, site settings,
connected services, session expiry and shared save confirmations. Network-error
coverage includes keyboard retry/dismissal, persistent errors, long messages,
pending retry, recovered saved summaries and retained values after refresh failure
at 1280px, 390px and 320px in both themes. Desktop/mobile screenshots were reviewed.
No dependency or migration was added. No deployment was performed.

## Mobile admin navigation and version placement (2026-10-09)

At widths up to 800px, the admin shell shows a compact persistent header and
opens navigation in a scrollable left-side sheet. It reuses the shared modal's
focus boundary, Escape handling and plain X; backdrop taps, navigation and
workspace selection dismiss it. Desktop keeps its persistent sidebar. Resizing
back to mobile starts with the sheet closed. Workspace permissions, account
controls and update authorization remain enforced by the existing flows.

The mobile admin version and update indicator sit at the header's right edge,
clear of page content. Mobile sign-in/setup use a normal-flow footer; desktop
retains the bottom-right label. Both use the same version and update portal.

Deterministic browser coverage in `sidebar.e2e.ts` exercises 320px, 390px, 800px
and desktop layouts, focus/dismissal, workspace selection, short-screen scrolling,
empty workspaces, restricted navigation and page loading/error states. Account
tests open the mobile sheet before exercising its controls. The sign-out fixture
covers pending dismissal locks, visible failures and retry; error text wraps
below the identity/actions without squeezing the username into a narrow column.
Verification uses
`bash scripts/verify-skills.sh quality` and
all three `bash scripts/verify-skills.sh release-N-browser` phases (`N` = 1, 2, 3);
these prepare dependencies and
disposable PostgreSQL without model or GitHub credentials. Physical mobile
browsers and deployment are outside these local checks.

## GitHub release checks and host updates (2026-10-09)

Signed-in pages check the configured repository's latest stable release and show
an arrow after the version label when a newer numeric version is available.
The shared modal shows formatted changelog/update notes and an operator-only
Update now action. Installation queues an atomic host request after checking
release identity, notes, commit, session/origin/CSRF and updater heartbeat. Durable
reservations and audit fence concurrent/replayed/uncertain requests. Only the
separate host daemon builds images and invokes the backup/migration/readiness
cutover. It checks successful Verify evidence for the pinned commit. The GitHub
deployment workflow is removed; no Actions write credential is required.
Workspace accounts can review notes. See [installation and recovery](updates.md).

2026-10-10: The version update indicator uses a compact 28px circle, 16px arrow
and 5px status dot, with its 44px tap target and keyboard focus retained. Focused
browser coverage checks both themes at desktop and mobile widths, opening notes
from the transparent padding and with the keyboard. Desktop/mobile screenshots
were reviewed in both themes; lint, strict TypeScript, build, 669 deterministic
tests and 13 focused browser scenarios passed.

Direct VPS deployment was verified on 2026-10-09 for `cfffdfc` (v0.1.32) at the
recorded deployment host. App, worker, Codex runner and the host updater are
healthy; public `/readyz` returns ready and `/admin` serves the new version and
indicator mount. The app's UID-1000 process verified queue read/write access,
a fresh updater heartbeat and migration 017. The pre-migration backup is protected
with mode 600. The updater uses a private Node v24.21.0 binary extracted from the
verified app image, preserving the host's existing global runtime configuration.
Installing a subsequent published release through the modal remains a live
staging gate. Deterministic tests and browser fixtures do not perform deployment.

Validation: lint, strict typecheck, production build and **661 deterministic tests**
passed with disposable PostgreSQL and host proxies disabled. **Nine browser
scenarios** passed for updates and session expiry. Desktop/mobile screenshots
were reviewed for version placement, loading, populated/empty notes, pending
locks, request errors and offline guidance. The Docker app image built and passed
its Node runtime smoke; Compose configuration, host-script syntax and the systemd
unit validated. Host tests cover pinned builds, failed verification, interrupted
cutover fencing and a real Node daemon heartbeat without network/Docker work.

## Explicit application test discovery in Verify, 2026-10-09

Quality now runs `bun test ./tests`. Bare `bun test` recursively discovered the
optional Code Truth service tests after its dependency installation was removed
from Verify. In [the first simplified run](https://github.com/stonega/repodesk/actions/runs/37900099896/job/113720384516),
two service test files could not load `tar` and another service test timed out.
The earlier local check retained the service's installed dependencies and missed
this clean-checkout failure. Browser and application container jobs passed in that
run; the final gate correctly rejected the failed quality job.

Validation used an isolated checkout with only the root frozen-lockfile install
and no Code Truth dependencies. The missing-package error was reproduced with a
service test. The scoped CI command then passed all **616 application tests** in
**70 files**, with no service tests discovered. Biome, strict TypeScript, production
build and the Node runtime contract also passed there. Application behavior,
dependencies and test implementations are unchanged.

## Simplified Verify workflow, 2026-10-09

Verify now runs quality/database checks, the complete browser suite in one job,
and application container checks. Code Truth's separate service installation,
typechecking and image smoke, plus the Codex image/lifecycle job, were removed.
The browser matrix was removed; its single job has a 30-minute budget. The existing
required `checks` gate waits for all three remaining verification jobs and rejects
failed, skipped or cancelled results. Release deployment separately retains its
Codex image builds and lifecycle smoke before transfer.

Validation: workflow configuration/dependencies, Biome, strict TypeScript,
production build, all **645 deterministic tests** and all **137 browser tests**
passed locally. The application image built and passed its Node runtime contract,
isolated Compose migration/readiness/setup checks, and backup/restore rehearsal.
No application or test implementation changed.

## Independent model-provider browser fixtures, 2026-10-09

The model-provider browser fixture now marks its disposable deployment claimed
after inserting its administrator. Previously, a fresh CI shard displayed the
first-run Create administrator form while the tests waited for Sign in; a full
local browser run hid this dependency on earlier setup tests. The original
[Browser (3/4) failure](https://github.com/stonega/repodesk/actions/runs/37883870995/job/113669400138)
was reproduced with one test against fresh PostgreSQL. All six affected tests now
pass as a standalone file at 1280px and 390px. Application behavior, dependencies
and deployment configuration are unchanged.

Validation: Biome, strict TypeScript, production build, Node runtime contract,
all **645 deterministic tests** and all **40 tests in browser shard 3/4** passed
against disposable PostgreSQL. No production rollout or live external action
was performed.

## No fixed chat tool-call quota, 2026-10-09

Normal Pi workspace requests no longer stop after eight tool calls. The worker
omits the call-count cap, and the runtime treats an omitted cap as unlimited while
still accounting for calls. Workspace model-turn/spending limits, timeout,
cancellation, permissions and approval pauses remain enforced. Internal
summarization/classification stays tool-free; deliberate internal/evaluation caps
remain available and have a specific Telegram failure message. No workspace
setting, dependency or migration was added.

Regression tests complete twelve reads in one batch and across several model
turns, recover from a failed lookup, and stop on revocation after the ninth read.
The real worker fixture finishes twelve durable tool outcomes in two model turns
and queues one answer; duplicate execution does not replay it. Existing tests
cover cancellation, budgets, model-turn exhaustion, approvals and tool-free passes.

Validation in an isolated checkout of this fix: Biome, strict TypeScript,
production build, Node runtime contract and **628 deterministic tests** passed
against disposable PostgreSQL. The application image built and passed isolated
migration/health/setup smoke; base Compose validation passed. Concurrent GitHub
action changes in the shared checkout were preserved and excluded from this
verification. No production rollout, live model call, GitHub write or Telegram
send was performed.

## Default GitHub tools/skill and approved PR actions, 2026-10-09

Connected workspaces now receive app-owned repository lookup, issue/PR metadata,
issue proposals and merge/close proposals by default, alongside the bundled
[`repodesk-github` skill](../../skills/repodesk-github/SKILL.md). Existing workspaces
need no plugin manifest or skill-catalog migration, and custom skill records remain
intact. Registered tools describe the current build even when retained conversations
contain older replies about missing capabilities. Optional Code Truth and coding
execution retain their own configuration requirements.

PR actions require an active owner/admin or configured coding maintainer, current
write/admin access for linked GitHub accounts, a selected repository and a separate
requester approval for each PR. Telegram previews identify the exact action, PR,
target branch, and merge method/head commit. The worker rereads the PR, rechecks
authority and deployment state, commits a reservation, then attempts one scoped
mutation. Changed/draft/closed PRs fail safely; merges include the reviewed head SHA.
Concurrent workers, duplicate approvals and restarts cannot repeat a reserved write.
Uncertain outcomes require GitHub inspection. Safe tool/result guidance explains
permission updates and PR-state failures without exposing upstream diagnostics.

The App manifest already requested Contents and Pull requests write permissions;
older installations still require GitHub permission-update acceptance. Running app
and worker processes must be updated through the release flow to expose the new
tool. This adds no dependency or database migration. No deployment, live GitHub
write, Telegram send or model call was performed. Native Telegram desktop/mobile
rendering, real installation-grant changes and live PR outcomes remain staging gates.
See [setup and limits](github-app.md#merge-or-close-a-pr-from-telegram) and
[the runnable journey](../../examples/github-pull-request.md).

Validation: `bun run check`, strict typechecking, production build and all **642
deterministic tests** passed against disposable PostgreSQL. The **17 PR-action
checks** cover default-agent tool/skill exposure for existing workspaces, unchanged
custom catalogs, disconnect, exact approval, actor/tenant/privacy boundaries,
permission revocation, changed PRs, scoped token grants, duplicate sends and safe
unknown outcomes. The Node runtime contract passed on the host and in the built
application Docker image, confirming the bundled skill and core tools are packaged.

## Actionable coding checkout failures, 2026-10-09

Coding preparation now distinguishes a missing configured base branch from other
clone failures. The task container records only an allowed failure code; the
supervisor preserves it through restart. Telegram outcomes, requested status and
the saved admin task display name the authorized repository and missing branch,
explain that Codex did not start, and point to Plugins → Codex → Repositories before
a new request. Missing PR branches do not claim that the base branch is absent;
uncertain publication retains its existing reconciliation behavior. Old generic
failures cannot reconstruct discarded Git diagnostics.

Saved task rows use labeled details on mobile so the longer explanation remains
fully readable. Existing task actions and Stop confirmation remain in place.
The UI rules record the user's request for specific failure causes and recovery.
No dependency, database migration or deployment configuration was added.

Validation: Biome, strict TypeScript, build and **625 deterministic tests** passed
against disposable PostgreSQL, plus the Node runtime contract and **8 browser
checks**. Saved failures were visually inspected at 1280px and 390px. Application,
task and supervisor images built; application migration/health/setup smoke, the
full fake-provider Docker lifecycle (including a real local missing-branch clone
and restart), and Docker-overlay Compose validation passed. Tests cover one scoped
failure notice, duplicate polls, unknown/missing markers, tenant isolation, both
Reviewed and Direct workflows, and no implementation/publication after checkout
failure. No live provider call, GitHub write, Telegram send or production rollout
was performed.

## Shared model providers and GitHub App icon, 2026-10-08

Setup now includes Workspace → Model → Telegram → GitHub. Operators save an
OpenAI-compatible provider URL and encrypted key once; saving fetches its model
list. Providers are reused across that operator's workspaces. Bot chat, Codex and
Review Bot save independent model selections from the same catalog. Chat execution
pins the selected provider and workspace model revision; Codex's task-scoped proxy
binds the chosen endpoint/model and keeps provider keys sealed in the supervisor.
Legacy configuration remains readable, and ChatGPT device-code authentication is
still available. Provider discovery does not make a paid inference request.

Provider records use saved summaries and New/Edit dialogs; service editors contain
provider/model selectors. Tests cover ownership, CSRF, encrypted storage, URL/key
binding, failed discovery, stale saves, unavailable models, key rotation, sharing,
independent selections, and task-proxy routing after restart. Workspace deletion
removes its model selection; shared operator provider records remain configuration.
No dependency or database migration was added.

The original GitHub creation flow offered the RepoDesk icon as a 200×200 PNG under
1 MiB and an owner-appropriate App settings link, then waited for an upload
acknowledgement before authorization. That manual icon step was removed on
2026-10-18; see the current entry above.

Validation: Biome, strict TypeScript, production build and all **619** deterministic
tests passed with disposable PostgreSQL. All **41** affected browser scenarios
passed: admin (17), provider/model/icon (6), Codex device (8), and Review Bot (10).
Desktop/mobile saved displays, editors, pending/error states and the icon handoff
were visually inspected. App, job and supervisor images built; full fake-provider
Docker lifecycle, offline OCR preparation and Docker-runner Compose checks passed.
Tests used isolated loopback ports/artifacts and fake provider/GitHub transports.
No live provider inference, GitHub logo upload, account connection or deployment
was performed. Real provider protocol/model compatibility remains pilot acceptance.


## Shared repository card styling, 2026-10-08

Repository summaries now reuse one card component and list styles in Members &
access, Manage GitHub, Codex, Review Bot and Code Truth. Compact and detailed cards
share their surface, border, corners, typography, badges and action layout. Long
names wrap; managed cards give names the full heading width on mobile. External
GitHub links use accessible labels and 44px targets. Existing saved details,
New/Edit dialogs, the five-member-repository preview limit and GitHub's expandable
connection list retain their behavior. The UI rules record this app-wide preference.

Biome, strict TypeScript, production build and **611 deterministic tests** passed
in an isolated checkout containing only these UI changes, against disposable
PostgreSQL. **44 browser checks** passed across repository styling, member previews,
repository search/refresh, Review Bot editing/errors and loading/recovery. New checks
compare card styling across all five views at 1280px and 390px in light and dark
themes, verify long names, saved details, safe links and edit/cancel behavior.
Rendered cards were visually inspected at both widths and in both themes. The
complete working tree also passed **619 deterministic tests** during implementation.
No dependency, migration or deployment was added.

## Compact member repository previews, 2026-10-08

Members & access now shows at most five repository permission entries in each
member's GitHub column. Lists longer than five offer Show all with the total count,
opening the complete saved list in the shared read-only modal. Long names wrap;
the modal scrolls, traps focus, closes with its X or Escape and returns focus to
the triggering button. Opening it performs no additional GitHub request or write.
Member editing and verification-pending account displays retain their existing flows.

Validation: Biome and production build passed; all **619 deterministic tests**
passed against disposable PostgreSQL. All **nine focused member browser checks**
passed, including zero/one/five/six-entry boundaries, a 60-repository list, permission
labels, keyboard behavior, member editing and lookup failure recovery. Preview and
modal rendering, including the final long repository name, were visually inspected
at 1280px and 390px. Full typechecking remains blocked by an unrelated unresolved
`advanced` reference in the concurrently edited `web/model-providers.tsx`. No
dependency, migration or deployment was added.

## Telegram PR controls, 2026-10-08

Reviewed and Direct coding task messages with a confirmed PR now use native
Review/Merge URL buttons. Review opens changed files; Merge opens the PR on GitHub
for its permission checks and confirmation. Outcomes, waiting questions, blockers,
follow-up progress, cancellation receipts and requested status keep the PR actions.
The existing progress message receives the same controls through its durable edit.
Before publication, existing task controls remain applicable. Older Status taps
return current PR actions without granting a review or merge operation in Telegram.

Deterministic tests verify sent and edited button payloads, the waiting-after-PR
case, confirmed publication, follow-up work, old controls and revoked delivery.
Biome, strict TypeScript, build and all **611 deterministic tests** passed against
disposable PostgreSQL.
Live Telegram desktop/mobile rendering remains unverified; no deployment or live
Telegram/GitHub action is part of this change.

## Open Code Review primary framework, 2026-10-08

Review Bot now uses Open Code Review (OCR) delegation as its primary review
framework. The task image pins the official CLI at 1.12.12. Credential-free setup
prepares a commit-pinned file/rule plan, validates JSON compatibility and complete
rule coverage, and stops on preparation failures before model execution. Codex
performs read-only analysis using its existing workspace credentials. Review
instructions require file coverage and explicit exclusion/skipping reasons; that
reported inspection coverage remains model-generated. Answers and authorized fixes
retain their existing workflow. No migration or new model account is required.

Biome, strict TypeScript, build and all **592 deterministic tests** passed against
disposable PostgreSQL. App/job Docker images built, migrations/API health and base
plus Docker-runner Compose validation passed. The pinned OCR CLI's real offline
preparation passed inside the job image, including exact refs, grouped rules,
exclusions and failure behavior. The repeatable
[smoke script](../../scripts/open-code-review-smoke.ts) uses disposable Docker volumes
and no model/GitHub credentials. Rebuild existing task images to use this integration.
Live semantic review quality and intended-host Codex sandbox compatibility remain
release gates. See [setup and boundaries](review-bot.md).

## Overview coding-task count, 2026-10-08

The Overview Coding Tasks card now includes both Reviewed tasks in workspace
state and Direct tasks in the workspace-scoped task table, using the same list
query as the Codex page. Waiting, completed and cancelled tasks count once,
independently of their execution attempts. The card opens the Codex task list
instead of the Plugins catalog. Existing count visibility and tenant permissions
remain in effect.

Regression coverage checks empty, Reviewed-only, Direct-only and mixed counts,
other-workspace isolation and workspace-administrator access. Browser checks use
the real local API with deterministic database fixtures at 1280px and 390px,
verify the count and destination rows, and cover the existing pending, failed-load,
retry and saved-value refresh states.

Validation: Biome, TypeScript and build passed; all 586 Bun tests passed against
disposable PostgreSQL, and all seven focused browser checks passed. Rendered
Overview counts and the matching Codex list were inspected on desktop and mobile.

## GitHub App onboarding defaults, 2026-10-08

New GitHub App registrations now suggest `repodesk` in setup, the creation dialog
and API requests that omit a name. Their manifests preselect `pull_request`,
`issue_comment` and `pull_request_review_comment`; public HTTPS domains enable the
operator-specific webhook automatically, including a configured admin site domain.
Local, IP-address and non-HTTPS origins retain an inactive placeholder with the
subscriptions selected. GitHub's generated secret is required at conversion and
stored encrypted for Review Bot's existing operator-scoped fallback after restart.
Existing App records and explicit secret replacements remain supported. Review Bot
repository policies and verified member requirements remain unchanged.

Biome, strict TypeScript, build and **584 deterministic tests** passed with disposable
PostgreSQL and loopback proxy bypass. Added coverage checks name defaults, public
and local origins, custom domains, encrypted secret retention, signed webhook intake,
invalid conversions and operator isolation. All **17 admin browser scenarios**
passed, including setup name submission, failed-registration recovery and the
creation dialog's default name and posted manifest. Desktop/mobile creation and
saved App summaries were visually inspected. No dependency, migration, live
GitHub/Telegram call, production configuration change or deployment was added.

## Codex follow-up intent routing, 2026-10-08

Ordinary messages in a private or linked-group Topic now enter Pi even when a
Codex task is working, waiting or ready for review. Pi chooses between answering
with permitted read tools, continuing clear changes to the matching task/PR, and
starting a separate coding goal. PR reviews and explanations no longer resume
Codex automatically. Metadata alone is not presented as a code review.

Direct ingress remains for explicit task controls, replies to the confirmed notice
for the current Codex question, and edits/duplicates of accepted task inputs.
Unanchored answers receive Pi intent handling. Explicit Pi continuations record
their task handoff so native Stop and completion notices follow the correct task.
Actor, workspace, bot, chat/Topic, source and repository boundaries remain checked.

Biome, strict TypeScript, production build and the full deterministic suite passed
with disposable PostgreSQL and loopback proxy bypass. Coverage includes private
and group Topics, ordinary/old-result replies, duplicate events, question/media
answers, task-input edits, original-wording continuation on the same PR, multiple
tasks and cancellation. These checks establish routing and authorization, not live
model intent accuracy. No dependency, migration, deployment or live external call
was added. See [routing contract](../design/codex-collaboration.md#task-lifecycle-and-conversation)
and [staging journey](../../examples/telegram-feedback.md).

## Codex PR readiness, 2026-10-08

Successful Reviewed and Direct coding publications now create PRs ready for review.
Verified same-PR follow-ups mark existing drafts ready before confirming success.
Readiness checks bind the PR to the configured repository, branch, base and verified
commit. Lost acknowledgements are not replayed; read-only recovery requires an open,
non-draft PR at that commit. Review Bot fixes retain their existing draft policy.
Settings, approval previews, task status, Telegram notices and current guides use
the updated publication contract.

Biome, strict TypeScript, build, **577 deterministic tests** with disposable PostgreSQL,
all **17 admin browser scenarios**, Docker job/supervisor builds, full fake-provider
Docker lifecycle smoke and Compose validation passed. Mobile settings were visually
checked. Localhost was excluded from the host proxy for local service tests. No live
GitHub, Telegram or model calls, or deployment, were performed.

## Review Bot, 2026-10-07

[Review Bot](review-bot.md) is implemented locally: selected-repository automatic
PR reviews, verified GitHub mentions, read-only answers, checked same-PR fixes,
immediate status, cancellation, question continuation and durable reconciliation.
Webhook secrets/receipts use migration `016_review_bot.sql`; task configuration and
records remain tenant-scoped. Repeated events, source/permission changes, stale
heads, branch rewinds and uncertain outcomes are covered deterministically.

Biome, strict TypeScript, build, **569 deterministic tests** with disposable
PostgreSQL and **97 browser scenarios** passed. App/job Docker builds, migration,
API health, fake-Git PR preparation, Node 24 Pi contract and Compose validation passed.
No live GitHub, Telegram or model call was part of these checks. The development
host's Codex command-sandbox probe failed at bubblewrap namespace/devpts setup;
live review acceptance requires a compatible runner. See the linked setup and
[acceptance journeys](../../examples/review-bot.md).

This dated log records local implementation and verification, including the P0
bot/admin/worker foundation and bounded GitHub paths. Some changes were deployed to
a local Podman stack, but the [primary GitHub journey](../design/github-workflows.md)
has not been validated end to end with live GitHub, model and Telegram operations or
accepted by a pilot team. Each entry states its own test scope and remaining gates.

## Implemented

### Parallel Codex task execution (2026-10-07)

Replaced the single global active-task guard with `CODEX_RUNNER_CONCURRENCY`
(default four, range 1–32), wired through Docker and Podman Compose. Capacity is
reserved before container launch, restored from durable records after restart and
shared across repositories/workspaces. Independent API-key tasks run Codex in
parallel; attempts for the same continuous task remain serialized. User-input and
authentication pauses still release capacity, while excess tasks use the existing
queued retry paths.

Tasks sharing one workspace's managed ChatGPT cache serialize implementation,
repair and auth resume to preserve refreshed credentials. Preparation, setup,
checks and publication can overlap; separate workspace caches run independently.
Queued repairs do not consume an attempt before they can launch. See the
[runner guide](codex-runner.md#lifecycle-and-recovery) for configuration and per-task
resource limits.

Validation: Biome, strict TypeScript, build and **517 deterministic tests across
62 files** passed with disposable PostgreSQL. Six added runner tests cover capacity,
duplicate starts, restart/cancellation, task and tenant isolation, credential-stream
ordering, auth resume and repair scheduling. App, task and supervisor Docker images
built; host/container Node runtime contracts and all three Compose configurations
passed. Docker and rootless Podman smoke verified two simultaneous implementation
containers, capacity rejection and supervisor restart, plus the existing task/auth/
publication lifecycle. External services were fake; no live account, model call,
GitHub write, Telegram send or deployment was performed. No dependency or migration
was added.

### Repository reports, conversation skill drafts and work handoffs (2026-10-07)

Implemented the [accepted R01–R03 plan](team-workflows-plan.md). GitHub reads use
repository-scoped Issues/Pull requests read tokens, bounded pages, canonical links,
retrieval times and merge-time windows. Repository schedules pin source IDs and
connection revision; private group reports require admin audience approval.
Previous complete local calendar days include 23/25-hour DST transitions.
Access changes block reads and queued delivery, including indirect evidence from
older assistant reports.

An owned successful assistant run can produce a sanitized skill proposal. Requester
approval creates a disabled admin-visible draft; existing admin publish/enable
controls make it reusable. Unpublished drafts depend on retained sources; published
procedures have an independent approved-instruction lifecycle. Handoffs batch-read
durable task inputs/context, preserve questions/checkpoints/verification uncertainty,
and include permitted discussion notes. Personal and group/topic boundaries remain
distinct. Added tool context is covered by a compaction regression fix and test.

Validation: Biome, strict TypeScript, build and **502 deterministic tests across 61
files** passed with disposable PostgreSQL. **19 browser scenarios** passed, including
two new desktop/mobile feature checks with visual inspection. The built host Node
runtime contract passed. Added 30 unit/integration tests and two browser scenarios;
these features add no dependency or SQL migration. The final pass includes concurrent
membership/GitHub account edits without reverting them. External services were fake; no deployment,
account connection, live Telegram send, model call or GitHub write was performed.
Live report usefulness, teammate reuse and handoff quality remain pilot checks in
[the runnable examples](../../examples/team-workflows.md).

### Telegram progress and cancellation feedback (2026-10-06)

Implemented the [friend beta feedback plan](telegram-feedback-plan.md). Telegram
uses readable task stages and actionable failures, with durable phase notices,
coalescing and suppression of obsolete progress. Status/cancellation target replies
or the current conversation, with authenticated selection for multiple tasks.
Queued selectors and actions recheck current permissions. Cancellation separates
stopping from confirmed termination; missing runner records and publication in
flight retain uncertainty. Native Stop and original-request cancellation reach a
linked coding task under existing permissions. Pi handoff responses and previews
cannot claim queued coding work is complete. Ordinary cancellation deliveries are
included in scoped admin run details. The Codex panel uses the same readable stages.

The 2026-10-07 follow-up adds inline Status/Cancel controls to coding notices and
long private queue notices, removing repeated command reminders. Longer stages
use short, natural follow-ups. Button taps bind to confirmed sent messages and
recheck current task permissions; acknowledgements clear the native spinner
silently. Local button delivery, routing, isolation, revocation and replay tests
passed as part of the **526-test** suite, alongside Biome, typecheck and build.
New button behavior still needs live Telegram acceptance.

The later 2026-10-07 correction makes routine progress edit the original task
message, including delayed and repeated repair stages. Necessary questions,
actionable blockers, requested receipts/status and final outcomes remain new
replies. Waiting/terminal states close the existing progress message. Durable edits
retain scope and bot checks, serialize, and retry known-message edits safely;
confirmed deleted messages can be replaced once. Unknown original sends are not
replayed. Verification guidance requires complete bounded commands or a repository
script and explains how to report an irreparable frozen-plan blocker. See the
[incident diagnosis](../../postmortem/2026-10-07-progress-flood-and-invalid-verification.md).
This correction is local; the diagnosed live task still has its old frozen plan.

Validation: Biome, strict TypeScript, build and **451 deterministic tests** passed
with disposable PostgreSQL; **25 affected browser scenarios** passed with desktop
and mobile inspection. Application/supervisor/job images built, Node runtime
contract and Compose validation passed, and deterministic container smoke covered
the runner lifecycle with fake external services. Fresh migration/API/worker smoke
passed. No new dependency or migration was added. Live Telegram/model/GitHub beta
acceptance and deployment remain separate steps; see the
[manual acceptance procedure](../../examples/telegram-feedback.md).

### Automatic Codex environment preparation and checks (2026-10-05)

Removed setup/check command configuration from both repository forms and the
execution contract. Codex prepares the environment and selects a bounded
verification plan from repository instructions. The runner captures the plan,
replays it without model/GitHub credentials and checks patch integrity. Repairs
retain the original commands; missing plans and failed checks block publication.
Migration 013 removes stored overrides and invalidates affected old grants.
Older client command fields are discarded rather than becoming hidden overrides.

Local validation before publication: Biome, TypeScript, build, 354 Bun tests,
23 browser tests, pinned CLI protocol, image builds, Node runtime contract,
Compose and real Podman smoke with fake external services passed. Live model
selection quality and the Telegram/GitHub pilot remain separate release gates.
The user requested proceeding to release without additional verification.

### Continuous Codex collaboration (2026-10-05)

Implemented the [accepted plan](codex-collaboration-plan.md) locally. Pi relays
original source messages; Codex interprets intent, makes technical decisions,
asks product questions, implements and repairs failed checks. Repository direct
policy is opt-in; existing settings retain reviewed approvals. The application
persists tenant-scoped inputs, grants, fenced attempts and delivery events, checks
authority again before execution/publication, and enforces cumulative budgets.
Telegram replies and Topic follow-ups continue one task and PR. Waiting releases
the runner; restarts reconstruct retained context. Ambiguous publication outcomes
are reconciled without replaying writes, and expired/deleted sources trigger
private-state erasure.

Validation: Biome, TypeScript, Bun build and **351 Bun tests** passed with disposable
PostgreSQL. All 19 browser tests passed, including reviewed defaults, direct
policy persistence and desktop/mobile layout. The pinned Codex 0.155.1 protocol passed
on the host and in the isolated job image with a local fake Responses provider.
Application, supervisor and job images built; the isolated Node runtime contract
and Compose configuration passed. Real rootless Podman smoke with fake external
services covered provider/device credentials, questions, checkpoint reconstruction,
bounded repair/exhaustion, fresh and same-PR publication, remote-head fencing,
cancellation and erasure. No live model call, Telegram message, GitHub write or
deployment was performed. The live pilot and semantic intent evaluation remain
release gates; see the plan for their acceptance journey.

### Release-driven VPS deployment (2026-10-05)

Added a stable GitHub Release workflow that reuses CI verification, builds the
release event's immutable commit and transfers its image over verified SSH.
The host script locks deployment, checks runtime secret access, stops writers,
validates a protected pre-migration backup, runs migrations and verifies both
container health and application readiness before recording success. Failed
cutovers stop writers and require deliberate schema-aware recovery.

Validation: Biome, TypeScript, Bun build and runtime contract passed; all **317
Bun tests** passed against disposable PostgreSQL, including seven deployment
tests. Actionlint, Bash syntax and Compose validation passed. The application
Docker image built and passed its isolated Node runtime contract. Disposable
Docker stacks passed a fresh install and an upgrade to a distinct image ID;
both app/worker changed images, database test data persisted, backups validated
and host `/readyz` returned HTTP 200. Temporary containers and volumes were
removed. No live VPS deployment, account connection, webhook registration or
message sending was performed. See [VPS setup](vps-deployment.md) for required
host provisioning and GitHub secrets.

### Local Codex runner reconciliation (2026-09-29)

The live Podman supervisor was healthy with no active coding containers. Two
earlier implementation jobs had failed and their work volumes remained within
the configured 24-hour retention period. The supervisor now removes a stale
credential-free export container before retrying a patch export, so an
interrupted read-only export can recover after a restart. Periodic timeout
reconciliation now records `coding_task_timeout` for the task status. The
running supervisor image was not replaced during this check.

Validation: Biome, TypeScript, Bun build, the 10 runner unit tests, coding
integration tests, Compose configuration and a real Podman smoke with fake Codex
and local Git passed. The full Bun suite reached 301 of 302 passes with a
reproducible timeout in the unrelated native Telegram Stop test; the coding
integration suite passed. The smoke resources were cleaned up.

### Codex local-only execution (2026-09-29)

Removed the GitHub Actions coding dispatcher, repository workflow template and
backend selector. New approvals run only through the local Podman supervisor.
Operators set local check commands for each coding repository; old Actions
configuration cannot authorize new tasks. Historical Actions tasks and links stay
visible, but the worker does not dispatch, poll or cancel them. Queued and
issue-created tasks are cancelled locally; tasks that may have started remotely
become unknown and require inspection in GitHub.

Validation: Biome, TypeScript, Bun build, all 301 Bun tests against disposable
PostgreSQL, Compose configuration, isolated app image build and Node runtime
contract passed. The coding panel browser flow passed in the full browser run.
That run stopped at a separate run-summary UI assertion after 15 passes; two
later tests did not run. No app service was redeployed or live coding task started.

### Overview run and workflow visibility (2026-09-28)

Overview count cards now open their corresponding member, assistant-run,
scheduled-workflow and Codex-task views. Counts match the records in those views.
Initially, unlinked deployment administrators could inspect only read-only run and
workflow metadata. As of 2026-10-06, the workspace deployment administrator and
eligible workspace owners/admins can read every retained run's request, result,
transcript and delivery text, including other users' private runs. Deployment
administrators need no linked Telegram identity for this view. Access remains
workspace-scoped; Telegram execution and mutation checks remain in effect.
Workflow content keeps its existing identity restrictions. The Codex task table
also shows a recorded thread ID when available.

Validation for the 2026-10-06 run-message change: Biome, TypeScript and build
passed; all 385 Bun tests passed against disposable PostgreSQL. The setup and
run-message browser checks passed for linked and unlinked administrators, with
mobile dialog inspection. Permission tests cover tenant boundaries, ordinary
members, revoked workspace admins and unchanged private-run cancellation checks.

Validation: Biome, TypeScript and build passed; all 301 Bun tests passed against
disposable PostgreSQL, and all 17 browser tests passed with fake external services.
The live Clawearn task check failures are documented in
[the incident record](../../postmortem/2026-09-28-clawearn-coding-checks.md).
Future failed local Codex tasks now retain their thread ID and a safe failure
stage when the job supplies one; the panel renders the stage in plain language.
The local Podman app, worker and Codex supervisor were rebuilt and restarted with
the verified images. The job image was prebuilt for future tasks. The protected,
verified pre-cutover archive is
`backups/repodesk-pre-overview-20260928T104445Z.dump`; prior images remain tagged
`rollback-pre-overview-20260928`. Compose validation, the isolated Node runtime
contract, app health and asset smoke, and real Podman success/failure smoke passed.
All three services became healthy, `/readyz` returned `ready`, and Telegram polling
reconnected. No live Telegram message or new paid Codex task was sent for this
release check. Historical failed tasks remain failed with their original generic
error code.

### Setup flow and panel model settings (2026-09-27)

The authenticated wizard now follows Workspace → Telegram → GitHub App → Enter
panel. It reuses guided App registration and repository connection, returning
GitHub callbacks to the wizard when started there. GitHub access can be finished
later from Plugins. Model credentials and explicit bot activation moved to the
operator's Model settings page; entering the panel leaves the bot inactive.

Validation: Biome, TypeScript and build passed; 296 Bun tests passed with an
isolated PostgreSQL test database, and all 16 browser tests passed. Browser tests
used fake Telegram, GitHub and model transports. This change was not deployed or
tested against live providers.

### Group names and local deployment (2026-09-21)

Group access cards show the Telegram group title above its numeric ID, with an ID
fallback for unknown titles. Linking and incoming group updates persist titles;
Recheck bot visibility also fetches the current title for existing bindings.
Inaccessible groups retain their last known title.

Validation: 236 deterministic tests with PostgreSQL, 16 browser checks, Biome,
TypeScript and build passed. Deployed app and worker to local Podman using
`localhost/deepx-agent:group-names-20260921` (`c8ef95b29cd6`), also tagged `local`.
Compose validation, migrations, isolated Node runtime and HTTP smoke checks passed.
Both live containers passed health checks; `/healthz` and `/readyz` returned 200,
Telegram polling connected, and the served admin bundle includes the new card UI.
PostgreSQL and Code Truth containers were preserved. Database backup:
`backups/deepx-before-group-names-20260921.dump` (archive verified). Rollback image:
`localhost/deepx-agent:before-group-names-20260921`.

### Core implementation

- Opt-in local Telegram long polling with durable per-bot offsets, single-receiver
  advisory locking, rate-limit backoff, cancellation and shared ingress/owner validation.
  Setup and readiness checks distinguish polling from the default webhook transport.

- Pi 0.85.1 with configurable OpenAI-compatible endpoints, custom model IDs and thinking levels, bounded sequential tools,
  fake-stream tests, cancellation, durable checkpoints and safe transcript recovery.
- PostgreSQL versioned migrations, tenant row locks, inbox deduplication, transactional
  outbox/pg-boss enqueue, fenced run leases and recovery after worker loss.
- One-use deployment claim, scrypt passwords, revocable sessions, CSRF/origin checks,
  encrypted write-only settings, resumable setup and verified Telegram identity links.
- Telegram webhook validation, command/reply routing, group-admin verification, explicit
  active membership policy, consented received-message collection and scoped sources.
- Manual requests/recaps, source-ID validation, usage reservations, cancellation,
  versioned instruction/workflow/skill snapshots and separate delivery outcomes.
- Canonically hashed approvals, daily/weekly recurrence with DST policy, unique
  occurrences under transaction locks, missed-run notices and workflow lifecycle controls.
- Approved corrections, personal/workspace/workflow instructions, forget/edit, skills
  catalog/import/drafts/settings/publication/enablement/rollback and deterministic tests.
- React Router admin screens for setup, settings, access, members, chats, workflows,
  skills, instructions, runs, usage, audit, privacy and operator controls.
- Retention/deletion tombstones, unknown-charge/delivery reconciliation, health/heartbeat,
  CI, pinned base images, local Docker checks and backup/restore automation.

## Validation evidence

- **48 Bun tests**: 26 local/unit tests plus 22 tests against real PostgreSQL 17.
- **3 Chromium browser tests**: first-claim/resume, write-only credentials, concurrent
  save conflict, skill publish/test/enable, workflow pause/audit, sign-in and mobile layout.
- TypeScript strict checking, Biome and production frontend/backend build.
- Docker Compose migration/API/worker/PostgreSQL health; `/readyz` and admin deep links.
- Container restart preserved a claimed deployment/workspace; a custom-format backup
  restored successfully into a disposable database with three migrations and the fixture.
- Pi contract in the built Node **v24.21.0** image: actual fake-provider tool flow,
  event ordering, bounded turns, cancellation and restored tool-result continuation.

The PostgreSQL tests found and fixed a canonicalization defect: JSONB's key ordering
must not change approval hashes. They also cover claim/approval/dispatch races,
rollback, independent connections, stale settings, revoked sessions, source isolation,
charge reservation races, duplicate workers, rate handling, unknown sends, deletion,
version pins and awaiting-approval worker release.

Run the exact commands in [setup](setup.md). Tests need no real Telegram/model secrets.
Browser artifacts are generated into ignored `test-results/`; they are not release assets.

## Deliberate implementation choices

The pilot uses typed workspace JSONB aggregates and short `SELECT FOR UPDATE`
transactions instead of a separate SQL table for every nested domain record. Relational
constraints cover global identity/binding/inbox/outbox uniqueness. See [architecture](../design/architecture.md)
for limits and the path to normalize high-volume records before scaling.

Skill/workflow editing uses labeled form controls validated by shared server schemas.
Skill testing is a deterministic policy/prompt preview. Live model-quality testing is
an explicit, separately capped operator evaluation; it has not been performed.
Optional Telegram web login remains deferred; verified Telegram linking plus local
account sessions is the implemented authentication path. Group migration suspends and
requires relinking rather than automatically authorizing a new chat.

### Readable admin interfaces (2026-09-21)

The remaining JSON displays and editors have been removed from setup, access
previews, approvals, workflows, skills, instructions, run details/recovery and
operator tools. Structured results use labeled details and lists; operator audit
and workspace status use tables. Explicit form controls retain hidden concurrency
versions and bound IDs, mask passwords, and preserve failed drafts. Approvals
refresh automatically after proposal creation. Copyable commands and Markdown
remain literal content; API serialization is unchanged.

Validation: lint, TypeScript, build, all 217 deterministic tests with PostgreSQL,
and all 14 browser tests passed. Browser checks include skill publication, workflow
payloads and version conflicts, modal locking, automatic proposal refresh,
cross-page JSON removal, and desktop/mobile layouts.

Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:readable-ui-20260921` (`99cb37e7d5df`). The built image passed
the isolated Node runtime contract and HTTP/UI smoke checks against disposable
PostgreSQL. Compose validation and migrations passed; both deployed containers
passed health checks, `/healthz` and `/readyz` returned 200, and the worker reported
`telegram_polling_connected`. Existing PostgreSQL and Code Truth containers were
preserved. The verified database backup is
`backups/deepx-before-readable-ui-20260921-160639.dump`; the previous image remains
tagged `localhost/deepx-agent:before-readable-ui-20260921` for rollback.

### Borderless icon buttons (2026-09-21)

All admin icon buttons are borderless, including destructive, sidebar and modal
actions. Hover backgrounds, keyboard focus outlines, 44px targets and disabled/busy
states remain. Lint, TypeScript, build, 217 deterministic tests and 14 browser tests
passed; browser style checks also verified normal, destructive, sidebar, disabled,
busy and hover states plus keyboard focus.

Deployed image `localhost/deepx-agent:borderless-icons-20260921` (`b1c0fbfc56d5`)
to the local Podman app and worker. Compose validation, isolated runtime contract
and HTTP smoke checks passed. Both containers are healthy, `/readyz` returned 200,
Telegram polling connected, and the live stylesheet contains the borderless rule.
No database schema changes were needed; PostgreSQL and Code Truth were preserved.
Verified backup: `backups/deepx-before-borderless-icons-20260921-164108.dump`.
Rollback image: `localhost/deepx-agent:before-borderless-icons-20260921`.

### Modal action layout (2026-09-21)

All create/edit dialogs now place Cancel immediately after their primary action
using the shared `ModalActions` row.
Nested dialogs retain independent cancellation, focus return and pending-save
locks. Lint, TypeScript, build, 217 deterministic tests and 14 browser tests passed;
desktop/mobile dialog screenshots were inspected. Deployed with the refresh
loading update below.

### Refresh loading feedback (2026-09-21)

Refresh controls now track data loading through completion or failure instead of
only the click callback. Operations waits for both health and setup requests;
session refresh also shows the shared rotating icon. Busy controls prevent repeat
clicks and respect reduced-motion preferences. Lint, TypeScript, build, all 217
deterministic tests and 15 browser tests passed, including delayed success/error
responses, actual rotation, reduced motion and combined refreshes.

Both updates were deployed to the local Podman app and worker on 2026-09-21 with
image `localhost/deepx-agent:modal-refresh-20260921` (`77333bd2bae8`). Compose
validation, the isolated runtime contract and HTTP/UI smoke checks passed. Both
containers passed health checks; `/healthz`, `/readyz` and updated UI assets returned
200, and the worker reported `telegram_polling_connected`. No schema changes were
needed; PostgreSQL and Code Truth were preserved. Verified database backup:
`backups/deepx-before-modal-refresh-20260921-165545.dump`. Rollback image:
`localhost/deepx-agent:before-modal-refresh-20260921`.

### Workspace settings heading (2026-09-21)

Workspace settings now places refresh at the top right and displays its saved
version as a badge after the page title. The former bottom version text and reload
control have been removed. Desktop/mobile screenshots were inspected; lint,
TypeScript, build, 217 deterministic tests and 15 browser tests passed, including
the badge updating after save. The refresh test now waits for sign-in completion
before navigation.

Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:settings-heading-20260921` (`e770fad107b0`). Compose validation,
the isolated runtime contract and HTTP/UI smoke checks passed. Both containers
passed health checks; `/healthz`, `/readyz` and updated UI assets returned 200,
and Telegram polling connected. No schema changes were needed; PostgreSQL and
Code Truth were preserved. Verified backup:
`backups/deepx-before-settings-heading-20260921-171210.dump`. Rollback image:
`localhost/deepx-agent:before-settings-heading-20260921`.

### Unified members and access (2026-09-21)

The sidebar now has one **Members & access** entry. Its searchable, paginated table
shows Telegram names/usernames and numeric IDs, role, membership and effective
access. Access requests share this page. As of 2026-10-07, all active members have
bot access; the whitelist, access mode and policy preview/apply controls and APIs
are removed. Old access-policy browser URLs redirect while preserving workspace
query parameters; search/pagination also retain those parameters. The member API
provides a membership revision for concurrent edits.

Profiles are optional fields in workspace JSON: trusted Telegram sender updates
refresh them, and approved requests populate them. Older approved requests provide
a read-time fallback until a fresh profile arrives. Removing a Telegram username
clears the displayed value, and changing roles preserves the profile. Authorization
continues to use numeric IDs; profiles never enroll users or change permissions.
No extra Telegram calls, dependency additions or schema migration are required.

Validation: lint, TypeScript, build, 235 deterministic tests and 16 browser tests
passed. Checks include duplicate events, tenant isolation, anonymous senders,
profile removal/fallback, member edits, mode changes, revocation, last-admin
protection and the legacy URL redirect. Desktop/mobile screenshots were inspected.
Deployed to the local Podman app and worker on 2026-09-21 with image
`localhost/deepx-agent:members-access-20260921` (`5a9d0fc514dd`). Compose validation,
the isolated runtime contract and HTTP/UI smoke checks passed. Both containers
passed health checks; `/healthz`, `/readyz`, the members page and updated UI assets
returned 200, and the worker reported `telegram_polling_connected`. PostgreSQL and
Code Truth were preserved. Verified database backup:
`backups/deepx-before-members-access-20260921-173543.dump`. Rollback image:
`localhost/deepx-agent:before-members-access-20260921`.

## External release gates still required

Supply a dedicated staging bot/group, model account and spend cap, HTTPS host/domain,
protected secret/backup storage, retention agreement and support owner. Perform the
credentialed evaluation and complete the [staging demonstration](release-runbook.md).
The initial model is provisional until that evaluation passes. No claims about live
recap quality, real webhook delivery or pilot readiness follow from fake-provider tests.

## Model settings verification (2026-09-19)

Deterministic tests cover a local streaming Chat Completions server receiving the
custom endpoint, bearer key, model ID and all seven thinking choices. PostgreSQL
coverage verifies operator-only writes, version conflicts, encrypted/redacted keys,
retaining a key, requiring a new key when changing endpoints, and worker settings.
Browser coverage saves and reloads the custom model, URL and thinking selection.
Live provider capability/price validation remains pending.

## LLM extensions / plugins

Implemented: explicit Pi 0.85.1 extension-file loading for granted workspaces,
registered tools and the documented headless hooks, per-run factory state, limits,
configuration pinning and durable tool outcomes. Deterministic tests exercise loading
unchanged Pi files, vetoes, unsupported features, grants, revocation, collisions and
unknown outcomes. See [the compatibility contract](../design/llm-extensions.md).
Executable code is operator-reviewed and runs in-process. The Plugins panel manages
installed-file registrations, versions, tool/workspace grants and enable/disable/remove
actions. Settings, revisions and audits persist in PostgreSQL; workers recheck changes
between execution steps. Sandboxing, arbitrary external writes and web package/code
installation remain outside this implementation.

On 2026-09-29 the Plugins landing page was reorganized into compact Installed
and Markets cards. Code Truth, Codex and file plugin controls now open on
dedicated detail routes. Markets shows three dated picks from Pi's package
catalog with upstream links; packages are not installed from the panel and
compatibility is not asserted. Browser tests cover the catalog, detail
navigation, registration, revision conflicts and workspace isolation.

Verification on 2026-09-20: lint, typecheck and build passed; 90 deterministic tests
passed with isolated PostgreSQL and `NO_PROXY=localhost,127.0.0.1`. Both Compose
configurations validated. The Docker image passed the Pi extension runtime contract
on Node 24.21.0 with network access disabled, including legacy package aliases,
and returned HTTP 200 from `/healthz` with no configured live services.

Plugin UI verification on 2026-09-20: 96 tests passed against isolated PostgreSQL,
including operator/tenant/CSRF boundaries, stale revisions, preserved file hashes,
worker execution of saved plugins and mid-run revocation. All 5 browser tests passed,
including registration, editing, grants, toggles, removal, persistence, conflict handling
and desktop/mobile layouts. Lint, typecheck, build, both Compose configurations and
the Docker Node 24 extension runtime contract passed. The image serves `/admin/plugins`
and its plugin-management JavaScript bundle successfully without live services.

## Predefined local Code Truth verification (2026-09-20)

Implemented the private local MCP service from the sibling Code Truth core, a named
Pi extension with its companion skill, and the Plugins repository editor. The UI
supports GitHub URLs, network/branch mappings, per-repository workspace grants,
enable/disable, removal, and indexing status with commit provenance.

Verified locally:

- Biome, application and service TypeScript checks, and the application build pass.
- **125 deterministic tests pass**, including the original source-query tests, real
  CodeGraph indexing of a local archive fixture, authenticated HTTP MCP isolation,
  actual Pi factory/tool/schema execution with a fake model, source output, config
  digests, cancellation, operator/CSRF/grant/revision checks and tool collisions.
- **6 browser tests pass**, including repository configuration persistence, branches,
  grants, enable/disable, removal, unavailable/ready status rendering and responsive
  desktop/mobile checks. Ready browser status is a deterministic intercepted fixture;
  real service indexing is checked separately through MCP.
- Both Docker images build. The Code Truth container indexes and queries a local
  fixture through real CodeGraph and MCP with a read-only filesystem and no external
  network. The service entrypoint passes liveness and rejects unauthenticated
  management requests. The Node runtime extension contract also passes.
- Compose configuration validates with both Code Truth and file-extension overrides.

No real repository download, GitHub token, live LLM, Telegram call or production
rollout was used. [Setup](code-truth.md) explains service secrets, supported GitHub
repositories and separate local-index retention/cleanup.

## Independent workspace plugins (2026-09-20)

File plugins and Code Truth configuration now live on each workspace aggregate,
with independent revisions and workspace audit entries. The panel uses the selected
workspace and discards its local drafts when switching. Saving a workspace’s plugin
configuration does not revoke another workspace’s runs, including those owned by
the same operator. Executable plugin management remains operator-only.

Migration `006_workspace_plugins.sql` splits legacy operator registries by existing
grants, preserves pinned hashes and disabled entries, and removes the old deployment
registry. Apply migrations before starting the updated API and worker. The API now
uses `/api/admin/workspaces/:id/plugins` and its Code Truth subroutes.

Verification: Biome, TypeScript and build pass; **128 deterministic tests** pass with
isolated PostgreSQL, including migration, fallback behavior, cross-workspace access,
concurrent revision conflicts and same-owner runtime isolation. **7 browser tests**
pass, including independent plugin versions/repositories, draft reset on workspace
switch, and desktop/mobile layouts. No running application data was migrated.

## Workspace GitHub App connections (2026-09-20)

The Plugins panel now supports GitHub App authorization, installation and repository
selection, connection status, reconnect and workspace-only disconnect. OAuth uses
PKCE, one-use state and session/workspace binding. Temporary user credentials are
encrypted; ongoing Code Truth access uses short-lived, repository-restricted,
Contents-read installation tokens. Connection revisions invalidate pinned runs.
Explicit disconnect prevents legacy deployment-token fallback for that workspace.
See [registration and deployment setup](github-app.md).

Verification: Biome, both TypeScript checks and build pass. **133 deterministic
tests** pass against isolated PostgreSQL, including authorization boundaries,
forged selections, expiry/replay, token redaction, scoped JWT/token requests,
credential rotation and independent snapshot namespaces. **8 browser tests** pass,
including the callback returning to the original workspace, repository selection,
persistence, workspace switching, disconnect and mobile layout. GitHub HTTP calls
in these tests use deterministic fixtures; real App OAuth remains unverified until
the deployment has registered App credentials.

Both images built and passed isolated container smoke tests: Node runtime contracts,
application health/UI, and real CodeGraph indexing plus MCP query. Compose validates
with and without the GitHub App override. The local Podman stack was updated after
a verified database backup; migrations 006 and 007 are applied. App, worker,
PostgreSQL and Code Truth are healthy, and `/readyz` returns 200. Existing private
`devnet-develop` and `testnet-develop` indexes are ready using legacy credentials.
The new Connect button remains disabled until App credentials are configured.

## Guided GitHub App creation (2026-09-20)

The GitHub card now offers App Manifest registration for personal or organization
accounts. It preconfigures read-only source permissions and callbacks, asks the user
to confirm creation on GitHub, and exchanges the returned code server-side. The App
credentials are encrypted in an operator-scoped registry, reusable across that
operator's workspaces without automatically connecting them or granting repositories.
API and worker read saved credentials without restart. Existing environment/file App
configuration remains supported. Migration `008_github_app_registration.sql` adds
this registry and expiring, session-bound registration flows.

Verification: lint, TypeScript and build pass; **139 deterministic tests** and
**9 browser tests** pass, including ownership/CSRF boundaries, cancellation, expiry,
replay, session revocation, invalid conversion responses, concurrent creation,
credential redaction/persistence, worker access and complete create/connect/disconnect
browser flows. GitHub exchanges are fixtures; no real GitHub App was created by tests.
Mobile creation layout was inspected. The container passed the Node runtime contract
and health/UI smoke tests, and both Compose variants validate. The local Podman app
and worker run the tested image with migration 008 applied; health and readiness
return 200 and the served UI bundle includes the creation control.

GitHub Manifest correction (2026-09-20): GitHub rejected the local origin in the
inactive hook URL. The hook now uses a reserved public example URL, remains disabled,
and subscribes to no events; browser callbacks still use the deployment origin.
All 139 tests and 9 browser tests pass with regression assertions, along with lint,
typecheck, build, Compose validation and the container runtime smoke. App/worker were
updated. A real submission through the user's browser now advances past the prior
manifest error to GitHub's Confirm access (sudo authentication) page. Completing that
verification and creating the App remain user steps; no App was created by this check.
See [incident notes](../../postmortem/2026-09-20-github-manifest-localhost.md).

## Model-aware execution budgets (2026-09-20)

Workspace run/month budgets no longer have fixed pilot dollar ceilings. Output and
context limits come from bundled Pi catalog metadata or explicit operator overrides
for custom models. Workspace language and input/output budgets are automatic. Migration 010 removes
retired controls from current settings; historical run snapshots remain intact. Runtime checks happen before each reservation/dispatch,
using conservative UTF-8 byte estimates, and model capacity is pinned on runs.

Deterministic coverage includes custom-model capability requirements, higher output
budgets, oversized tool-context continuation, pre-dispatch rejection, zero-cost
reservations, field-level API validation, authorization and version conflicts. Browser
coverage verifies settings errors, saving above old caps and desktop/mobile layouts.
Provider capability values are not verified with live calls; large Telegram replies
still follow the existing delivery truncation. See [configuration](setup.md#model-capacity-and-workspace-budgets).

## Telegram access requests (2026-09-20)

Implemented unauthorized-user request buttons, scoped request links, deduplicated
pending requests and admin approval/rejection under Members. Approval atomically
creates/reactivates regular membership for the verified Telegram ID and queues
a confirmation with normal delivery authorization checks. Requests use workspace
JSONB; migration `009_access_requests.sql` scopes fixed access-help deliveries.

Deterministic PostgreSQL checks cover duplicate updates/requests, concurrent approvals,
CSRF/admin/tenant boundaries, stale decisions, rejection retry delay, revocation replay,
private/group routing, forged actors, deletion and retention. Telegram calls use test
transports; no live Telegram message or production migration was performed.

Verification: lint, strict typecheck and production build pass; **150 automated tests**
pass with isolated PostgreSQL, and all **11 browser tests** pass. Browser coverage
includes stale-policy recovery, approval/rejection, member-list refresh, persistence
and desktop/mobile layout. Both access-request screenshots were visually inspected.

## Local deployment update (2026-09-20)

Model calls per run accept integers from 1 to 20, default 3. Boundary tests reject
21, zero and fractional values. The current source passed Biome, TypeScript, build,
150 deterministic tests against disposable PostgreSQL, and 11 browser tests. The
Docker-format image passed the Node 24 runtime contract and isolated HTTP/UI smoke
checks. Compose configuration was validated with the existing Code Truth override.

The local app and worker were updated after a protected database backup and migrations;
both containers are healthy, `/healthz` returns `ok`, `/readyz` returns `ready`, and
Telegram polling reconnected. No model request was sent for deployment verification.
Custom model capability values must be configured before new model runs; service
readiness does not validate these provider limits.

## Automatic response settings (2026-09-20)

Reply language, Input byte budget and Output token budget have been removed from
workspace settings and their API output. Older clients' retired fields are discarded
on save. Migration 010 removes existing overrides and advances affected workspace
versions without changing historical run snapshots. No workspace language is injected
into the prompt; the model's response is returned in its chosen language.

Per-call output automatically fits the model's maximum, remaining context capacity
and remaining run/month USD budgets. Atomic reservations still enforce concurrent
budget limits. Tests cover removal, legacy migration/idempotency, preserving model
text, context/budget adaptation, zero-cost calls, and pre-dispatch budget denial.

Local verification: Biome, TypeScript, build, 154 deterministic tests and 11 browser
tests passed. Desktop/mobile settings and the Docker image were inspected. The local
app and worker were redeployed after a protected backup; migration 010 is applied,
no current workspace retains the retired controls, and liveness/readiness are healthy.

## Run deadline diagnosis (2026-09-20)

The executor now distinguishes deadline expiry (`run_timeout`) from cancellation
and worker shutdown (`worker_shutdown`), preserving the first abort source in logs
and run details. `RUN_TIMEOUT_SECONDS` defaults to 300 seconds and accepts 1–1800;
new run queue jobs get an additional 60 seconds for finalization. Migrations update
existing queue defaults. Conversation leases continue to renew while running.
Unknown reservations remain unchanged and terminal runs are not automatically replayed.
Deterministic regression tests cover timeout, shutdown, cancellation, retained
reservations, duplicate jobs, queue expiration and configuration validation.

## Paginated usage table deployment (2026-09-20)

Usage & budget now renders accounting attempts in a paginated table with status,
reserved/actual USD, model/run ID, dates, record counts and mobile table scrolling.
Local verification passed Biome, TypeScript, build, 159 deterministic tests and all
12 browser tests, including pagination, empty/error states, refresh and mobile layout.

The Podman Docker-format image `localhost/deepx-agent:usage-table-20260920`
(`b15143713176`) passed the isolated Node runtime contract and HTTP/UI smoke checks.
Compose configuration validated; a protected database backup was verified and the
migration command completed before app/worker replacement. Both containers, PostgreSQL
and Code Truth are healthy; liveness/readiness return 200, polling reconnected and
the served bundle includes the usage table. The previous image is retained as
`localhost/deepx-agent:before-usage-table-20260920` for rollback.

## Telegram GitHub issue submission (2026-09-20)

Implemented a built-in `propose_github_issue` tool for workspaces with a connected
GitHub installation. It shows the complete repository/title/body in Telegram and
requires the requesting actor's explicit approval before the application worker
creates an issue and returns its link. Repository selection, connection revision,
actor access, cancellation, expiry and pause controls are rechecked before sending.
Durable reservations prevent concurrent workers or restarts from replaying a POST;
ambiguous outcomes require checking GitHub before requesting another draft.

Guided App creation now requests Issues write permission. Existing Apps/installations
must approve that permission update on GitHub. Code Truth tokens remain Contents-read;
issue tokens are limited to Issues-write on the single approved repository. There is
no panel issue form and no new dependency or database migration.

Verification: Biome, TypeScript and build pass; **173 deterministic tests** pass with
isolated PostgreSQL and **12 browser tests** pass. New tests cover the real Pi factory,
complete approval previews, tenant/actor/repository boundaries, concurrent workers,
revocation during token minting, permission/error outcomes, ambiguous recovery and
workspace deletion. GitHub and Telegram calls use fixtures. No live issue was created,
no App permission was changed, and this change has not been deployed.

## Rich replies and native Stop (2026-09-20)

Implemented Bot API **10.3** rich model replies in private chats, groups and schedules,
with native headings, lists/tasks, quotes, code, dividers, compact aligned tables and
safe inline formatting. Private interactive replies stream with native Stop enabled;
partial drafts are not automatically saved. Previews are throttled, source-checked,
fenced and exclude thinking/tool arguments. A persisted bot/chat/topic/draft/fence
binding routes Stop independently of workspace selection, through authenticated,
deduplicated ingress. The run guard aborts generation, blocks pending publication and
keeps unknown provider reservations. Confirmed rich-send rejection falls back to text;
ambiguous sends are never blindly replayed.

No new dependency or SQL migration is required. Existing webhook subscriptions must
be explicitly re-registered to include the Stop update; polling subscribes after
worker restart. See [manual staging example](../../examples/telegram-streaming.md).

Verification: Biome, TypeScript, production build and the full deterministic suite
pass against disposable PostgreSQL. Coverage includes native block rendering,
preview timing/retries, duplicate/stale/cross-tenant Stop events, revoked access,
fencing, paused execution, provider cancellation/accounting, pending final delivery,
authenticated webhook handling and polling subscriptions. Telegram/model calls use
fixtures. Local deployment is recorded below; end-to-end live Telegram behavior
remains unverified.

## Internal model cost query (2026-09-20)

Implemented the skill-granted `query_model_cost` application tool: private-chat
queries for the actor's usage or owner/admin workspace totals, grouped by model
over today, this month or retained history using UTC. Settled costs, reservations
and unknown amounts remain distinct; workspace reports include the current monthly
budget. Reports use existing tenant accounting and do not call provider billing APIs.
Existing published skills need an explicit grant; new starter skills include it.
No dependency or migration is added. See [usage examples](../../examples/model-cost.md).

Verification: Biome, strict TypeScript and production build pass; **197 tests** pass
against disposable PostgreSQL. New coverage exercises UTC boundaries, zero costs,
unresolved charges, per-model totals, tenant/actor/admin/private-chat boundaries,
grants, cancellation, fencing, revocation, replay argument conflicts and a complete
fake-provider Pi execution with durable accounting and duplicate-run recovery.
Included in the local Podman deployment recorded below; live Telegram/model behavior
remains unverified.


## Local rich replies / Stop deployment (2026-09-20)

Updated the local Podman app and worker to image
`localhost/deepx-agent:rich-stop-20260920` (`484928d97634`), also tagged `:local`.
The image includes the current verified workspace source, including rich model
replies, private streaming and native Stop. The existing Code Truth service and
PostgreSQL volume were retained. Migration completed with all ten migrations applied.

Pre-release verification: lint, strict TypeScript, build and **197 deterministic
checks** passed; all **12 browser tests** passed against disposable PostgreSQL.
The Docker-format image passed the isolated Node 24 runtime contract and HTTP/UI
smoke checks, and the existing Compose configuration with Code Truth validated.
A protected custom-format database backup was created and its archive verified at
`backups/deepx-before-rich-stop-20260920T102943Z.dump` (mode 0600). No runs or sends
were active at replacement. The previous image is retained as
`localhost/deepx-agent:before-rich-stop-20260920` (`34c183fc43a4`) for rollback.

Both deployed containers are healthy and use the tested image. `/healthz` returns
`ok`, `/readyz` returns `ready`, and Telegram polling reconnected. The running worker
contains rich-send/draft support and the native Stop update subscription. This stack
uses polling, so no webhook registration was needed. No test Telegram message or
paid model request was sent for release verification. Temporary test containers
were removed; end-to-end Telegram rendering and Stop remain a user staging check.

## Codex implementation workflows (2026-09-21)

Local implementation adds workspace-scoped repository/base-branch/maintainer
configuration, actor-bound coding approvals, durable issue creation and Actions
dispatch, progress/PR reporting, cancellation requests and an admin task list.
The supplied repository workflow runs Codex and checks, then publishes a draft PR
from a fresh job. No live GitHub/Codex run has been performed; repository setup
and a staging run remain required. See [setup and recovery](codex-coding.md).

Validation: `bun run check`, `bun run typecheck`, `bun run build`, and Node runtime
contracts passed. `bun test` passed **211 tests** with PostgreSQL integration tests
enabled, including **14 coding-specific tests**. All **12 browser tests** passed,
including repository/maintainer configuration, edit cancellation and mobile layout.
The repository workflow template passed actionlint 1.7.12. External Codex execution,
GitHub publication and paid-provider billing were not exercised.

## Local native-streaming deployment (2026-09-21)

Updated the existing Podman app and worker to
`localhost/deepx-agent:native-stream-20260921` (`c44c74b5f22a`), also tagged `:local`.
Private requests now start with Telegram's native thinking draft, stream the answer,
and persist one final reply. Normal requests, recaps and one-off corrections no
longer send queue acknowledgements. This image contains the current workspace
source, including the Codex implementation described above.

Validation: all **214 tests** passed with PostgreSQL integration enabled, along with
lint, strict TypeScript and build checks. All **12 browser tests** passed against a
disposable database. The Docker-format image passed its isolated Node 24 runtime
contract and HTTP/UI smoke tests; the existing Compose configuration validated.

No runs or sends were active at replacement. The protected database backup is
`backups/deepx-before-native-stream-20260921.dump` (mode 0600; archive verified).
The previous image remains tagged `localhost/deepx-agent:before-native-stream-20260921`
(`484928d97634`). PostgreSQL storage and the running Code Truth service were retained.
The migration container exited successfully. Both app and worker are healthy,
`/healthz` reports `ok`, `/readyz` reports `ready`, and Telegram polling reconnected.
No test messages or paid model requests were sent; live rendering remains a staging
check. Temporary test containers were removed.

## Private conversation threads (2026-09-21)

Standalone private requests create user/workspace threads; replies to retained user
messages or delivered answers continue them. Thread sources are isolated and
refreshed at execution, with ordered runs and separate recovery transcripts. The
read-only `query_chat_history` tool searches owned private threads with bounded
excerpts, cursor pagination, retention and citation checks. Legacy records are not
inferred into threads. No SQL migration or new dependency is required.

Deterministic unit and isolated PostgreSQL tests cover reply mapping across restart,
duplicate ingress, cross-user/workspace denial, ordered execution, history citations
and retention. Live Telegram/model acceptance remains a staging check. See
[design](../design/private-threads.md) and [examples](../../examples/private-threads.md).

## Native private Topics (2026-09-22)

Private interactive requests now prefer Telegram's native `message_thread_id`
over reply anchors. Same-topic messages share a persisted workspace/user/chat/bot
thread without requiring Reply; different topics have separate default context.
Cross-topic and unavailable reply anchors do not switch the current topic. Outside
Topics, the existing reply-based fallback remains. Native mappings persist in
workspace JSONB without a SQL migration or new dependency; pre-upgrade threads
remain searchable but are not automatically merged into native topic history.
Help, design rules and manual examples now describe native Topics as the primary
conversation interface, with no parallel New/Recent conversation controls.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **247 tests**
passed with disposable PostgreSQL and fake external transports. The full test run
used `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL` and `bun test --timeout 30000`.
The initial focused run hit an existing streaming test's default five-second timeout;
that test and the full suite passed with local proxy bypass and the longer limit.
Coverage includes native topic continuation, conflicting reply anchors, user/bot/
workspace isolation, concurrent duplicate ingress, restart persistence, ordered
execution and failed predecessors, retained history, topic-preserving thinking/
streaming/final delivery, and native Stop isolation. No deployment or live Telegram
messages were performed for this change. See [examples](../../examples/private-threads.md).

## Discussion memory and Topic compaction (2026-09-22)

Native Topics now support internal discussion summaries, decisions, todos, source
links and overlapping relations through core Pi tools. Model policy continues
short follow-ups, answers clear topic changes without confirmation, and retrieves
older summaries/original excerpts when needed. Record updates are staged and commit
with a visible answer; they do not create approvals, persistent instructions or
external actions. Source hashes, retention and topic/actor scope guard reads,
updates and replay. The bounded catalog uses literal search and model semantic
judgment, without an embedding service or extra classifier call each turn.

Context places frozen summaries and growing history before changing metadata.
Stable hashed workspace/thread session keys support Pi/provider cache routing.
At 80% of available context after output reserve, bounded summary batches target
40% while keeping the two most recent runs. Summaries use the configured model with
no tools/extensions or previews and share run budgets, deadline and cancellation.
Separate durable checkpoints recover completed summaries without another model
call; unknown charges are not replayed. Original sources remain available under
retention, and edits/deletion invalidate derived memory. Provider cache token counts
are retained on each usage attempt, including compaction charges.

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **261 tests**
passed. The full test run used `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL`
and `bun test --timeout 30000` with deterministic providers and disposable PostgreSQL. Tests
cover prefix stability, discussion updates/relations/retrieval, permissions and
replay, threshold compaction, accounting, invalid summaries, budget/cancellation/
source-removal failures, unknown outcomes, and checkpoint recovery. No dependency,
SQL migration, deployment, live Telegram send or paid model call is introduced by
local verification. Live summary fidelity, semantic recall and actual cache hit
rates remain evaluation work. See [design](../design/private-threads.md) and
[examples](../../examples/private-threads.md).

## Group conversations and natural follow-ups (2026-09-22)

Interactive group requests now keep per-user continuity scoped to workspace, bot,
group and native Topic (including topic zero). Replying to a confirmed retained bot
answer can join a public discussion. Group history retrieval cannot access private
chats or other topics. Discussion tools, frozen summaries, stable cache identities
and threshold compaction are reused. Manual recaps and schedules keep group coverage.

A plain received message can become a candidate only after that same user's recent
confirmed answer. Local filtering excludes other addressees, commands, stale messages,
anonymous identities and unauthorized users. A bounded tool-free Pi classifier must
return REPLY before ordinary generation. Classification has its own durable checkpoint
and usage purpose, shares budgets and cancellation, and remains silent on uncertainty
or failure. Ignored candidates are cleared from conversation history; ordinary
consented collection remains independent. No dependency or SQL migration was added.

Local tests cover user/topic/bot/workspace isolation, shared replies, discussion
retrieval, prefix stability, compaction, duplicate events, completed-checkpoint recovery,
source changes, revocation, budget/turn limits and unknown-charge recovery. Live
classifier precision, Telegram visibility and provider cache hit rates remain staging
evaluation work. No deployment, BotFather changes or live messages were performed.
See [design](../design/group-conversations.md) and [examples](../../examples/group-conversations.md).

Validation: `bun run check`, `bun run typecheck`, `bun run build` and all **278 tests**
across 36 files passed. The full suite used disposable PostgreSQL, fake Telegram/model
transports, `NO_PROXY=localhost,127.0.0.1`, `TEST_DATABASE_URL` and
`bun test --timeout 30000`. Additional gate cases verify that changing addressee,
cancellation and source removal during classification suppress the answer.

## Local Podman deployment (2026-09-22)

Updated the existing `deepx-code-telegram-bot` stack using `compose.yaml` plus
`examples/code-truth.compose.yaml`. App and worker now run image ID
`sha256:e0a006674e7a7c8b99c0f7f19ff7cc7927a79c0bf3086a1c0cdbc96821118071`,
tagged `localhost/deepx-agent:release-20260922-topics` and
`localhost/deepx-agent:local`. This includes native Topic memory, group conversation
continuity and natural follow-ups. Model configuration retains Chat Completions.
PostgreSQL and Code Truth containers were not recreated.

Release evidence: the unchanged source had passed all 278 unit/integration tests
and check/typecheck/build; all 16 browser tests passed before deployment. The image
passed the Node 24.21.0 / Pi 0.85.1 runtime contract with networking disabled, and
migration plus app/worker startup passed against a separate disposable database.
Compose configuration validation passed. The production database had no queued or
running assistant work or pending/sending deliveries at the pre-cutover check.

A protected pre-deployment PostgreSQL archive was created and its archive directory
validated at `backups/deepx-pre-topics-20260922T043308Z.dump` (ignored by Git).
Migration completed successfully; the schema remains at 10 applied migrations.
Previous image `c8ef95b29cd6a212750d60096d59198d5f27579895f3ff203a845ba98bbd4c29`
is retained as `localhost/deepx-agent:rollback-pre-topics-20260922`.

Post-deployment app and worker health checks passed; `http://127.0.0.1:3000/readyz`
returned `ready`, and the new worker logged `telegram_polling_connected` at
2026-09-22 04:34:06 UTC. Temporary browser/database/smoke containers were removed.
No manual Telegram test message or paid model evaluation was sent. Actual follow-up
classification quality and cache hit rates remain live acceptance work.

## Silent unsupported media deployment (2026-09-22)

Non-text requests no longer receive the text-only pilot warning. Unsupported media,
including captions, is silently ignored by the ask/recap handler.

Updated the existing Podman app and worker to
`localhost/deepx-agent:quiet-media-20260922`, also tagged `:local`, image
`3d4f7a5356e571af1d9a60d2c4924b195fcd2e9da63235e5a78bf311dc4f1df1`.
Lint, strict TypeScript and build passed, along with all 278 tests against disposable
PostgreSQL and all 16 browser tests. The Docker-format image passed the isolated
Node runtime contract, migration and HTTP/UI startup smoke checks. Compose validated.

No runs or deliveries were active at the pre-cutover check. The protected backup
`backups/deepx-pre-quiet-media-20260922T0704.dump` was created and its archive directory
verified. The prior image `82dc91185b8992898417447f20e792dd4a74cbc887d4054cfc7b71e74b3655be`
is retained as `localhost/deepx-agent:rollback-pre-quiet-media-20260922`.
Migration completed successfully; PostgreSQL and Code Truth were not recreated.

Both replaced containers are healthy, liveness/readiness return `ok`/`ready`, and
Telegram polling reconnected at 2026-09-22 07:05:11 UTC. The removed warning is absent
from the deployed worker bundle. Temporary test containers were removed. No manual
Telegram test message or paid model evaluation was sent.

## Local Codex Podman backend — 2026-09-22

- Added the optional `podman` coding backend alongside the existing GitHub Actions
  default, with panel selection and per-repository setup/check commands pinned to
  the maintainer approval. Provider settings follow the inspected device's custom
  Responses-provider configuration. Workspace operators can save, replace and remove
  API keys in the panel; keys are encrypted and redacted. The supervisor environment
  variable `CODEX_PROVIDER_API_KEY` remains an optional fallback.
- Added a trusted supervisor, per-task rootless containers/volumes, bounded execution,
  temporary model proxy credentials, separate preparation and publication, durable
  task state, cancellation, restart reconciliation and retention cleanup. Publication
  rechecks authorization after minting repository-scoped GitHub write credentials.
- Validation: full suite with isolated PostgreSQL **286 passed**; final focused
  coding/runner suite after recovery hardening **24 passed**; browser suite **16
  passed**. Biome, TypeScript and Bun build passed. All three Docker image targets
  built with Podman; the app served health/setup/assets successfully. The real
  Podman smoke passed with fake Codex and a local Git fixture. Merged Docker Compose
  configuration validated. Tests excluded this device's HTTP proxy for loopback
  requests. No live model call, GitHub publication or deployment was performed.
- Panel credential follow-up: save/replace/remove uses workspace-bound AES-256-GCM,
  redacted responses, revision invalidation and active-task cancellation. The runner
  retains an encrypted credential only while preparing/running. Validation: **292
  tests passed**, **16 browser tests passed**, and **11 focused coding integration
  tests passed** after adding key-rotation cancellation coverage. Biome, TypeScript,
  build, all three image targets, app health/assets smoke, real Podman smoke without
  an environment API key, and Compose validation passed. No deployment performed.
- Existing Telegram issue-to-PR semantics remain. Codex session files/thread IDs
  are retained, but continuing a completed task from Telegram is not exposed yet.
  Live custom-provider execution and GitHub publication remain staging gates.
  See [local runner setup and boundaries](codex-runner.md).

## Codex panel credentials deployment (2026-09-22)

Updated the existing Podman stack with `compose.yaml`,
`examples/code-truth.compose.yaml` and `deploy/codex/compose.yaml`. App and worker
run `localhost/deepx-agent:codex-panel-20260922` (also `:local`), image
`8eb16f6b41ffd6d5c553b3f41437b8408902270929c7bda3d17f27ed8163caee`.
The new healthy Codex supervisor uses image `0028cf13ee5f`; the prebuilt local job
image is `39beb8943be7`. Private deployment configuration now includes the Codex
overlay, a generated runner authentication token and the rootless Podman socket.
Provider API keys are configured through the workspace panel; no provider key was
copied from the host or configured as an environment fallback. Existing workspace
backend selections and plugin enablement were preserved.

Pre-cutover counts showed no queued/running runs, pending/sending deliveries or
active coding tasks. A protected database archive was created and validated at
`backups/deepx-pre-codex-panel-20260922T100107Z.dump`; the previous private environment
was also backed up. The old app image remains tagged
`localhost/deepx-agent:rollback-pre-codex-panel-20260922`. Migration completed.
PostgreSQL and Code Truth containers were not recreated.

The rebuilt app image matches the previously tested image, and its isolated Node
runtime contract passed. Compose validation and deployment health checks passed.
The app serves the API-key management bundle, the worker reaches the supervisor,
and the supervisor confirms rootless Podman access. `/readyz` returns HTTP 200
with `ready`; Telegram polling reconnected at 2026-09-22 10:02:32 UTC.
No manual Telegram message, live model test or GitHub publication was performed.

## Local-only Codex and workspace device sign-in (2026-09-29)

Removed the GitHub Actions coding backend from new settings and dispatch. Existing
Actions tasks stop locally with a migration status. The Podman supervisor remains
the sole coding execution path. Split local work into preparation, setup, Codex,
checks and publication phases; setup and checks receive neither model credentials
nor GitHub write tokens. Improved timeout, patch export and cleanup handling.

Added a per-workspace sign-in choice beside the custom provider API key in the
Codex panel. ChatGPT device-code login runs in the supervisor, displays the
OpenAI verification link and one-time code, and seals the account cache per
workspace. Only the Codex implementation container receives a temporary copy;
disconnect and workspace deletion remove the stored credential. Device-code
tasks require selected private repositories and verify current GitHub visibility
again before issue creation and before starting Codex. The custom provider mode
and its per-workspace API key remain available.

Biome, TypeScript, Bun build and Compose validation passed. Focused coding and
device tests passed, including real Podman smoke for both sign-in modes with a
fake Codex executable and local Git fixture. The full suite with loopback proxy
disabled had 307 passes and two unrelated native Telegram Stop failures; the
additional repository privacy regression test passed afterward. The coding
panel browser scenario passed in the full browser run, while a separate run
summary assertion failed. At this validation point, no live ChatGPT sign-in,
model call, GitHub write or deployment was performed; the existing Podman stack
still ran its prior `:local` images.

## Local-only Codex Podman deployment (2026-09-29)

Updated the existing local stack using `compose.yaml`,
`examples/code-truth.compose.yaml` and `deploy/codex/compose.yaml`. The app and
worker now run `localhost/deepx-agent:device-20260929` (also `:local`), image
`2232179827b4d0cd66236d3c0ef87dd54b5ad43aee8f6ba097f8dfe6962ba46a`.
The Codex supervisor runs `localhost/deepx-codex-supervisor:device-20260929`
(also `:local`), image
`20ab636b90bd51f847d64c5a8097b23830f0769ca0bf483019cd3539d9219cad`.
The prebuilt job image is `localhost/deepx-codex-job:device-20260929` (also
`:local`), image
`22b9810f7af650ceef9ebed5e9b23ca4d834fe80a2d634e9a5ae2b84c8e25551`.

Pre-cutover checks found no active runs, deliveries or Codex tasks. A protected
PostgreSQL archive was created and validated at
`backups/deepx-pre-local-device-20260929T071754Z.dump`. Previous app,
supervisor and job images are retained under `:rollback-pre-device-20260929`.
Migration completed without changes. PostgreSQL and Code Truth were not
recreated.

The three images built successfully. The exact job and supervisor images passed
the real Podman smoke with fake Codex for provider-key and device-code tasks;
the app image passed the isolated Node runtime contract. Merged Compose
configuration validated. After cutover, app, worker and supervisor are healthy;
`/readyz` returns HTTP 200, the served UI bundle includes both sign-in methods,
the worker can reach the authenticated device-status endpoint, and Telegram
polling reconnected. No live ChatGPT sign-in, model call or GitHub publication
was performed.

## Verified Telegram GitHub account linking — 2026-10-05

Added private `/github connect`, `/github sync` and `/github disconnect` controls for
eligible members. GitHub App OAuth uses PKCE and a one-use ten-minute flow; the
same Telegram sender confirms the stable GitHub identity before linking. Encrypted
user/refresh credentials stay outside workspace API responses. Permission snapshots
sync about every five minutes, intersect user access with workspace-selected repos,
and appear in Members & access. Linked users' reads/issues require read access;
coding also needs write/admin plus the existing maintainer grant. Missing, stale or
failed snapshots deny access; downgrades invalidate pending work. Automatic token
rotation is serialized and refresh failures clear grants. Existing unlinked members
retain the manually configured policy; mandatory linking is not enabled globally.

Apply migration `012_github_users.sql`. Documentation and a runnable Telegram command
example were added. Local verification passed **328 tests across 41 files** against
disposable PostgreSQL and **18 browser scenarios**, including member permission
display and search. The final focused linking/permission suite passed **11 tests**.
The build, strict typecheck and checks scoped to these changed files passed.
Repository-wide lint still reported issues in concurrently edited Codex collaboration
files; these edits were preserved. The final table-layout follow-up also passed three
focused browser scenarios. No deployment, account connection, live Telegram
message or GitHub write was performed. See [GitHub linking](github-app.md#connect-a-verified-telegram-members-github-account)
and [command examples](../../examples/github-user-linking.md).

## Admin site custom domain (2026-10-05)

Deployment operators can configure the admin panel hostname from **Site domain**.
The persisted deployment setting updates admin origin checks and GitHub/Telegram
callback generation in the app and worker without restarting. Domain changes are
versioned and audited atomically, expire pending GitHub connections and require
explicit webhook re-registration. The original environment address remains a
recovery origin. DNS/TLS/proxy provisioning and reachability remain external and
unverified; the panel provides instructions and callback URLs.

Validation: all 350 unit/integration tests passed with isolated PostgreSQL and
`NO_PROXY=localhost,127.0.0.1`; lint, strict type checking and build passed. The new
browser scenario passed on desktop and at 390px width, including invalid-hostname
errors, retained drafts, saving and restoring the default address. Domain-specific
coverage includes operator-only access, Origin/CSRF, normalization, persistence,
revision conflicts, audit deduplication, secure cookies, generated GitHub callbacks
(including Telegram linking), explicit webhook registration and removed-origin
rejection. Public DNS, certificate issuance and live provider changes were not run.

2026-10-07 card update: **Update connected services** groups GitHub App URLs into
labeled, copyable rows and separates Telegram guidance. Copy controls briefly show
a check on success and provide manual-copy guidance if clipboard access fails.
Long URLs wrap on narrow screens in both themes. Before settings load, labels stay
visible and copy controls remain disabled, including after a failed initial request.
Polling needs no webhook update; webhook mode retains its status and explicit
registration action. Deterministic browser coverage in
`tests/browser/connected-services.e2e.ts` checks copying, clipboard failure,
loading/retry, both Telegram modes, and light/dark layouts at 1280px and 390px.

## Codex device sign-in recovery (2026-10-05)

The configuration dialog now shows progress while starting device sign-in, bounds
the request to 20 seconds, and unlocks controls with an actionable error if it
stalls. **Recheck connection** checks runner availability and recovers a pending
login without closing the dialog or discarding unsaved configuration. Pending
status polling uses bounded, sequential requests and ignores results after its
owning effect has stopped.

Lint, strict typecheck and build passed. All **352 unit/integration tests** passed
against disposable PostgreSQL. Four deterministic browser scenarios passed:
unavailable-runner recovery with draft preservation, code display and polling to
connected, failed-login retry, and timeout followed by recovery of a pending code.
The live `dev.stonegate.me` configuration dialog was inspected and reported the
runner unavailable; no live account login, model call or deployment was performed.
Restoring that deployment's runner and applying this UI change remain outstanding.

## Codex repository access through the connected GitHub App (2026-10-06)

Both Codex model authentication methods now support selected public and private
repositories. The connected workspace GitHub App supplies fresh installation
tokens scoped to the repository and operation, including private checkout access.
ChatGPT account authentication no longer adds a repository-visibility restriction.
Maintainer grants, connected-repository checks, account sign-in, reviewed approvals,
explicit Direct execution policy and publication fencing remain enforced.

Removed the private-only checks during proposal, reviewed issue creation, runner
start and continuous-task authentication recovery. Updated panel guidance and
operator examples. Historical private-only behavior above describes older builds.

Validation: lint, strict typecheck and build passed. All 400 deterministic tests
passed against disposable PostgreSQL with loopback traffic excluded from the host
proxy. Coverage includes public/private reviewed and direct starts, scoped GitHub
credentials, denied GitHub access, duplicate dispatch, maintainer boundaries and
account recovery after repository visibility changes. No production configuration,
account connection, GitHub write, Telegram send or deployment was performed.

## Automatic repository metadata refresh (2026-10-06)

Manage GitHub and Codex repository lists refresh while visible and on return from
GitHub. Five-second polling uses Metadata-read installation tokens, matches saved
repositories by numeric ID, updates names/visibility and matching Code Truth URLs,
and removes IDs no longer accessible to the App. New IDs still require workspace
authorization/selection. Expanded lists, selected IDs and unsaved editor values
remain intact; concurrent settings edits retain their version-conflict protection.
Failures retain saved metadata with a notice, and delayed responses cannot undo
disconnect, reconnect or revoked ownership. Webhooks remain disabled; this is near
realtime polling while the panel is open.

Validation: `bun run check`, `bun run typecheck`, `bun test` (411 tests against
disposable PostgreSQL) and `bun run build` passed. All 26 focused browser scenarios
passed across repository refresh/search, Codex sign-in and loading states, including
rename/link updates, retained drafts and stale-save rejection. No dependency or
migration was added. No live GitHub call, Telegram send or deployment was performed.
See [behavior and limits](github-app.md#automatic-repository-updates) and the
[manual staging check](../../examples/github-repository-sync.md).

## Compact run history and pagination (2026-10-08)

The runs API now returns explicit summary fields and pagination metadata, with a
default page size of 25 and a validated maximum of 100. The panel fetches 25 items
per page and retrieves full messages, attempts and delivery records only through
the existing detail endpoint. Page transitions discard previous-page rows;
loading, retry, empty and out-of-range states are explicit. Detail/back navigation
and browser history preserve the list offset. Workspace read and mutation
permissions are unchanged. See [the API contract](../design/admin-panel.md) and
[runnable requests](../../examples/runs.http).

2026-10-10: Pagination now follows the run list and its loading/empty states.
Desktop (1280px) and mobile (390px) screenshots were inspected for populated,
loading, empty and error states. All 10 Runs browser scenarios, 661 deterministic
tests with disposable PostgreSQL, lint, strict TypeScript and the build passed.

Compatibility: list items no longer contain full run records, and the default
page size changes from 100 to 25. Clients needing details must use the detail
endpoint; clients needing 100 summaries can specify `limit=100`. The workspace
is still loaded from its JSON database record; this reduces response size and
summary construction work, not database reads. Offset pages can shift when new
runs arrive or retention removes older runs; they are not a snapshot.

Verification: `bash scripts/verify-skills.sh quality` runs dependency preparation,
quality/type checks, deterministic PostgreSQL tests, the build and Node runtime
contract. `bash scripts/verify-skills.sh runs-browser` prepares its own database
and runs the runs/admin browser suites, including desktop/mobile pagination,
on-demand details, loading/error recovery and preserved navigation.

## Dedicated run detail pages (2026-10-06)

Compact run cards link to `/admin/runs/:runId?workspace=:workspaceId` instead of
opening a modal. The page retains messages, coverage, pinned versions, the model
attempt timeline, delivery evidence and existing authorized recovery/cancel/retry
controls. Back to Runs preserves the workspace and list offset. Direct visits and
refreshes fetch a single run independently of list pagination through
`GET /api/admin/workspaces/:id/runs/:run`; missing runs and failed loads show an
explicit error with navigation and retry controls. Access remains scoped to the
workspace, and unlinked deployment administrators retain read-only run access.
See [the runnable requests and page URL](../../examples/runs.http).

Validation: `bun run check`, `bun run typecheck`, `bun test` (415 tests against
disposable PostgreSQL) and `bun run build` passed, with the host HTTP proxy disabled
for local test fixtures. Four browser scenarios passed for desktop/mobile layouts,
keyboard navigation, direct visits, refresh, back navigation, pagination, load
recovery and switching to a missing run. Desktop and mobile screenshots were
reviewed. No dependency or migration was added.

### Bot access follows active membership (2026-10-07)

All active workspace members can use the bot. The Members & access page no longer
shows access modes, a whitelist column/toggle or policy preview/apply controls.
Roles, repository grants, workspace pause and member deactivation still apply to
requests, callbacks, queued work, schedules and delivery. Access-request approval
and owner verification enroll active members without a second access list.

Migration `015_remove_workspace_whitelist.sql` removes saved workspace policies
and preserves their concurrency revision as `memberVersion`. Active members
previously excluded by a whitelist now have bot access; listed non-members remain
non-members, and existing cancelled work/suspended schedules retain their state.
The member API returns a membership revision with searchable, paginated profiles;
retired access-policy API routes are unavailable. Old browser links still redirect.

Deterministic and PostgreSQL checks cover active/inactive/non-member and role
boundaries, revocation of runs/approvals/schedules/delivery, stale edits, last-admin
protection, access-request replay, repeated migration and retired APIs. All 17 admin
browser tests passed, including membership deactivation/reactivation across reload,
removed controls, Telegram profiles, desktop/mobile layouts and setup enrollment.
Lint, TypeScript and production build passed. See [membership and access](../design/access-control.md).

## Telegram repository picker (2026-10-08)

`/repos` now opens native inline buttons for up to ten active workspace-selected
repositories. The requester's retained mentions and recent selections rank first;
remaining repositories use saved GitHub push/update timestamps with stable name
ordering when activity is unavailable. `/repos <name>` searches beyond the first
ten. The current selection is labeled and checked, with a Clear selection action.
Archived/disabled repositories, denied upstream grants and private group choices
are excluded. GitHub timestamps refresh through existing admin repository refresh;
timestamp-only updates preserve the connection revision and existing grants.

Selection is persisted per workspace, actor, bot and chat/topic, expires with
retention, and supplies default repository context to subsequent interactive runs.
Original requests and explicit targets are preserved; selection grants no write
or coding authority. Callback controls bind to a confirmed delivery, actor, bot,
destination and current connection, expire after fifteen minutes and are consumed
after selection. New menus revoke older controls and queued replies. Access and
current saved delivery state are rechecked immediately before sending. Workspace
deletion purges selection state.

The active worker publishes Telegram's default/group command menus and a private
menu that includes `/github` for account linking alongside `/repos`, Ask, Status,
Cancel and Help. `/github` reuses the existing verified private linking flow;
`/github connect`, sync and disconnect remain supported. Registration runs outside
polling and maintenance, is once per worker/credential, honors retry backoff and
stops old-client writes after credential changes. Scoped menu visibility does not
replace request authorization. Explicit language/chat-specific Telegram overrides
can take precedence over these menus.

Validation: **610 deterministic tests passed** against disposable PostgreSQL with
host proxies disabled. Focused tests cover ranking/name boundaries, ten-row limits,
search and empty states, selection/clearing, actor/topic/bot isolation, duplicate
updates, copied/stale/revoked callbacks, pending delivery revocation and retention.
Lint, strict typecheck, build and the Node runtime contract passed. No dependency
or migration was added. No live Telegram send, GitHub call or deployment was
performed; native Telegram desktop/mobile rendering remains a staging gate.
See [the runnable picker journey](../../examples/telegram-repositories.md).
