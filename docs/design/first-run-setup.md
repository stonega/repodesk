# First-run onboarding and initial admin

Status: **P0 design contract, locally implemented**. The first browser visit opens a
claimed setup wizard. See [setup](../implementation/setup.md) for the implemented
verification/activation sequence and [evidence](../implementation/implementation-status.md)
for external gates. Optional web login and live model evaluation are not completed.

## Entry and ownership

`GET /` redirects to `/setup` until an admin exists, then to `/admin`. An existing
admin with incomplete configuration sees a resumable setup checklist after login.
Other visitors see login, never another create-admin form.

The setup page is visible before login, but claiming the deployment requires a
one-time bootstrap token obtained through a local container command. Store only its
hash, bind it to this deployment, expire it and consume it atomically with first-admin
creation. Do not put it in URLs, images, JavaScript bundles or routine logs. Concurrent
requests cannot create two initial administrators. A fresh host without a token shows
instructions for the operator to generate one; visiting first does not grant ownership.

This is our application design, not built-in behavior supplied by Pi or Docker.

## Wizard steps

| Step | UI and action | Completion rule |
| --- | --- | --- |
| 1. Claim deployment | Enter the bootstrap token | Server verifies unclaimed state and token; no other configuration disclosed. |
| 2. Create admin | Admin username, password and confirmation; optional contact email | Create the local deployment-admin account and a revocable session. No Telegram credentials or email provider needed. |
| 3. Workspace | Name, language, timezone and initial retention settings | Save a draft workspace and show the scope of administration. |
| 4. Connect Telegram | BotFather instructions; enter bot token in a write-only field; validate bot identity | Show bot name/username and validation result without returning the token. |
| 5. Link Telegram owner and access | Verify an owner through a one-time interaction with the configured bot; choose whitelist mode and allowed IDs | Add the verified Telegram owner as workspace member/owner and seed the whitelist. Typed IDs alone do not verify ownership. |
| 6. Model | Enter an OpenAI-compatible base URL, write-only API key, suggested/custom model ID and thinking level; configure token prices and budgets | Validate settings locally. Saving makes no model request; live capability testing remains an explicit evaluation step. |
| 7. Skills and behavior | Choose starter skills, edit permitted settings, preview instructions and required tools | Activate only valid approved versions; show unavailable dependencies. |
| 8. Delivery and group | Confirm the public HTTPS origin/webhook URL; optionally link a group and choose collection scope | Private-only setup is valid. Group linking requires the separate admin/access checks. |
| 9. Review and activate | Summary of bot, owner, model, skills, access, costs and data scope | Explicit activation validates prerequisites, registers/verifies the webhook and then enables processing. |

During owner verification, process only the tightly scoped verification interaction;
normal model requests remain disabled. Implementation may use a temporary verified
webhook for this control flow; do not depend on a fully active bot to establish its
first owner. For local operation, explicitly select `TELEGRAM_TRANSPORT=polling`; the worker
receives the same verification interaction without an HTTPS webhook. If neither
transport is ready, leave owner linking pending and permit the deployment admin to
finish other settings. Polling never bypasses owner identity or whitelist checks.

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

The DB connection, encryption key and bootstrap-token command are operator-level
deployment prerequisites. Missing encryption configuration blocks credential saving
with an actionable error. Back up the key separately from the encrypted database;
document rotation/recovery before launch.

Persist a deployment setup record, completed steps and configuration versions. Save
each step so refresh/restart can resume safely. Steps that need external checks record
their result and time; changing the associated value invalidates the prior check.

## Activation state and failure recovery

Use `unclaimed → admin_created → configuring → ready → active`, with a recoverable
`activation_failed` result. The create-admin transaction permanently consumes the
bootstrap claim; later retries resume using the admin session. Setup progress alone
does not enable model work or schedules.

Allow **Save and finish later** from any authenticated step. Missing bot/model/owner
configuration keeps the bot inactive and shows next actions in the dashboard. A
skipped group is acceptable; unavailable credentials or an empty enforced owner
whitelist are not valid activation prerequisites.

Make activation idempotent. If webhook registration succeeds but the final DB write
fails, a retry inspects and reconciles remote state. If registration fails, keep
processing disabled and show a retry action without discarding the draft. Successful
activation closes setup mutation endpoints except authenticated configuration routes.

## Proposed APIs and validation

- `/api/setup/status`: minimal initialized/needs-claim status, no secrets or admin details.
- `/api/setup/claim`: atomically verify token and create the initial admin account.
- `/api/setup/progress`: authenticated resumable draft/checklist.
- `/api/setup/validate/*`: scoped bot/model/config checks with redacted errors.
- `/api/setup/activate`: idempotent prerequisite validation and activation.

The claim token and account form may be separate visual steps, but claiming ownership
and account creation must be one atomic operation. An abandoned first page cannot
reserve ownership indefinitely.

Acceptance: fresh install redirects to setup; unauthorized claim fails; concurrent
claim creates one admin; reload/restart resumes; initialized deployments cannot be
reclaimed; wrong bot token/model key is recoverable; secrets never appear in responses;
activation cannot bypass whitelist/skill prerequisites; failed activation remains
inactive; operator recovery does not require a working Telegram bot.
