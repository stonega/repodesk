# Admin web panel

Status: proposed P0 scope, added at the user's request. Implementation is part of
[the bot plan](../implementation/bot-plan.md). This is a browser administration
surface; embedding it as a Telegram Mini App is optional later.

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
| Bot settings | Display label, reply language, timezone, base instructions, response style, directed-response mode, pause switch | Validated form, versioned save, audit entry, saved/effective version shown. |
| Model settings | Deployment-approved provider/model, reasoning setting where supported, output/turn/time limits | Unsupported combinations rejected; secrets masked; active runs keep their starting configuration. |
| Groups and access | Connected group/topic, owner, bot visibility, history coverage, opt-in collection, unlink | Linking verifies authority; no arbitrary chat ID can be used to obtain access. |
| Workflows | Create/edit draft, preview schedule and destination, approve, pause/resume, run now, delete | Same policy and version checks as Telegram buttons; edits cannot bypass approval. |
| Agent skills | Create/import/edit, test, publish, enable/disable, scope, settings and version rollback | Permission-bounded skills; pinned workflow versions; disabling blocks dependent execution. |
| Shared instructions | List, edit, scope, provenance, versions, forget | Never lists other users' personal memories by virtue of admin role. |
| Runs | Filter by state/date/workflow, status, authorized result, evidence references, cost, cancel/retry | Retry creates a traceable attempt; uncertain delivery cannot be blindly resent. |
| Usage and limits | Recorded/estimated usage, daily/monthly caps, reservations and blocked jobs | Changes apply atomically; concurrent workers cannot overspend the displayed cap. |
| Members and roles | Enroll/revoke members, assign workspace admin, transfer workflow ownership | Cannot remove the last workspace owner without a valid transfer. |
| Allowed users | Configure whitelist-only/members mode; add, remove, search and bulk import Telegram user IDs; preview affected access | Empty enforced list denies; checks apply to bot and panel; removal blocks queued work and schedules owned by affected users. |
| Privacy and audit | Retention settings, deletion request/status, configuration/action audit | Destructive changes show scope; logs omit credentials and raw private chat text. |
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
| `/api/admin/operator/*` | Deployment-wide health and restricted controls |

These are proposed resource boundaries. Define shared request/response schemas before
implementing forms; call domain services rather than duplicating Telegram logic.

## UI acceptance and testing

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
