# Local setup and Docker

The local pilot implementation includes the Telegram transport, Pi worker,
PostgreSQL persistence, and admin SPA. No accounts are connected by installation.
See [implementation status](implementation-status.md) for tested scope and launch gates.

## Start the local stack

Requires Docker Compose, Bun 1.3.14 and Node 24 for host development.

```sh
bun install --frozen-lockfile
bun install --cwd services/code-truth --frozen-lockfile
cp .env.example .env
mkdir -p secrets
openssl rand -hex 32 > secrets/encryption-key
```

Set `POSTGRES_PASSWORD` in `.env` to a unique URL-safe password. Keep `.env`,
`secrets/` and backups out of Git. Compose injects the encryption key as a runtime
secret. The database is private; the app listens on loopback only.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose exec app node dist/operator.js claim
```

Open `http://localhost:3000`. Paste the 15-minute claim token and create an admin
with a password of at least 12 characters. Concurrent claims cannot create two
initial admins. The claim token is printed only by the explicit host command.
There is no default password. Setup progress persists in PostgreSQL.

Create a workspace and confirm timezone, retention and budgets. Bot and model
credentials can be left pending for local work. They are write-only and encrypted
with AES-256-GCM; the database does not contain the runtime encryption key.

`GET /healthz` reports process liveness. `GET /readyz` also requires a recent
worker heartbeat. `/admin/*` deep links load the SPA; `/api/*` failures remain JSON.

## Local Telegram polling (no public URL)

Set these values in `.env` and restart **both** app and worker:

```dotenv
TELEGRAM_TRANSPORT=polling
PUBLIC_ORIGIN=http://localhost:3000
```

```sh
podman compose config --quiet
podman compose up --build -d
```

Docker Compose supports the same configuration. On SELinux/rootless Podman hosts,
ensure the container's Node user can read the encryption key and its label permits
container access; keep the containing `secrets/` directory private.

Save a workspace and bot token in Setup. Selecting polling explicitly opts the worker
into outbound Telegram requests using the saved bot credential, including before
activation so owner verification can work. Wait for **Polling: ready**, generate the
owner verification link, and open it with the intended Telegram account. Sign in again
after verification, finish model/skill settings, then activate. The model, whitelist,
tenant and approval requirements are identical in both modes. No webhook or tunnel is
needed. The setup page updates verification status automatically every five seconds in both transport modes.

Polling and webhook delivery cannot operate on the same bot at the same time. If the
bot already has a webhook, polling reports a conflict and makes no `deleteWebhook`
call. Stop its previous deployment and deliberately remove that webhook via Telegram's
`deleteWebhook` method with `drop_pending_updates=false` before switching. Stop any
other application polling the same token. Return to webhook mode by stopping the
polling worker, setting `TELEGRAM_TRANSPORT=webhook`, restarting app/worker, and explicitly
registering a public HTTPS webhook in Setup.

The worker serializes polling through a PostgreSQL session advisory lock. It persists
the next update offset only after the existing transactional ingress accepts the
update. Replayed updates are deduplicated; failed ingestion never advances the cursor.
Offsets are scoped to the bot and reset after seven days without received updates,
when Telegram may choose a new random update ID. Rate-limit delays persist across
workers/restarts. Shutdown cancels pending HTTP polling and releases the lock.
`/readyz` additionally checks recent polling success when a bot is configured. Setup
reports pending/failed reception without exposing tokens or message contents.

Worker `telegram_polling_failed` logs include a redacted `code` and
`retry_delay_ms`. `polling_webhook_conflict` means an existing webhook blocks polling;
`telegram_polling_conflict` indicates Telegram rejected concurrent polling;
`telegram_unauthorized` requires checking the saved bot token;
`telegram_rate_limited` honors Telegram's retry delay. `telegram_outcome_unknown`
means the HTTP request failed without a confirmed response, while
`polling_invalid_update` means update validation failed. `polling_receive_failed`
covers other local failures, including database or ingestion errors. Raw exceptions,
Telegram descriptions, tokens and message contents are excluded from these logs.
Check current Setup receiver status or `/readyz` alongside log timestamps: a later
successful poll clears the stored error, but historical failure logs remain.

Sources: [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates),
[PostgreSQL advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).

## Configure a staging bot deliberately

These actions contact Telegram. Webhook registration is never performed during
installation, image build, migration, automated tests or ordinary service startup.
Webhook remains the default transport; polling starts only when explicitly configured.

1. Configure an HTTPS reverse proxy and set `PUBLIC_ORIGIN` to its exact origin,
   without a trailing slash. Restart the app and worker after origin changes.
2. Enter a dedicated BotFather token in Setup. Save calls `getMe` and shows its identity.
3. Click **Register verification webhook**. This reconciles `getWebhookInfo` and
   `setWebhook` without dropping pending updates. Only verification/control interactions
   work until activation. Alternatively, explicitly run
   `REGISTER_STAGING_WEBHOOK=yes bun run register:webhook` with host configuration.
4. Generate the owner verification link and open it with the intended Telegram account.
   This atomically enrolls/whitelists the owner and links the local account. Existing
   sessions are revoked; sign in again.
5. Configure the OpenAI-compatible model base URL, API key, model ID and thinking
   level under **Setup & credentials**. The default base URL is
   `https://api.openai.com/v1`, model `gpt-4.1-mini`, and thinking `off`.
   Choose a suggested model or enter any custom ID. Set budgets and enabled skills.
6. Review settings and activate. Private-only activation is valid. Send `/start`,
   confirm `/timezone Asia/Taipei` (or your IANA zone), then use `/linktoken` privately
   to link a group in which you are also a Telegram administrator.

Telegram ID entry alone never proves identity. Extra panel accounts are created
under Operations; enroll their Telegram IDs in Members and issue a one-use identity
link from Operations. They have no deployment-operator privileges.

Group collection is off by default. Disable BotFather privacy where appropriate,
recheck visibility under Group access, and explicitly consent with `/capture on`
in the group or the panel. Collection covers received messages, including authors
outside the whitelist, and does not import old history.

## OpenAI-compatible model settings

The setup page has separate **Connect Telegram** and **Model configuration** cards.
Use **Save model configuration** to save the model before or after connecting Telegram;
**Save Telegram token** updates only the bot credential. The setup checklist marks
**Model saved** when a key is configured, and **Review & activate** shows the saved
base URL, model ID, thinking level and key status without displaying the key.

Only deployment operators can change these settings. The base URL includes the API
prefix (usually `/v1`); requests go to its `/chat/completions` endpoint using streaming
and bearer API-key authentication. HTTP and HTTPS endpoints are supported, including
local servers reachable from the worker. In Docker, `localhost` refers to the worker
container. URLs containing credentials, query strings or fragments are rejected.

The API key is encrypted and write-only. Leave its field blank to retain it; changing
an endpoint with an existing key requires entering the key for the new endpoint.
Saving does not contact the model server or validate its credentials/capabilities.

Thinking choices are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
Non-off choices are sent as OpenAI-style `reasoning_effort`; choose a level supported
by your server/model. `off` omits this parameter and leaves the server's default in
effect; it cannot disable reasoning that a model always performs. The server must
support streaming Chat Completions, tool calling, `max_completion_tokens`, and
`store:false`. Provider-specific thinking formats are not configured by this form.

Known OpenAI IDs use Pi's bundled price metadata unless you supply a price override.
Custom IDs require input/output USD prices per million tokens for budget estimates;
use explicit zeros for a free local model. Overrides also price cached input at the
input rate and persist until replaced. Review both prices when changing models or
providers; recorded costs are estimates, not an upstream billing guarantee.

The worker pins model capacity, endpoint, thinking level and prices at the first execution of a run.
Later thinking/price edits apply to future runs. If an endpoint changes, unfinished
runs pinned to the old endpoint stop before another model dispatch. Existing saved
configurations without these fields use the default URL and thinking `off`.

See [the API example](../../examples/model-settings.http) and
[Pi's custom-model documentation](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md).

## Model capacity and workspace budgets

Known model IDs use the bundled Pi catalog for context window and maximum output.
The catalog is versioned package data, not a live provider discovery request. Proxies
may differ: operators can override both values in **Model configuration** using their
provider's documented token limits. Unknown custom IDs require both values; the app
no longer invents 128K/16K capabilities. Existing custom configurations need these
values before the next run. Saving Telegram credentials remains available meanwhile.
Set `modelLimits: null` to return to catalog values. Omitted overrides persist for the
same model/endpoint; changing either clears them unless explicitly supplied again.
Model limits are pinned at first execution, alongside endpoint, thinking and pricing.

Workspace settings show model capacity and its source. Response language follows the
model; there is no workspace language override. Input byte and output token budgets
are managed automatically, with no workspace controls or hidden saved overrides.
The API discards the retired `language`, `maxInputChars` and `maxOutputTokens` keys
from older clients; migration `010_automatic_response_settings.sql` removes them from
current workspace settings while retaining historical run snapshots.

Before each model call, serialized UTF-8 input bytes provide a conservative token
estimate. Output allowance is the minimum of model maximum output, remaining context
capacity, and what the remaining USD budgets can reserve. This is not an exact
provider tokenizer count. Tool definitions, history and tool results all count.
The worker never silently summarizes context or translates the model's response.
Bounded evaluation scripts can still supply internal input/output caps.

USD run/month budgets accept finite non-negative amounts without the old $5/$1,000
ceilings. Both budgets are checked transactionally before each dispatch; unknown
charges remain reserved. Zero permits only zero-cost requests. Calls per run accept
integers from 1 to 20 (default 3); the run deadline and eight-tool-call limit remain
operational bounds. Set `RUN_TIMEOUT_SECONDS` in `.env` (default 300, range 1–1800)
and redeploy to change the total wall-time allowance per execution. Reasoning
models can need more than the previous 90 seconds. Queue expiry is set 60 seconds
beyond this limit. Existing queued jobs retain their original queue expiry; let
pending work drain before increasing the deadline. Timeouts report `run_timeout`;
shutdown reports `worker_shutdown`, while explicit user cancellation remains
`cancelled`. An interrupted request with unconfirmed usage keeps its reservation
until billing reconciliation; raising the deadline does not retry old failures. Concurrent reservations can still exhaust the remaining
budget between estimating output and reserving it; the final transaction prevents
overspend before dispatch.

The form reports individual invalid fields; API validation includes safe `issues`
with field paths and messages, never submitted values. Runtime logs preserve
`input_budget_exceeded`, `model_output_limit_exceeded`, `model_context_limit_exceeded`
and `model_limits_required`. Changes apply to new runs; failed runs are not retried
automatically. Large outputs still use the existing Telegram reply truncation; this
change does not introduce long-message delivery or remove the response-length prompt.

## Admin creation dialogs

Use the Add/Create icons to open creation dialogs for workspaces, members,
workflows, skills/imports, instructions, run requests, panel accounts, plugins,
repositories/networks and GitHub Apps. Save/submit completes the existing action;
Cancel or Escape discards that dialog's draft. Errors leave the dialog open for
correction. Related edit controls open the same editor. Existing settings and
access-policy forms remain on their pages.

For Code Truth, **Add repository** opens repository and branch fields. **Add network**
opens a nested dialog; cancelling it preserves the repository draft. Choose
**Apply repository**, then **Save Code Truth** to persist all configuration changes.
GitHub App creation opens its owner/name dialog before continuing to GitHub.

## Development and checks

```sh
bun run check
bun run typecheck
bun test
bun run build
bun run test:runtime
```

For host processes set `DATABASE_URL`, `PUBLIC_ORIGIN`, and `ENCRYPTION_KEY` (64 hex
characters) or `ENCRYPTION_KEY_FILE`. Then run `bun run migrate`, `bun run dev` and
`bun run worker` separately. `dev` runs TypeScript under Node; build produces the
Node entry points plus the browser bundle. Node does not load `.env` automatically.

Integration tests create and drop uniquely named disposable databases; the test
PostgreSQL user needs `CREATEDB`. They never operate on the application database.

```sh
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres bun test
bunx playwright install chromium
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres bun run test:browser
```

Without `TEST_DATABASE_URL`, PostgreSQL tests explicitly skip. CI supplies a real
PostgreSQL service. Browser fixtures and fake transports exist only in `tests/`;
they are excluded from the Docker image. If your host configures an HTTP proxy,
set `NO_PROXY=localhost,127.0.0.1` for tests (including the local model HTTP fixture).

The skill **Test draft policy** control is a deterministic validation/preview,
not a claim that a live model obeyed the skill. The Pi fake-provider tests exercise
actual validated tool execution, pause/continuation boundaries and cancellation.

## Optional paid model evaluation

No default check spends money. After explicitly choosing a spend cap, configure
`OPENAI_API_KEY` and run:

```sh
ALLOW_PAID_EVALUATION=yes EVALUATION_CAP_USD=0.02 bun run evaluate
```

`EVALUATION_MODEL` overrides the provisional model. The command limits output,
reserves estimated cost before dispatch, disables provider retries, reports usage,
and caps the configured spend limit at $0.10. Review grounding, prompt-injection
resistance and actual billing before selecting a pilot model. This evaluation has
not been run with live credentials in repository implementation checks.

## Stop and recover

```sh
docker compose down
# Retains PostgreSQL volume. Do not add -v for useful data.
```

For password recovery, create a protected file readable inside the app container,
then run `node dist/operator.js recover USERNAME PASSWORD_FILE` there. It updates an
existing operator and revokes their sessions; public bootstrap never reopens.

Use [the release runbook](release-runbook.md) for backups, restore, unknown outcomes,
key rotation and staging release checks.

## Runtime logs

Open **Deployment → Runtime logs** at `/admin/logs` (deployment operators only).
Filter by severity or service, search event/error codes or run IDs, load older entries,
and toggle five-second auto-refresh. Older pages pause auto-refresh to preserve your
place. The panel stores new structured API/worker/polling/run/delivery events; it does
not import earlier container output. Workspace run metadata is shown only to its
operator and disappears from the panel after workspace deletion.

Messages and error codes come from an explicit catalog. Secrets, request URLs/bodies,
raw exceptions, model prompts/results and Telegram message contents are never captured.
The worker prunes records older than seven days and keeps the latest 10,000 entries
once per minute. Writes are buffered and best-effort; storage failures never fail a
bot request. Container output remains available for startup/database failures:

```sh
podman compose logs --tail=100 -f app worker
# Docker equivalent:
docker compose logs --tail=100 -f app worker
```

The existing workspace **Audit** page records configuration and approval actions;
**Runtime logs** explains service activity and failures. See
[the log API example](../../examples/runtime-logs.http).

## LLM plugins (Pi extensions)

Open **Workspace → Plugins** as a deployment operator. Register reviewed Pi extension
files already installed on the server, choose their exact tool names, then enable
and save for the selected workspace. The page supports editing versions, disabling,
removing registrations, file status, search and recent change history. Settings persist
independently per workspace in PostgreSQL and apply to new worker runs without a restart. Older in-flight settings
are rejected at the next guard. Conflicting edits require reloading the saved revision.

Start with [the word-count extension](../../examples/pi-extension.ts). On a host,
enter its absolute local path. In containers, mount an `extensions/` directory at the
same path in the API and worker. The [Compose override](../../examples/extensions.compose.yaml)
provides read-only mounts at `/app/extensions`; its optional fallback manifest should
be `extensions/extensions.json` (use `[]` if configuring entirely through the panel):

```sh
docker compose -f compose.yaml -f examples/extensions.compose.yaml config --quiet
docker compose -f compose.yaml -f examples/extensions.compose.yaml up --build -d
```

Use the same Compose file arguments for subsequent lifecycle commands. In the panel,
register `/app/extensions/pi-extension.ts`, tool `count_words`, and
an explicit version. New entries default to disabled. Registering/removing a plugin
never creates, changes or deletes its executable file. There is no web package installer.
Only reviewed read-only code is supported; files run in-process with worker permissions.

Existing `PI_EXTENSIONS_FILE` grants remain a fallback until that workspace’s
first panel save. Set it consistently for the API and worker if using a manifest.
An empty saved panel registry deliberately disables all file plugins for that workspace
and does not reactivate the fallback. Other workspaces’ settings and revisions are independent.

“File verified” checks the API's view of the file, not runtime compatibility or the
worker mount. After reviewing changed code, update its plugin version and save to
pin the new contents. Unrelated edits preserve existing hashes. Restart workers after
upgrading imported dependencies. See [compatibility and policy](../design/llm-extensions.md)
and [the API example](../../examples/plugins.http). No setup step invokes Telegram
or a paid model.

### Predefined Code Truth

For local source-code queries, follow [Code Truth setup](code-truth.md). This optional private service has its own dependency installation and persistent index volume. Repository and branch settings for the selected workspace are managed in **Workspace → Plugins → Code Truth**.

Plugin settings previously stored per operator are copied into independent workspace
registries by migration `006_workspace_plugins.sql`; existing workspace grants and
file hashes are preserved. Run migrations before starting the updated API and worker.

## Approve requests for bot access

After applying migration `009_access_requests.sql`, unauthorized users can press
**Request access** in Telegram. In **Workspace → Members & access → Access requests**, review
the Telegram ID/name and choose **Approve access** or **Reject request**. Approval
adds a regular member, allows their ID and queues a Telegram confirmation. They can
then send a new bot request; their original message is not automatically executed.

Share the request-access link shown in that section when your bot serves multiple
workspaces. It opens the correct workspace's request flow without granting access.
Reopen the page to load new requests. A Reload access requests action appears
after a failed request or conflicting edit. See
[access-control behavior and limits](../design/access-control.md#telegram-access-requests-implemented-2026-09-20)
and [the API example](../../examples/access-requests.http).

## Rich replies and native Stop (Bot API 10.3)

Updated app/worker code sends model answers as rich messages, with native private
streaming and Stop. No dependency or database migration is needed. Restart both
processes together. For webhook deployments, explicitly use **Register verification
webhook** in Setup after updating to add `stopped_message_generation` to the existing
subscription; ordinary startup does not register it. Polling uses the updated allowed
updates automatically after worker restart. Old previews without a stored draft/run
binding cannot be stopped through the native event; `/cancel` remains available.

See the [manual staging check](../../examples/telegram-streaming.md). No live Telegram
request is part of build/test or this implementation change.

## Optional Codex feature and bug implementation

Configure repository development branches and Telegram maintainers under
**Plugins → Codex implementation**. Each target repository needs the supplied
GitHub Actions workflow, an OpenAI secret, trusted check commands and updated App
permissions. Follow [the complete setup](codex-coding.md); installing the bot does
not install or dispatch remote workflows.
