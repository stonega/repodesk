# First-run onboarding and initial admin

Status: **P0 design contract, locally implemented**. The first browser visit opens a
first-administrator form. See [setup](../implementation/setup.md) for the implemented
verification/activation sequence and [evidence](../implementation/implementation-status.md)
for external gates. Optional web login and live model evaluation are not completed.

## Entry and ownership

`GET /` redirects to `/setup` until an admin exists, then to `/admin`. An existing
admin with incomplete configuration sees a resumable setup checklist after login.
Other visitors see login, never another create-admin form.

The setup page is visible before login and asks only for a username and password.
The first successful submission creates the deployment administrator and a session.
The server locks the deployment row and atomically checks its unclaimed state,
creates the account and marks it claimed; concurrent requests cannot create two
initial administrators. Initialized deployments reject further claims. Complete
first setup before exposing a fresh deployment beyond localhost, because anyone
who can reach an unclaimed deployment can submit the first account.

Updated 2026-09-27 following the user's request to remove bootstrap tokens and keep
first setup to username and password only.

This is our application design, not built-in behavior supplied by Pi or Docker.

## Wizard steps

| Step | UI and action | Completion rule |
| --- | --- | --- |
| Create admin | Username and password on the first-run entry | Atomically verify unclaimed state, create the local deployment-admin account and a revocable session. |
| 1. Workspace | Enter a workspace name, select an IANA timezone, then continue | Continue saves the draft before advancing. Budget and retention policies can be adjusted later in Workspace settings. |
| 2. Connect Telegram | Enter a BotFather token in a write-only field, then Continue | Validate bot identity and show its username without returning the token. |
| 3. GitHub App | Click Connect GitHub; confirm authorization and choose repositories during GitHub installation | The setup page verifies one accessible installation and connects its granted repositories, then shows a RepoDesk welcome dialog with confetti. Get started opens the workspace. Detailed controls remain in Plugins. The bot stays inactive until model settings, a skill and activation are completed in the panel. |

The authenticated wizard uses the administrator entry's two-panel visual layout.
Only one step is shown at a time; step navigation allows returning to saved work.
Setup resumes from saved server state. GitHub registration and authorization return
to the GitHub step when started there. Authorization alone does not grant repository
access; the App must also appear under Installed GitHub Apps. Setup waits for an
installation and verifies its repositories before showing the welcome dialog.
The operator's New workspace action in the admin selector reuses this wizard with
a blank workspace form. After saving, the new workspace ID stays in the URL so
reloads and GitHub callbacks continue setup for that workspace. The Telegram bot
is deployment-wide and can be retained when already configured. Operators can
cancel before creating the workspace or finish GitHub connection later in the
admin panel.
After activation, the web administrator can share an access-request link,
approve requests, directly allow a numeric Telegram ID, or revoke a member in
Model settings. The bot denies ordinary use until a member is explicitly allowed.
Linking the administrator's personal Telegram account later grants owner actions
in Telegram. Optional group linking and detailed workspace policies can be
configured after activation.

Before activation, process only tightly scoped control interactions; normal model
requests remain disabled. For local operation, explicitly select
`TELEGRAM_TRANSPORT=polling`; the worker receives the same control interactions
without an HTTPS webhook. Owner linking works before or after activation and
never bypasses Telegram sender identity, membership or whitelist checks.

## Authentication and privilege model

Create a **local deployment admin** first so bot setup does not depend on Telegram
login already working. Store a salted password hash through a maintained password-
hashing library, never plaintext or reversibly encrypted passwords. Use revocable
server-side sessions, secure cookies, CSRF protection and rate-limited authentication.
Choose and verify the maintained authentication implementation in the setup slice.

The deployment admin may configure this deployment, credentials and initial workspace
provisioning. This does not authorize reading private conversations or acting as a
Telegram user. Bot usage, approvals, schedules and ordinary workspace-panel access
still require a verified Telegram identity, membership, whitelist eligibility and role.
Optional Telegram web login can be enabled after the bot/domain are configured.

Operator recovery uses an authenticated host/container command to reset local admin
access with an audit record. It never silently reopens public bootstrap. No default
password or production authentication-bypass flag is shipped.

## Credentials and persistence

Web-based bot/provider setup is P0. Inputs are write-only; responses expose only
configured/missing/invalid state and safe labels. Encrypt stored API credentials with
an application encryption key supplied as a Docker runtime secret outside the DB.
Keep credentials out of model inputs, frontend storage, logs and audit diffs. Existing
environment-provided credentials may be used as read-only references.

The DB connection and encryption key are operator-level deployment prerequisites. Missing encryption configuration blocks credential saving
with an actionable error. Back up the key separately from the encrypted database;
document rotation/recovery before launch.

Persist a deployment setup record, completed steps and configuration versions. Save
each step so refresh/restart can resume safely. Steps that need external checks record
their result and time; changing the associated value invalidates the prior check.

## Activation state and failure recovery

Use `unclaimed → admin_created → configuring → ready → active`, with a recoverable
`activation_failed` result. The create-admin transaction permanently consumes the
initial setup claim; later retries resume using the admin session. Setup progress alone
does not enable model work or schedules.

Allow setup to resume from any authenticated step. Missing bot or model
configuration keeps the bot inactive and shows next actions in the dashboard.
An empty whitelist is valid at activation and denies all ordinary bot use until
the administrator explicitly allows a member. Owner linking is optional.

Make activation idempotent. If webhook registration succeeds but the final DB write
fails, a retry inspects and reconciles remote state. If registration fails, keep
processing disabled and show a retry action without discarding the draft. Successful
activation keeps authenticated access management and optional identity-linking
routes available.

## Proposed APIs and validation

- `/api/setup/status`: minimal initialized/needs-claim status, no secrets or admin details.
- `/api/setup/claim`: atomically verify unclaimed state and create the initial admin account from a username and password.
- `/api/setup/progress`: authenticated resumable draft/checklist.
- `/api/setup/validate/*`: scoped bot/model/config checks with redacted errors.
- `/api/setup/activate`: idempotent prerequisite validation and activation.

Claiming ownership and account creation are one atomic operation. An abandoned
first page cannot reserve ownership indefinitely.

Acceptance: fresh install redirects to setup; cross-origin claims and invalid credentials fail; concurrent
claim creates one admin; reload/restart resumes; initialized deployments cannot be
reclaimed; wrong bot token/model key is recoverable; secrets never appear in responses;
activation cannot bypass model, receiver or skill prerequisites; failed activation remains
inactive; operator recovery does not require a working Telegram bot.
