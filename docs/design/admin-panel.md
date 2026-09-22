# Admin web panel

Status: P0 design contract with a local React Router implementation. See
[implementation evidence](../implementation/implementation-status.md) for the tested
subset and deliberate UI choices. Embedding it as a Telegram Mini App remains optional.

## Deployment and application shape

Use React Router 7 in SPA mode with Tailwind/shadcn components as needed. Put the
frontend in `web/` and build static assets into the existing Node Docker image.
Hono serves `/admin/*` and `/api/admin/*` on the same origin. Serve the SPA fallback
only for admin page requests, never for missing API endpoints. Frontend routes use
client loaders/actions to call the API; authentication and authorization run on the
server for every request. [React Router SPA mode](https://reactrouter.com/how-to/spa)

No browser model SDK or provider key is needed: AI runs through Pi on the backend.
The browser reads paginated data and polls status initially; add SSE only when useful.
Public static assets can load before login, but contain no workspace data or secrets.

## Pages and scope

| Page | P0 controls and information | Acceptance criteria |
| --- | --- | --- |
| First-run setup | Claim deployment, create local admin, configure bot/model/access/skills, review and activate | Resumable; one initial admin; no public reinitialization or premature activation. |
| Sign-in/workspace selector | Local admin sign-in; optional linked Telegram sign-in, authorized workspaces, logout | Login does not grant a workspace role; revoked sessions stop working. |
| Overview | Bot/worker status, connected group, recent runs, active schedules, spend/budget | Loading, empty, stale and failure states are visible; tenant-scoped metrics. |
| Bot settings | Display label, timezone, base instructions, response style, directed-response mode, pause switch | Validated form, versioned save, audit entry, saved/effective version shown. |
| Model settings | Operator-configured OpenAI-compatible base URL, write-only API key, custom model ID, thinking level and token prices; workspace output/turn/time limits | Invalid settings rejected locally; provider capabilities require evaluation. Runs pin endpoint/thinking/prices at first execution; endpoint changes stop old runs. |
| Groups and access | Connected group/topic, owner, bot visibility, history coverage, opt-in collection, unlink | Linking verifies authority; no arbitrary chat ID can be used to obtain access. |
| Workflows | Create/edit draft, preview schedule and destination, approve, pause/resume, run now, delete | Same policy and version checks as Telegram buttons; edits cannot bypass approval. |
| Plugins | Independent workspace registry of installed Pi extensions, managed by its operator; version/path/tool editing, enable/disable/remove, file status and revision conflicts | Database-backed settings reach workers without restart; settings and revisions isolated per workspace; no code executes on API reads/saves. |
| GitHub | Guided App creation for personal or organization accounts, workspace OAuth, installation/repository selection and disconnect | Manifest state bound to operator/session/workspace; encrypted operator App credentials; one-use PKCE OAuth; verify user installation/repository access; installation tokens limited to selected repositories and Contents read. |
| Agent skills | Create/import/edit, test, publish, enable/disable, scope, settings and version rollback | Permission-bounded skills; pinned workflow versions; disabling blocks dependent execution. |
| Shared instructions | List, edit, scope, provenance, versions, forget | Never lists other users' personal memories by virtue of admin role. |
| Runs | Filter by state/date/workflow, status, authorized result, evidence references, cost, cancel/retry | Retry creates a traceable attempt; uncertain delivery cannot be blindly resent. |
| Usage and limits | Recorded/estimated usage, daily/monthly caps, reservations and blocked jobs | Changes apply atomically; concurrent workers cannot overspend the displayed cap. |
| Members & access | Search Telegram names/usernames/IDs; manage membership, roles and requests; configure access mode and whitelist with impact preview | Show membership, whitelist and effective access separately in one table. Preserve last-admin protection, tenant boundaries and revocation checks. |
| Privacy and audit | Retention settings, deletion request/status, configuration/action audit | Destructive changes show scope; logs omit credentials and raw private chat text. |
| Runtime logs | Operator-only API/worker/polling/run/delivery events; severity/service/search filters, cursor pagination, auto-refresh | Static messages and allowed error codes; no secrets/private text; workspace metadata scoped to its operator; seven-day/10,000-entry retention. |
| Operator settings | Readiness of global bot/provider credentials, webhook state, allowed models, maintenance controls | Deployment-operator-only; workspace admins cannot modify global bot identity or webhook. |

See [first-run setup](first-run-setup.md) and [agent skills](agent-skills.md) for detailed
P0 flows. Later: connector authorization/sharing, artifact library, scripted skill
execution and billing.
Do not display inactive placeholders as working features. The configuration panel
must work without manually editing database rows.

## Identity and authorization

Apply the configurable [allowed-user whitelist](access-control.md) to workspace access
in both the bot and this panel. Allowlisting grants eligibility, not an admin role.

On an uninitialized deployment, use the [first-run wizard](first-run-setup.md) to
create a local deployment admin, protected by a one-time host-issued claim token.
Local admin login permits configuration before any Telegram token exists. Store
password hashes and revocable server-side sessions; no public first-visitor signup.

After bot configuration, allow verified Telegram identity linking and optional
Telegram web login for workspace users. Validate signed data and freshness server-side;
use Secure/HttpOnly/SameSite cookies and reject replay/login-CSRF attempts. Workspace
membership, roles and the allowed-user policy remain separate from authentication.
[Telegram web login](https://core.telegram.org/bots/features#web-login)

The local deployment admin may configure credentials, initial workspaces and recovery.
Bot execution and private conversation access require a linked, eligible Telegram
identity. Workspace admins cannot modify another workspace or deployment-wide secrets.

Require CSRF tokens/origin checks for mutations, rate-limit authentication and expensive
actions, rotate sessions after login and privilege changes, and support logout/revocation.
Escape output content; do not render generated HTML as trusted UI.

## Configuration behavior

Store typed, validated settings with monotonically increasing versions. UI reads the
current version and writes with an expected version; stale writes return a conflict
with a diff/reload choice. Persist setting changes and audit entries atomically.
Notify workers through version refresh, not in-memory mutations in the API process.

At run start, snapshot model, instruction and workflow versions. Routine edits apply
to future runs. Emergency pause, membership revocation, budget restrictions and
deletion are checked again before each costly/action step and before delivery.

The first-run wizard and operator settings accept bot/provider credentials as write-only
inputs in P0, encrypting them with a Docker-injected application key. Environment-provided
keys may be referenced instead. Responses show status and safe labels only; credentials
never enter model context, frontend storage or audit diffs. The database connection,
encryption key and bootstrap-token issuance stay operator-level deployment settings.

## API plan

| Endpoint family | Responsibility |
| --- | --- |
| `/api/setup/*` | Initial admin claim, authenticated setup draft, validation and activation |
| `/api/admin/auth/*` | Local login, optional Telegram linking/login, session, logout |
| `/api/admin/workspaces` | List authorized workspaces |
| `/api/admin/workspaces/:id/settings` | Read/update versioned bot/model/usage/retention settings |
| `/api/admin/workspaces/:id/chats` | List/link/unlink chat bindings and context collection |
| `/api/admin/workspaces/:id/workflows/*` | Workflow drafts, previews, approval and lifecycle actions |
| `/api/admin/workspaces/:id/skills/*` | Catalog, versions, tests, publication and assignments |
| `/api/admin/workspaces/:id/instructions/*` | Scoped memory/instruction management |
| `/api/admin/workspaces/:id/runs/*` | Authorized history, details, cancel and retry |
| `/api/admin/workspaces/:id/members/*` | Membership and roles |
| `/api/admin/workspaces/:id/access-policy` | Versioned access mode and allowed-user list management |
| `/api/admin/workspaces/:id/usage` and `/audit` | Paginated accounting and audit metadata |
| `/api/admin/workspaces/:id/deletion` | Request/status of authorized purge |
| `/api/admin/workspaces/:id/plugins` | Read/update the workspace-scoped Pi extension registry with optimistic revisions and atomic audit |
| `/api/admin/operator/*` | Deployment-wide health and restricted controls |

Group access cards display the last known Telegram group title with the ID below it,
falling back to the ID when the title is unknown. Titles are captured on linking and
subsequent group updates. Recheck bot visibility also refreshes the title for existing
bindings; inaccessible groups retain their last known name.

These are proposed resource boundaries. Define shared request/response schemas before
implementing forms; call domain services rather than duplicating Telegram logic.

## UI acceptance and testing

Structured responses use labeled details and lists with readable dates, statuses,
booleans and currency rather than JSON dumps. Setup, workflow, skill, instruction,
run, reconciliation and operator forms use explicit labeled controls, selection
lists and tool checkboxes. Bound IDs and concurrency versions remain in request
payloads without becoming editable fields. Failed saves preserve drafts and show
field errors; pending saves block modal dismissal and duplicate submission.

Usage & budget displays a table of attempt times, models/run IDs, reservation
statuses and reserved/actual USD amounts. The spend and monthly-limit summary stays
above the table. Previous/next controls use the accounting API's 100-record pages,
with URL offsets and visible record/page counts. Loading, empty and error states
are explicit; the table scrolls horizontally within the card on small screens.

Common admin actions use Reicon outline icons through `web/icon-button.tsx`.
Icon buttons are borderless and retain descriptive accessible names, hover titles,
keyboard focus, 44px hit targets and disabled/busy states. Primary form submissions, authorization,
approvals and actions needing consequence text retain visible labels. Existing
confirmation and permission checks still apply. See [UI rules](ui-rules.md).
Routine pages, sections and the sidebar omit refresh buttons. Explicit text
recovery actions appear after load failures or conflicting edits. Logs offer manual
refresh when automatic updates are off or have failed; active coding tasks offer
Check progress. Workspace settings shows its saved version as a badge after the
title, updating after saves or conflict recovery.

Add/Create controls open the shared native modal in `web/modal.tsx`. Related
record editors reuse it. The background is inert, keyboard focus stays inside,
Escape/Cancel discard the local draft and focus returns to the opener. Failed
saves preserve entered values and show errors inside the dialog; saves in progress
disable dismissal and repeated submission. Dialogs scroll within a mobile viewport.
Primary and Cancel buttons share one action row, with Cancel immediately after
the primary action in visual and keyboard order. Narrow layouts wrap in that order.
Repository and network dialogs apply to a local Code Truth draft; **Save Code Truth**
still persists the configuration. Creating workflows/instructions still produces
an approval proposal, and creating a GitHub App still requires GitHub confirmation.

Test unauthorized/expired sessions, role downgrades, forged workspace IDs, cross-tenant
reads, stale saves, credential redaction and CSRF. Test admin scheduling and Telegram
scheduling against the same backend contract.

Browser tests cover sign-in with a test identity adapter, changing bot instructions,
saving a model configuration, conflicting edits, pausing a workflow and viewing the
matching audit event. Inspect desktop/mobile layouts, keyboard navigation, form labels,
confirmation dialogs and errors. Test identities must be disabled in production.

Release demonstration: configure the bot from the panel, see the new version take
effect in Telegram, create/approve a schedule, inspect its run, then pause it from
the panel and confirm no next run is dispatched.

The **Plugins** page also offers predefined **Code Truth**: enable/disable, add/remove GitHub repositories, edit network-to-branch mappings, configure repositories for the selected workspace, and sync/check index readiness with commit provenance. `/api/admin/workspaces/:id/plugins/code-truth` supports GET/PUT; `/status` supports POST with `{}`; the URL identifies the workspace. These share workspace plugin revision checks and operator authorization.

[GitHub App setup and API](../implementation/github-app.md) documents the implemented workspace connection flow.

### Access request review (implemented)

The **Members & access** page includes **Access requests** and a shareable
Telegram request link. Pending rows show the Telegram ID, available display name and
username, and request time. **Approve access** grants regular membership plus whitelist
eligibility; **Reject request** dismisses the request without granting access. Actions
are disabled while saving, conflicts keep the request visible for reload, and successful
approval refreshes the member list. See [access control](access-control.md#telegram-access-requests-implemented-2026-09-20)
for tenant routing, retention, authorization and API behavior.
