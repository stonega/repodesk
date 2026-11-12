# Release deployment on a custom VPS

RepoDesk now installs approved GitHub releases through a host-side updater.
The previous `.github/workflows/deploy.yml` is removed. GitHub Actions verifies
code; the standard release workflow does not transfer images or deploy to the VPS.
Explicit operator-authorized exceptions are recorded below. Publishing a stable
release makes it available in the panel's version indicator. A deployment
administrator reviews its notes and starts installation explicitly.
See [host updater installation](updates.md) for the service and panel contract.

## Scoped repository schedule fix deployed (2026-11-12)

Operator-authorized bundle `1794469596569-79773357` deploys source
`b6ab2b9531bd3ea9a30e2c5eab9cabc0a5b46a1b` over `1794386364054-96360541`.
It applies main fix `64113d3a962dd6347a0e111e147cffd44e29e1f9` to the preserved
production source `41b179b93d88411437aab6c39cdb86dc45341c62`. The exact source is
retained on `deploy/scoped-workflow-repositories-20261112` and in the protected
host archive. Unrelated repository changes no longer invalidate a scheduled
report's unchanged sources or cancel its queued output. Confirmed revocation,
connection generations, selected-repository tombstones and current authorization
remain enforced; suspension diagnostics retain safe tenant/run context.

The main source passed **1,500 tests across 159 files**; the production source
passed **1,503 tests across 160 files**, with Bun 1.3.14. Lint, strict types,
builds and the Node runtime contract pass. The exact VPS images pass all 16
integration-startup cases with zero external startup calls, CPU transcription
imports, offline Code Truth, Compose configuration/readiness, migration rerun
and disposable backup/restore. All five production services are healthy.
All **55 deployed artifacts**, public/loopback health/readiness and declared
frontend assets verify. Previously audited unused CDN aliases remain separately
recorded; current HTML asset URLs match the verified image.

Configuration, credentials, persistent mounts, PostgreSQL identity and the native
Browser installation are preserved. Its **813 files** and app/worker headed bridge
checks pass. The verified protected backup is
`backups/pre-release-1794469596569-79773357.dump` (**533,250 bytes**). Source,
quality records, immutable image identities and the deployment receipt remain
under the release directory. Package version remains v0.1.46; no dependency,
SQL migration or stable release was added.

After a read-only recovery dry run, an audited Store transaction rechecked the
specific Wallshader schedule's current membership, repository scope, destination
and skill availability through the production lifecycle service. The owning
deployment operator paused/resumed that record and cleared its historical reason.
It is **active**, still version 1, next due **2026-11-13T00:00:00Z**
(08:00 Asia/Taipei). Its original repository pin remains valid under the corrected
scoped check. Historical runs/deliveries and occurrence records are unchanged;
today's cancelled run was not replayed. No manual Telegram send or live model
call was performed. See [the incident record](../../postmortem/2026-11-12-workflow-global-repository-revision.md).

## Missing token prices count as zero, deployed (2026-11-11)

Bundle `1794367751621-08425833` deploys source
`af5171554df3488563af403f47f58d21e30f3986`, tree
`6569737174ea5df2cb268bca0a10f99a4eb564d9`, over
`1794305442311-77002991`. Missing model token prices now count as zero in
reservations, settlement, remaining budgets and usage displays. Finite and
zero-dollar budgets allow these calls. Available rates and reconciled charges
continue to count independently.

The isolated release passed lint, strict types, build, the Node runtime contract,
**1,482 deterministic tests across 158 files**, and two desktop/mobile browser
scenarios. The VPS builds with pinned Bun 1.3.14; its build image also passed all
50 focused pricing, budget and summary unit tests. Exact-image startup, CPU speech,
offline Code Truth, Compose configuration/readiness, migration rerun and disposable
backup/restore passed. All **55 deployed artifacts** match the verified images;
public and loopback HTML/assets verify. Public health/readiness return HTTP 200,
and all five services are healthy.

The protected backup is `backups/pre-release-1794367751621-08425833.dump`
(**165,882 bytes**), with its archive listing verified. Source archives, quality
logs, image IDs and `deployment-receipt.json` remain in the protected release
directory. No dependency, SQL migration or stable GitHub release was added.

## Conversational Telegram controls deployed (2026-11-11)

Operator-authorized bundle `1794386364054-96360541` deploys source
`41b179b93d88411437aab6c39cdb86dc45341c62` over `1794371404708-33447708`, preserving
existing production fixes. The feature commit `bf644bb978827ed20066f6581d0c1a133eee11fd` is on
`main`; the exact production source is retained on
`deploy/telegram-chat-controls-20261111`.

The bot no longer advertises slash-command menus. Ordinary chat requests reach
repository selection, account connections, task controls, workflow management,
instructions, settings, usage and privacy through the existing authorized services.
Read-only Telegram API verification after cutover confirms empty lists for the
**default**, **all private chats** and **all group chats** scopes. The previous
lists contained five, seven and five entries respectively. No manual user message
or live model request was used. Native client appearance and real-model phrasing
remain live acceptance checks.

The isolated main tree passed **1,454 tests**; the preserved production source
passed **1,496 tests across 159 files**.
Biome, strict types, build, the Node runtime contract and pinned-Bun control checks
pass. One pre-existing Browser expiration assertion failed during the first
concurrent suite; its isolated retry and final full rerun both pass. Exact VPS
images pass 16 integration-startup cases with zero external startup calls, CPU
speech imports, offline Code Truth, Compose readiness/configuration, migration
rerun and disposable backup/restore.

All five services are healthy; public/loopback health, readiness and frontend
artifacts verify. **55 deployed artifacts** match the
verified images. The existing unused bare JavaScript cache alias remains separately
audited; current HTML asset URLs match. Configuration, credentials, persistent
mounts, PostgreSQL identity and the native Browser installation are preserved.
The protected backup `backups/pre-release-1794386364054-96360541.dump` is
**231,489 bytes** and its archive listing verifies. Source,
image identities, checks, menu results and the deployment receipt remain under the
protected release directory. No dependency, migration or stable release was added.

## Immediate schedules and workflow owners deployed (2026-11-11)

The operator-authorized release `1794371404708-33447708` deploys source
`d1ee70db29d5114764f9027796f03a28f79417d0` over `1794367751621-08425833`. It incorporates
main commits `776d96c` and `dffb66b`, retaining the existing production fixes.
Explicit Telegram requests now activate schedules immediately and receive one
application-owned confirmation. Cards/details show the owner's saved Telegram
name, username and ID. Panel saves apply directly and preserve paused state.
Legacy repeated controls report their saved outcome; interrupted activation does
not replay creation or report a false failure.

The production-based source passed **1,487 deterministic tests across 158 files**,
**29 admin/workflow browser scenarios**, lint, strict types, build and the local
Node runtime contract. The pinned Bun 1.3.14 build image passed all **40 focused
workflow, agent and diagnostic tests**. Exact-image startup passed 16 integration
cases with zero external startup calls. CPU speech imports, offline Code Truth,
Compose readiness/configuration, migration rerun and disposable backup/restore
also passed. A stale browser expectation for Add workflow was corrected before
cutover; the passing final evidence is retained with the initial check logs.

All **55 deployed artifacts** and the public/loopback HTML
and frontend assets match the verified images. Public health and readiness return
HTTP 200. All five stack services are healthy. The HTML's versioned JavaScript
URL matches the release. Cloudflare retains the previous file at the unused bare
`/assets/app.js` alias; its cache headers and prior-release hash are audited
separately in the receipt. No CDN configuration was changed. The native Browser package's
**813 files** remain unchanged, and headed
bridge checks pass from app and worker. Configuration, credentials, persistent
mounts and PostgreSQL identity are preserved.

The protected backup `backups/pre-release-1794371404708-33447708.dump` is **197,234 bytes** and
its archive listing verifies. Source archives, quality logs, image IDs and
`deployment-receipt.json` remain under the protected release directory. Package
version remains v0.1.46; no dependency or SQL migration was added. No manual
Telegram message, live model inference or replay of historical requests was used.

## Standard text recovery deployed (2026-11-10)

Bundle `1794305442311-77002991` deploys source
`ac7abf189f0599bcdeda8ce6bd3c2e548d999dde` over
`1794301988625-49496411`. The user confirmed a plain main-chat diagnostic visible.
Opted-in recovery now persists standard `sendMessage` text delivery before sending,
including rich fallback intents queued by the previous worker. Links and text
entities are preserved. This is a conservative transport choice, not an established
rich-format root cause or a repair of Telegram's native Topic outage.

All **1,479 tests across 158 files**, lint, strict types, build and the local offline
runtime contract pass. Exact-image startup, CPU speech, Code Truth, Compose
readiness/configuration, migration rerun and backup/restore checks pass. All 55
running artifacts and public/loopback assets verify. The backup is
`backups/pre-release-1794305442311-77002991.dump` (125,821 bytes). Configuration,
credentials, model/budget choices and persistent volumes are preserved.

A previously confirmed-failed saved answer was retried through the production
DeliveryWorker. Its original Topic returned HTTP 400; the standard-text main-chat
send returned HTTP 200 and a confirmed remote ID. The receipt records markdown
text delivery, logical Topic `1997139` and actual `deliveredTopicId: 0`. Model
attempts are unchanged. User visibility confirmation of this recovered answer is
pending; the separate plain diagnostic was confirmed visible. No sent or unknown
answer was reset or automatically replayed.

## Private Topic recovery deployed and delivered (2026-11-10)

Bundle `1794301988625-49496411` deploys source
`8b518732ec0a5d21ca7cf97705c2a6dd85f4d005` over
`1794297677476-38110726`. After the user explicitly requested the main-chat
workaround, an audited opt-in was enabled for the sole verified active member and
current bot. The saved successful answer was retried through the production
DeliveryWorker: its original Topic returned HTTP 400, and the same intent's
main-private-chat attempt returned HTTP 200 with a confirmed remote message ID.
The receipt is `sent`, preserves logical Topic `1997120`, records
`deliveredTopicId: 0`, and retains one model attempt; the model was not rerun.
The original Telegram Topic remains unavailable. This does not recover input
Telegram never delivered. Future ordinary replies can use the scoped fallback;
groups, controls and uncertain sends remain excluded.

All **1,478 tests across 158 files**, lint, strict TypeScript, build and the local
runtime contract pass. Exact-image checks include the 16-case offline startup
contract with zero external startup calls, CPU speech imports, Code Truth smoke,
Compose validation/readiness, migration rerun and backup/restore. All 55 deployed
artifacts and public/loopback assets verify. All five services are healthy;
configuration, credentials, persistent mounts and native Browser state are
preserved. The protected pre-cutover dump is
`backups/pre-release-1794301988625-49496411.dump` (122,561 bytes).
Release and recovery receipts remain in the protected release directory. No
frontend interaction was changed; the existing run details expose the additional
receipt metadata. The divergent original development branch and index were not
changed by the isolated release commit.

## Browser chat repair deployment (2026-11-02)

The authorized repair promoted release `41406054824-1` from source
`895d0e6925be87d49e300815783bcfdefb1c516b`, replacing `41403209516-1`.
It retains the existing deployment's audio and Code Truth behavior. The preceding
cookie/readiness repair alone did not fix the reported YouTube redirect; the final
release adds the confirmed proxy-consent correction. Package version remains
v0.1.46; no dependency, migration or stable GitHub release was added.

The source snapshot passes **1,380 deterministic tests across 151 files**. The
isolated `main` repair passes **1,383 tests across 150 files**, lint, strict types,
build and the Node 24 startup contract. The real headed fixture covers partitioned
cookies and an HTTP-to-HTTPS redirect denied without a website grant. Exact VPS
images pass all 16 startup cases with zero external calls, disposable Compose
readiness, migration rerun, backup/restore, speech imports, Code Truth real-index
smoke and the native Codex dynamic-tool proof.

The receipt at **07:30:46 UTC** verifies **51 artifacts**, public/loopback HTML and
assets, healthy services, saved configuration/credentials and persistent mounts.
The native host passes application-UID routine actions, blocked submission,
partitioned-cookie checkpoint and denied HTTPS redirect tests. Its socket directory
survives restart, and both existing API/worker mounts reconnect. PostgreSQL and all
three CI runner identities are preserved. The verified protected backup is
`/opt/repodesk/backups/pre-release-41406054824-1.dump` (**2,303,262 bytes**).

The original public YouTube URL now reports the missing
`https://consent.youtube.com` origin and preserves its headed session. An explicit
grant in an isolated synthetic profile then allows navigation and reading. That
probe does not grant websites or decide cookie preferences for the real member.
A current-authority Code Truth probe reads `stonega/street-polls` source at
`3a7cbe02e46b5a8b5329066b52d2953f64492309`; only provenance and byte counts are logged.
No live account login, Telegram message or model call was used.

See the [deployment and receipt](https://github.com/stonega/repodesk/actions/runs/41406054824),
[public redirect proof](https://github.com/stonega/repodesk/actions/runs/41406866977),
[current-scope source proof](https://github.com/stonega/repodesk/actions/runs/41404066398)
and [incident record](../../postmortem/2026-11-02-browser-partitioned-cookie.md).

## Private-message input correction and live blockers (2026-11-10)

Bundle `1794297677476-38110726` deploys source `80946f23a8133930cf3468b255f31df760d5c3cf`
over `1794293889220-29767507`. It adds bounded normalization of incoming Telegram
rich-message text and production-composition regression coverage. All 1,466 tests,
lint, strict types, build, the 16-case offline startup contract, Code Truth smoke,
disposable Compose readiness, migration rerun and backup/restore checks pass.
All 55 deployed application/supervisor/task artifacts and public/loopback assets
verify. All five containers and native services remain healthy. Configuration,
credentials, memberships and persistent volumes are preserved. The protected
pre-cutover dump is `backups/pre-release-1794297677476-38110726.dump` (115,569 bytes).

Live private input creates a run, but native chat is **not restored**. Initially,
unknown model prices and the saved per-request dollar budget stopped execution
with `model_pricing_required_for_budget`; the pricing endpoint returns HTTP 401.
The operator explicitly chose to remove that budget, and the audited update
preserves all other settings. Telegram still rejects the original Topic's error
reply with `message thread not found`, consistent with the upstream private-topic
issue. Replies are not silently rerouted outside their Topic. See the
[incident and live evidence](../../postmortem/2026-11-10-telegram-rich-input.md).

## Telegram widgets and merged application features deployed (2026-11-10)

The operator-authorized cutover deployed bundle `1794293889220-29767507` to
`13.140.242.169`, retaining `https://dev.stonegate.me` and package v0.1.46.
Source snapshot `2b05a41e3e65ff11ddf04ebd5fce495468182b7e`, tree
`40d1da4e05875b6f4c3c006590def7e5ee804fa8`, applies the merged GitHub coding
follow-up, Telegram widget and bot-token guidance commits (`a297667`, `c2a55f7`
and `f7b8272`) to the previous production source `44a76df`. The existing Browser,
worker, audio and provider fixes remain present. The divergent development
working tree was not deployed; its branch and index remain unchanged.

Lint, strict TypeScript, build, the local Node runtime contract and **1,458
deterministic tests across 156 files** pass. All **30 focused browser scenarios**
pass for administration, first-run/token recovery, presets and widgets. The exact
production app image passes all 16 startup cases with zero external startup
calls. CPU speech imports, the offline Code Truth real-index/MCP smoke, Codex CLI
checks, disposable Compose readiness, migration rerun and backup/restore pass.

The app, supervisor and task images overlay the source-built artifacts on their
previous production runtime images. Their filesystem layer prefixes and runtime
configuration match the previous images. No dependency, SQL migration or native
Browser update was added. All **55 application/supervisor/task artifacts** match
the verified images. Public and loopback health, readiness, admin, Mini App and
packaged frontend assets verify, including served asset hashes. An independent
workstation check also returns public health `ok` and readiness `ready`.

Both coding and Browser checkpoint checks pass. The protected pre-cutover backup
is `backups/pre-release-1794293889220-29767507.dump` (**111,117 bytes**), with its
archive listing verified. All five application-stack containers are healthy;
configuration, credentials, persistent mounts and the PostgreSQL container are
preserved. The unchanged native Browser package verifies all 813 files, and
synthetic headed Browser checks pass from both running app and worker containers.

Preparation failures and corrected checks remain in the protected bundle. An
initial image overlay used an unsupported image-ID reference in `FROM`; the
corrected build uses verified local tags and confirms the inherited layer and
configuration identities. The first cutover preflight also incorrectly required
a Browser token for the migration service. It stopped before changing running
services; the corrected check permits that intentionally absent optional setting.
The same verified final images then completed cutover. Source archives, quality
logs and `deployment-receipt.json` remain under the release directory. No stable
GitHub release, account connection, webhook registration, live model call or
manual Telegram message was performed. Native Telegram widget rendering and
real-model widget quality remain staging checks.

## Operator-requested clean reset (2026-11-10)

The operator requested removal of deployment data on `13.140.242.169`. The
`repodesk` stack was stopped and all five project volumes were removed and
recreated: PostgreSQL, coding-runner state, Code Truth authentication/indexes and
speech model storage. Saved Browser profiles and their generated system accounts,
Browser runtime journals, update history, the prior database backup and
`/root/repodesk-admin-login` were removed. Database, encryption, coding-runner and
Browser secrets were regenerated. No data backup was retained for this reset.
SSH access, installed software, the verified release images and HTTPS certificates
were preserved. No other VPS was changed.

The unchanged v0.1.46 source snapshot `44a76df` remains deployed. All five
containers are healthy; Browser, updater and Caddy are active. The exact app image
again passes its 16-case runtime contract with zero external startup calls, and
Code Truth's offline real-index/MCP smoke passes. Migrations initialize the new
database with **zero administrators, workspaces and sessions**, 22 migrations and
`claimed=false`. Bot/model credentials and provider configuration are empty.
The backup directory and Browser profiles are empty. Verification is recorded in
the protected release's `clean-reset-receipt.json`; it supersedes the initial
installation receipt and its now-deleted administrator/backup references.

An SSH-only proxy gate was initially added during the reset. The operator
clarified that first-open administrator creation belongs in the web UI, so that
gate and `/opt/repodesk/publish-after-setup` were removed on the same day.
`PUBLIC_ORIGIN=https://dev.stonegate.me` and Caddy's normal reverse proxy were
restored, and app/worker were recreated with the configured public origin.

Open `https://dev.stonegate.me/` to reach `/setup` and choose the first
administrator's username and password directly in the web UI. This follows the
[first-run design](../design/first-run-setup.md#entry-and-ownership). No generated
administrator, SSH tunnel or publication command is required. Public HTTPS
health/readiness, setup and setup-status endpoints return HTTP 200. The focused
first-visit browser journey passes against a disposable database, and its
administrator form was inspected at 1280px and 390px. A live browser check through
the local network forwarding did not complete; public HTTPS responses were
verified independently. Lint and documentation whitespace checks pass.
No webhook, account connection, model call or Telegram send was performed during
this reset.

## Fresh installation on the Seattle VPS (2026-11-09)

At the operator's request, RepoDesk was installed fresh on `13.140.242.169`
(Ubuntu 24.04, x86_64). No database, credentials, accounts or profiles were
migrated from the previous VPS. SSH permits public-key authentication only.

The checksum-verified production source snapshot `44a76df8e8f6ee54a42bf7a83b1d9eaddbc586e1`
(package v0.1.46, bundle `1794210552528-53347667`) was built on the new host.
The existing development working tree was not deployed. App, supervisor, task,
Code Truth and native Browser packages were built from that snapshot. New database
credentials, encryption key, runner token and Browser token remain protected on
the host under `/opt/repodesk` and `/etc/repodesk`.

Lint, strict types, build and **1,432 deterministic tests across 154 files** pass.
The exact app image passes all 16 integration-startup cases with zero external
startup calls. CPU speech imports, offline Code Truth real-index/MCP checks and
the supervisor/task CLI checks pass. The real headed Browser smoke and private
app/worker-to-host Browser checks pass. Its initial test invocation used the
root-only release directory, preventing the unprivileged worker from reading
its package; rerunning from the installed, correctly readable package passed.
The failed fixture log is retained. No application correction was necessary.

Merged Compose configuration and secret access validate. App, worker, PostgreSQL,
Code Truth and the coding runner are healthy; Browser, updater and Caddy systemd
services are active and enabled. App, worker and supervisor each match all 25
built files, the task artifact matches its build, and all 813 native Browser
package files verify. Only the app's loopback port is published by Compose.

The fresh database contains 22 migrations, one deployment administrator and no
workspaces. Administrator login/logout and unauthenticated access checks pass;
the generated login is stored in root-only `/root/repodesk-admin-login` (mode 600).
Migration rerun and a disposable restore of
`backups/fresh-install-1794210552528-53347667.dump` (**91,902 bytes**) pass.
The protected bundle contains build/check logs and `deployment-receipt.json`.
Use `/opt/repodesk/compose` for operations against its pinned release images.

`PUBLIC_ORIGIN` and Caddy target `https://dev.stonegate.me`. **Public DNS cutover
and HTTPS verification remain pending:** the available DNS credential cannot
access the `stonegate.me` zone, and browser access is unavailable. Update the
hostname's A record to `13.140.242.169`, then verify certificate issuance, public
health/readiness and served assets before reporting public availability.
Loopback health/readiness, admin, Mini App and packaged frontend assets verify.
No account connection, webhook registration, live model inference or Telegram
message was performed.

## Provider error dialog deployment (2026-11-09)

The operator-authorized cutover deployed bundle `1794210552528-53347667`, replacing
`41965848447-1` (package v0.1.46). Source snapshot
`44a76df8e8f6ee54a42bf7a83b1d9eaddbc586e1`, tree
`e357402f6ad9927b02d0dd44eef76fe92d7aa6b4`, applies provider-error commit
`df2126e` to the previous production source
`726a45ab26885f17bd0236c967a87461f820f0f3`. Existing production fixes remain present.
Provider saves show readable model-fetch errors and recovery guidance for HTML
502/503/504 responses, retain drafts, and keep API-key rejection distinct.

The verified build artifacts were overlaid on the existing app, supervisor and
task runtime images. Root filesystem layer prefixes and runtime configuration
match their prior images, preserving installed Node, Pi, Codex and CPU speech
dependencies. No dependency, migration, native Browser update or stable release
was added. Code Truth's source/image and the installed Browser package are unchanged.

Local verification passed lint, strict types, build, the Node runtime contract,
**1,432 deterministic tests across 154 files** and **35 provider/session browser
scenarios**. Exact-image startup passed all 16 plugin cases with zero external
calls, CPU speech imports, offline Code Truth, native Codex dynamic tools,
disposable Compose readiness, migration rerun and backup/restore checks.

Both Browser/Codex checkpoint checks passed before cutover. The protected backup
is `backups/pre-release-1794210552528-53347667.dump` (**3,207,499 bytes**), with
its archive listing verified. All **51 application/supervisor/task artifacts**
and public/loopback pages and frontend assets match the verified build. App,
worker, supervisor and Code Truth are healthy. Configuration, credentials,
persistent mounts, PostgreSQL and the three Actions runners are preserved.
Synthetic headed Browser checks passed from both running app and worker containers.

An initial offline Codex proof stopped before cutover because its copied fixture
was not readable by the container's node user. The fixture was made readable and
the exact check passed before resuming with the same verified images. The initial
failure and corrected verification logs remain in the protected bundle alongside
source archives, checksums and `deployment-receipt.json`. No live model inference,
account connection or manual Telegram message was performed.

## Browser website consent retry correction (2026-11-02)

The authorized cutover deployed release `1793614570991-61029298`, replacing
`1793607782072-26985359`. Source snapshot
`c0ef7f8e6eef34675b0c234f2dfeb4f45b5eb4d6` applies the runtime fix and regression
from main commit `3a4d5aaa19c578364eae56bdeb9dd743e9a04e38` to the previous
production source `14d28d05e60b91a646f061c0062803466791fae3`. Its tree is
`ffb31b3b1d457cff09428bacf257f320e6bdcd52`. An interrupted navigation no longer
requests another website approval for an already allowed origin. The original
uncertain operation receipt remains protected against replay.

The snapshot passes lint, strict types, build, the Node runtime contract and all
**1,388 deterministic tests across 152 files**. Exact VPS images pass all 16
startup cases with zero external calls, CPU speech imports, offline Code Truth,
Compose readiness, migration rerun and disposable backup/restore. All **51 build
artifacts**, public/loopback pages and frontend assets match the verified images.

Browser and coding checkpoints passed before cutover. The protected backup is
`/opt/repodesk/backups/pre-release-1793614570991-61029298.dump`
(**2,870,142 bytes**), with its archive listing verified. Application, worker,
runner, Code Truth and PostgreSQL are healthy. Configuration, credentials,
persistent mounts, PostgreSQL and the three Actions runners are preserved.

The native Browser package remains unchanged; all 813 packaged files match.
Synthetic checks from both running app and worker containers confirm headed
Browser access as UID 1000, private profiles, plugin-revision fencing and cleanup.
No external website, live account, model or manual Telegram message was used.
Historical runs and member website decisions were not rewritten. Source archives,
checksums, verification logs and `deployment-receipt.json` remain in the protected
release directory. No dependency, migration or stable GitHub release was added;
the original working tree and local main history were preserved.

## Ordinary assistant execution deadline removal (2026-11-02)

The operator-authorized cutover deployed source commit
`14d28d05e60b91a646f061c0062803466791fae3`, tree
`acc0b5cef7f12b8647acf05eafa6a4103a87376e`, in bundle
`1793607782072-26985359` (package v0.1.46), replacing `41406054824-1`.
The isolated snapshot starts from the previous production source
`895d0e6925be87d49e300815783bcfdefb1c516b` and adds only the ordinary
assistant deadline correction. Existing Browser fixes remain deployed. No
dependency, SQL migration, native Browser update or stable release was added.

Ordinary assistant runs no longer have a total execution deadline. Queue wakeups
are acknowledged before execution, while fenced leases, current authorization,
cancellation, budgets and three local execution slots remain. The new worker
ignores legacy `RUN_TIMEOUT_SECONDS` environment values. The incident run retains
its historical failed status and seven attempts; deployment did not replay it.

The exact source passed lint, strict types, build, the Node runtime contract and
**1,354 tests across 147 files** with disposable PostgreSQL. App, supervisor and
task images were built on the VPS; the unchanged Code Truth image was reused.
Exact-image runtime checks passed all 16 plugin-startup cases with zero external
startup calls. CPU speech imports, offline Code Truth, Compose readiness,
migration rerun and disposable backup/restore passed before cutover. All 25 app
build artifacts match the locally verified snapshot.

Both coding checkpoints and the Browser checkpoints passed. The protected backup
is `backups/pre-release-1793607782072-26985359.dump` (**2,500,838 bytes**), and its
archive listing is verified. All **51 application/supervisor/task artifacts**
match the tested images. Public and loopback health, readiness, admin, Mini App
and frontend assets return HTTP 200 with matching hashes, allowing only the
existing Cloudflare analytics insertion.

App, worker, runner, Code Truth and PostgreSQL are healthy. Configuration,
credentials, persistent mounts, PostgreSQL and all three Actions runner identities
are preserved. The native Browser service remains active with its previous
verified manifest and unchanged source. No live Telegram/model test or account
connection was performed. Source, checksums, logs and `deployment-receipt.json`
remain in the release bundle. The original index and main branch are unchanged.

An initial preflight rejected a missing Codex Compose overlay before any writer
was stopped. The overlay was copied from the current release; the same verified
images passed the repeated preflight and cutover. The initial failure and corrected
packaging checksums remain in the bundle.

## Remembered Browser websites deployment (2026-11-02)

The operator-authorized coordinated application/native-host update promoted
release `1793583945996-1` at `https://dev.stonegate.me`, replacing
`41170079370-1`. Package version remains v0.1.46. Application source is
`56350be2895ce813741826e12c14b5198b58379b`, tree
`a787df36b525f6b396c6565a5de432ec04731e64`. It layers the Browser consent feature
`f93676304df69dc507bf01d23965191d6113d7db` onto the existing deployment branch
`eac952d1ab45dc68f4acafd65a33bfc269e91a6f`, preserving deployed audio and Code Truth
behavior. Later operator-only recovery corrections were used without rebuilding
the verified application images. The unrelated local development worktree was
not included. This explicit source deployment does not publish a stable release.

Website approval now persists per workspace/member and exact origin. Routine
operations on an approved site proceed within Pi's original run; external effects
still require approval. The application and native host share the new inspection
protocol. No dependency or SQL migration was added. The unchanged Code Truth
image/index and existing native Node/Chrome runtimes were retained.

Before production cutover, lint, strict types, build, **1,368 deterministic tests**
and **17 Browser/catalog scenarios** passed. The exact VPS image passed all 16
offline startup cases with zero external calls, CPU speech imports, Code Truth
smoke, disposable Compose readiness, migration rerun and backup/restore. Native
package hashes match the locally verified manifest; the native Codex dynamic-tool
proof also passed. Two operator regressions added after the initial failed attempt
bring the final suite to **1,370 tests across 149 files**, with lint/types passing.

The final receipt at 02:29:20 UTC verifies **51 packaged artifacts**, expected live
images and all frontend assets through both loopback and the public entry. Health,
readiness, admin and Mini App return HTTP 200. API, worker, supervisor, Code Truth,
PostgreSQL and all three CI runners are healthy. The headed Browser probe confirms
routine fill/navigation, blocked unapproved submission, revision fencing and
private profile cleanup. Native restart preserves the socket directory; both
existing API and worker mounts successfully invoke Browser afterward.

The protected backup is
`/opt/repodesk/backups/pre-release-1793583945996-1.dump` (**2,238,307 bytes**), with
its archive listing verified. Configuration, credentials, persistent mounts,
PostgreSQL and CI runner identities are preserved. Protected source metadata,
checksums, image checks, native proofs and `deployment-receipt.json` remain under
`/opt/repodesk/releases/1793583945996-1`.

The first attempt interrupted service when Compose progress contaminated checkpoint
JSON and Compose dependency resolution blocked recovery. The original writers
were restored before the corrected exact-image resume. See the
[incident and regressions](../../postmortem/2026-11-02-browser-checkpoint-output.md),
[successful status check](https://github.com/stonega/repodesk/actions/runs/41378162854)
and [full receipt](https://github.com/stonega/repodesk/actions/runs/41378414076).
Real website accounts, native Telegram consent and live Pi/model interactions
remain separate acceptance checks; none were used as deployment probes.

## Default-enabled host Browser deployment (2026-10-31)

The explicitly authorized rollout retained `https://dev.stonegate.me` and promoted
release `41170079370-1` (package v0.1.46), replacing `1793266373668-15413800`.
Application images use source `a601557577e0145a6b9b07488e028b3feaab3fc3`, tree
`08bf94a2884b10bbdd8b5560ffbaa448fc648db6`. Native host code uses
`350dfe7fdbf6e8cb93e75d7c4ab572516b608cc4`; deployment composition/preflight fixes
use `8663584f2886f6a775b5e7b8a173f8e877b03467`. The immutable, tested images were
reused for the final cutover. Source archives, protected logs and the verification
receipt remain in the release directories. The normal host-updater path is unchanged.

The Browser built-in defaults to enabled and keeps explicit Disable settings.
API/worker/database remain in Docker. A systemd host service runs sandboxed headed
Google Chrome `156.0.8078.79`, with separate Linux identities, displays and profiles
for each workspace/user. Its private Node `v24.21.0` runtime does not replace the
host's global tools. The authenticated Unix socket and application token are the
only Browser additions to API/worker mounts; profiles and the host key stay private.

Local validation passes lint, strict types, build, the Node startup contract and
**1,365 tests across 148 files** with a 15-second deadline. The exact VPS application
image passes 16 offline startup cases with zero external calls. Disposable migration,
backup/restore, speech imports, Code Truth and native Codex dynamic-tool checks pass.
The headed package, unprivileged installer access and Node/Ubuntu nft compatibility
checks pass. Previously verified Browser/Mini App UI scenarios are unchanged by the
operational corrections.

The production receipt verifies **51 application/supervisor/job artifacts** and
public/loopback HTML and assets, including the existing Cloudflare analytics
insertion. API, worker, runner, Code Truth, PostgreSQL and the native Browser service
are healthy. Restarting the host service preserves the socket directory inode;
both existing API and worker mounts successfully invoke headed Browser afterward.
Unsigned member and Codex Browser requests return HTTP 401. The existing Telegram
main Mini App is configured; no real site login or test Telegram/model call was used.

The final protected backup is
`/opt/repodesk/backups/pre-release-41170079370-1.dump` (**2,093,924 bytes**), and its
archive listing is verified. Migration `022_browser_profiles.sql` is applied.
Configuration, credentials, existing volumes, PostgreSQL and all three CI runners
are preserved. The original index and local main branch were not changed.

The first cutover in `41166151438-1` failed because deployment packaging shadowed
inherited encryption-key mounts. Recovery restored the prior release before the
successful fresh cutover. The failed attempt's backup and logs remain available.
The deployment script now probes migration, API and worker secret readability
before stopping writers; regressions cover missing API and worker mounts. See the
[incident and prevention record](../../postmortem/2026-10-31-browser-deployment-secret-mount.md)
and [successful deployment run](https://github.com/stonega/repodesk/actions/runs/41170079370).

## Private forwarded reference deployment (2026-10-29)

The operator-authorized cutover deployed the forwarding fix `fd388cb` on top of
the existing audio runtime, using snapshot
`d5057efc946938ceecdd8f1f4a7b34a3adf9861f`, source tree
`4d9cc7d5cea168ae3181d6468eec4e6aeb6042d7`, in bundle
`1793266373668-15413800` (package v0.1.46). It replaces
`1793168496847-42554913`. The snapshot differs from the previously deployed
`a5d505cc6ed3661a859046c8d17dd75cfd94ee9d` only by the forwarding commit's nine
files, preserving the deployed audio improvements. No dependency or migration
was added.

All 569 tracked runtime, build and test inputs match the workspace verified with
**1,267 tests across 136 files**. Isolated lint, strict types and build passed.
The local Node 24 image passed all 16 integration-startup cases with zero external
startup calls. All four images built on the VPS from the checksummed archive;
the app's 22 build files match the locally tested image. All ten core speech
package versions match the previous deployment. Exact-image runtime contracts,
CPU speech imports, offline Code Truth catalog/index/MCP checks, Codex CLI checks,
disposable Compose configuration/readiness, migration rerun and backup/restore
passed before production cutover.

Both coding checkpoint checks passed. The protected backup is
`backups/pre-release-1793266373668-15413800.dump` (**1,951,767 bytes**), with its
archive listing verified. All 45 deployed application/supervisor/task artifacts
match the tested images. App, worker, runner, Code Truth and PostgreSQL are healthy.
Public and loopback health, readiness and admin return HTTP 200; public HTML and
all seven frontend assets match the build, allowing the existing Cloudflare
analytics insertion. A separate local probe also passed all three public routes
with the deployment verifier's user agent; the default Python user agent was
rejected with HTTP 403.

Configuration, credentials, persistent mounts, PostgreSQL and all three CI runner
identities were preserved. Source, build/check logs and `deployment-receipt.json`
remain in the protected release bundle. Native Telegram acceptance of the reported
forwarding-dialog flow and its actual topic IDs remains pending.

## Audio conversation deployment (2026-10-28)

The operator-authorized manual source-snapshot cutover deployed
`a5d505cc6ed3661a859046c8d17dd75cfd94ee9d`, source tree
`d589729fabbd5bb8f104be3dd0e9899f1c2a3f83`, based on
`c46520778866474020f4236f5f551d8b4a000ab1`, in bundle
`1793168496847-42554913` (package v0.1.46). It replaces
`1793084755463-19144425` and includes natural voice replies,
suppression of ordinary chat queue notices, warm speech-process reuse, recent
transcript caching and incomplete-decoding rejection. No dependency or migration
was added.

All four images built on the VPS from the checksummed source archive. The app's
22 packaged build files match the locally tested image, which passed lint, strict
types, build and **1,232 tests across 135 files**. The exact Node 24 image passed
all 16 integration-startup cases with zero external startup calls. CPU speech
imports, offline Code Truth catalog/index/MCP checks, supervisor/task CLI checks,
disposable Compose readiness, migration rerun and backup/restore passed. The VPS's
ten core speech-package versions match the locally tested image.

Both coding checkpoint checks passed. The protected backup is
`backups/pre-release-1793168496847-42554913.dump`
(**1,927,221 bytes**), with its archive listing verified.
All 45 packaged application/supervisor/task artifacts and the worker image match
the verified build. Public and loopback health, readiness and admin return HTTP
200; all seven frontend assets match their expected hashes. The origin HTML is
byte-identical to the image. Public HTML matches after allowing only the observed
Cloudflare analytics insertion. The initial overly strict public-HTML check and
its corrected verifier/log remain in the bundle; no further service cutover was
needed.

App, worker, runner, Code Truth and PostgreSQL are healthy, and the existing speech
model cache reports Ready. Configuration, credentials, persistent mounts,
PostgreSQL and all three CI runner identities were preserved. Source, image
metadata, verification evidence, the HTML-check correction and
`deployment-receipt.json` remain in the protected bundle. This manual snapshot
cutover is separate from publishing a stable GitHub release. Live transcription
accuracy for the reported recording and native Telegram desktop/mobile behavior
remain acceptance checks.

## Groups table deployment (2026-10-27)

The operator-authorized committed-source cutover deployed
`c46520778866474020f4236f5f551d8b4a000ab1`, source tree
`a9287ffcd398b9b5399989c134b58540a5e8949c`, in bundle
`1793084755463-19144425` (package v0.1.46), replacing
`1793081723134-56518479`. Groups now uses the Members table layout with per-row
Edit dialogs and readable mobile empty-state guidance.

The retained local evidence includes lint, strict types, build, **1,229 tests
across 135 files**, **52 browser scenarios** and the final 14 affected browser
reruns. Four images were built on the VPS from the checksummed committed archive.
The exact Node 24 app image passed all 16 combined integration-startup cases with
zero external startup calls. CPU speech imports, offline Code Truth real-index/MCP
and catalog checks, supervisor CA/task CLI checks, disposable Compose cutover,
migration rerun and backup/restore passed. The first restore rehearsal used the
empty pre-installation fixture backup; a post-migration backup passed the corrected
rehearsal before production cutover.

Both coding checkpoint checks passed. The protected backup is
`backups/pre-release-1793084755463-19144425.dump` (1,906,895 bytes), with its archive
listing verified. All 48 application artifacts match the deployed app, worker
and supervisor; all 22 built dist files and the task image match the locally
tested build. Public admin HTML and all seven frontend assets match their tested
hashes. App, worker, runner, Code Truth and PostgreSQL are healthy; public and
loopback health, readiness and admin return HTTP 200.

Configuration, credentials, persistent mounts, PostgreSQL and all three CI runner
identities were preserved. The updater and cleanup timer remain active. Source,
verification logs and the deployment receipt remain in the release bundle. SSH
monitoring recovered through a temporary task-specific proxy after the normal
proxy route failed. No manual Telegram message, model call or account connection
was performed; no dependency or migration was added.

## Code Truth startup isolation deployment (2026-10-27)

The authorized manual archive cutover deployed commit
`df4dab5b445b7abd9ecbde812c3c34fe70adc1b3`, source tree
`a1b83d2c59c39be0c8023b7394104afcc2c5b885`, in bundle
`1793066669306-68318929` (package v0.1.45). It replaces
`1793065829494-2218607`, the host-updater v0.1.45 deployment completed while
this fix was being prepared. The fix isolates known Code Truth setup failures
from unrelated chat while retaining repository authorization.

Lint, strict types, the production build, **1,208 deterministic tests across
132 files** and **52 admin/group browser scenarios** passed. Four images were
built from the clean committed archive. The exact app image passed its Node 24
runtime contract, including unavailable Code Truth setup, and CPU transcription
imports. Code Truth's offline real-index/MCP smoke, supervisor CA/task CLI checks,
Compose configuration/startup, migration rerun and disposable backup/restore
checks passed. All 22 application artifacts match the isolated source build.

The VPS verified source/bundle checksums and both coding checkpoint checks before
cutover. The protected backup is
`backups/pre-release-1793066669306-68318929.dump` (1,879,274 bytes), with its archive
listing verified. App, worker, runner and Code Truth are healthy. All 45 deployed
application/supervisor/task artifacts match the tested images. Loopback and public
health, readiness and admin return HTTP 200, and every JS/CSS asset referenced by
admin HTML matches its tested hash. Configuration, credentials, persistent mounts,
PostgreSQL and all three CI runner identities were preserved.

Source, verification logs and the deployment receipt remain in the bundle; the
image archive was removed after success. A transient SSH drop interrupted the
upload, which resumed and passed the complete checksum check before import.
No manual Telegram message, model call, run replay or account connection was
performed. No dependency or migration was added by this fix.

## Matching Groups card and Skills cleanup deployment (2026-10-26)

The operator-authorized manual archive cutover deployed clean commit
`6438d74523d349dd46145996e8d71aba4064df1f`, source tree
`599ca09bd5c993ecb70876816e72195e15d237fa`, in bundle
`1793000844503-81693002` (package v0.1.44), replacing
`1792979946288-50707140`. Groups now shares the Members card layout, including
the heading, New action and padding, with an unboxed saved summary. This also
deploys the Skills policy-test UI cleanup from `824abaa`.

The retained lint, strict TypeScript, build and Node runtime checks,
**1,193 deterministic tests** and **47 browser scenarios** cover the same
committed source.
Four images were freshly built; all 48 application artifacts match the tested
source/build. Exact-image Node 24, CPU transcription, offline Code Truth
real-index/MCP, supervisor CA and task CLI checks passed. The local guarded
Compose cutover, migration rerun and backup/restore rehearsal passed after an
initial fresh-database initialization race; both attempts remain in the logs.

Production verified source/archive checksums and both durable coding checkpoints,
then verified `backups/pre-release-1793000844503-81693002.dump` before migrations.
App, worker, runner and Code Truth are healthy. Runtime configuration, secrets,
named volumes, PostgreSQL and all three Actions runner identities were preserved;
the updater and cleanup timer remain active. Public and loopback health,
readiness and admin return HTTP 200. Public HTML references the tested frontend,
and all seven public asset hashes match. A transient local proxy timeout was
followed by successful direct public verification and separate proxy/VPS probes.
Source, verification logs and receipts remain in the bundle; the imported image
archive was removed after success. No dependency or migration changed.

## Workspace and Google guide deployment (2026-10-26)

The operator-authorized manual archive cutover deployed clean commit
`f38b66a2c8e0a073e030b47d7038e798096ea2d2`, source tree
`22899e233b9a0b201488ae73d843f4ea159d1c89`, in bundle
`1792979946288-50707140` (package v0.1.44). It replaces bundle
`1792842855984-15165143` and includes unified Groups & Members administration,
team currency settings and the Google API enablement guide. The bundle remains
pinned to this tested snapshot; the later Skills UI commit `824abaa` is a
separate source change. No dependency or database migration was added.

Lint, strict TypeScript, application and Code Truth type checks, production build,
all **1,193 deterministic tests across 131 files** and all **394 browser checks**
passed. Four images were rebuilt from the retained source archive. Exact-image
Node 24 runtime, CPU transcription imports, offline Code Truth real-index/MCP,
runner health, task CLI, merged Compose, guarded local cutover, migration rerun
and disposable backup/restore checks passed. All 48 application artifacts match
the isolated source build and the deployed app, worker and supervisor; the task
image's job artifact also matches.

The host verified archive and source checksums, passed both durable coding
checkpoint checks and verified the protected
`backups/pre-release-1792979946288-50707140.dump` before migrations. App, worker,
runner and Code Truth are healthy. Public and loopback health, readiness, admin
and all seven frontend assets return HTTP 200, with matching asset hashes.
Configuration, secrets, named volumes, PostgreSQL and the three Actions runner
identities were preserved; the updater service and cleanup timer remain active.
Source, verification logs and the deployment receipt remain in the bundle; the
imported image archive was removed after success. The initial SSH failure was
isolated to the selected local proxy route and resolved by saving a verified
working node in the active profile.

## Provision the host once

Use a dedicated Linux x86_64 Docker stack with Docker Engine, Compose v2
(supporting `up --wait`), Node 24, Git, Bash, gzip, sha256sum and flock. Reserve
enough disk for local builds, four images, release archives and database backups.
The updater service requires noninteractive Docker and deployment-directory access.
It handles app, worker, migrations, PostgreSQL, Code Truth and the Docker Codex
runner. Custom local build overlays remain separate. Code Truth is always
available internally; workspace enablement controls indexing and tool access.
Its generated service token and indexes persist in `code_truth_auth` and
`code_truth_data` volumes under the existing Compose project.

Before the first release with bundled Code Truth, install the current host
updater using [the updater instructions](updates.md#install-the-host-updater-once).
Older daemons build only three images; their incomplete bundles are rejected
before stopping writers. Manual archives must include the Code Truth image and
`code-truth-tag` artifact; local-image bundles also require `code-truth-id`.

Keep the running deployment directory and Compose project stable. The default
root is `/opt/repodesk`, and the default project is `repodesk`:

```text
/opt/repodesk/
  .env
  secrets/encryption-key
  secrets/codex-runner-token
  updater/update-host.mjs
  updates/requests/
  updates/results/
  updates/logs/
  releases/
  backups/
  .current-release
```

Provide dedicated runtime configuration in mode-600 `.env`:

```dotenv
POSTGRES_PASSWORD=replace-with-a-long-random-URL-safe-password
PUBLIC_ORIGIN=https://repodesk.example.com
TELEGRAM_TRANSPORT=webhook
APP_PORT=3000
```

Keep `secrets/` mode 700. Generate a new encryption key only for a new database:
`openssl rand -hex 32 > secrets/encryption-key`. The runtime Node user must be
able to read the mounted key (for example mode 644 within that private directory).
Preserve the original encryption key, database password, Compose project and
Codex runner state across updates. On SELinux hosts, apply container-readable
labels through host policy. The cutover verifies secret access before stopping
writers. Configure encrypted off-host backups and retention separately.

Route host HTTPS to the app's loopback port (default `127.0.0.1:3000`). PostgreSQL
and the updater have no public ports. Serve a new deployment's `/setup` through
the configured site URL so its operator creates the first administrator in the
web UI, then configures and activates the bot separately. SSH forwarding is
optional for private/local testing.
Installation never registers webhooks, connects accounts or sends Telegram messages.

A first installation can use the documented Compose setup and Docker Codex
configuration; install the host updater after the stack is healthy. Existing
release-bundle deployments retain their original project/root. No GitHub SSH
secrets, production deployment environment or Actions write token is required.

## Host release build and cutover

The daemon checks the selected release ID, fingerprint and tag commit against
GitHub and requires a successful Verify run for that commit. It fetches the exact
commit, validates its package version, builds app, Code Truth, Codex task and
supervisor images, smoke-tests the app's Node runtime and runs the service's
offline real-index/MCP smoke. Builds run on the host before stopping any
services. It records the locally built app, Code Truth, supervisor and task image
IDs with release files in a fresh numeric bundle directory and invokes
`scripts/deploy-vps.sh --local-images`. The same-daemon path requires no duplicate
image archive. Manual transferred archives retain checksum/import verification.

The script:

1. Acquires the deployment lock and checks local release tags still match the
   verified image IDs, or verifies/imports a transferred archive. Concurrent
   host/manual cutovers cannot overlap.
2. Preserves the Codex token/state, validates Compose and secret access and pulls
   the pinned PostgreSQL image before stopping writers.
3. Waits for safe coding checkpoints, stops app/worker and checks again for a
   just-started attempt before replacing the runner. Existing task containers
   finish their current phases; they are not cancelled to accelerate an update.
4. Starts the pinned runner and Code Truth with its persistent token initializer,
   then saves a restrictive PostgreSQL custom dump and verifies its archive listing.
5. Runs migrations once; writers remain stopped if migration fails.
6. Starts app/worker, verifies Code Truth authentication from both writers and checks app readiness
   for up to two minutes, allowing the first Telegram long poll to finish.
   Response bodies and service tokens are not printed in checks.
7. Updates `.current-release` only on success and removes any transfer archive.

The checkpoint budget defaults to 1800 seconds across both checks. It can be
shortened with `CODEX_DEPLOY_CHECKPOINT_TIMEOUT_SECONDS` (1–1800) in the host
service environment. A timeout before cutover leaves the old runner intact and
restarts only writers that were running before the second wait. This is an update
wait, not a coding execution limit. The updater's queue/results survive app
replacement. Inspect progress in the modal and protected host logs.

## Failure and recovery

Release/CI verification or image-build failures leave running services untouched.
Missing configuration, checksums, invalid bundles, secret access and checkpoint
failures are explicit preflight errors. Once runner replacement or database
cutover begins, backup, migration, startup or readiness failure stops app/worker
and preserves the previous `.current-release`. That marker records the last
successful release; it does not prove the old services are still running.

Inspect the failed bundle and protected logs/backups. Prefer rolling forward
with a corrected release. An explicit Retry update creates a fresh bundle and
backup. An agent restart during cutover records an uncertain outcome rather than
replaying it. Reconcile host processes and schema before clearing its reservation.
Never remove volumes or restore/revert automatically. Use
[the recovery runbook](release-runbook.md) for data and unknown delivery outcomes.

Only restart a previous image after confirming schema compatibility:

```sh
cd /opt/repodesk
release_id=$(cat .current-release)
docker compose --project-directory "$PWD" -p repodesk \
  --env-file .env --env-file "releases/$release_id/release.env" \
  --env-file "releases/$release_id/codex.env" \
  -f "releases/$release_id/compose.yaml" \
  -f "releases/$release_id/codex-compose.yaml" \
  up -d --no-deps --no-build --pull never --wait app worker
```

For bundles before Docker Codex integration, omit `codex.env` and its overlay.
Preserve `secrets/codex-runner-token` and `codex_runner_state` together. Temporary
runner outages keep queued tasks retryable; durable cleanup/publication identities
prevent double charges and blind repeated GitHub writes. Apply retention to old
images, bundles, backups and updater logs. Provisioning and a direct cutover were
verified on the recorded VPS on 2026-10-09 for `cfffdfc` (v0.1.32), with protected
backup, migration 017, healthy services, public readiness and updater queue access.
The modal's v0.1.34 retry was verified on 2026-10-10 after recovering disk space;
it used that release's original archive path. A published release containing the
new direct local-image path still needs its live check.

A manual archive cutover on 2026-10-13 deployed package v0.1.36 from the verified
worktree snapshot `bd6c3dc446f33b72e3bd68793b31769de0617a4f`, using bundle
`1791874171029-72300379`. Its source archive and checksum metadata remain in the
bundle. Migration 019 removed legacy Codex and Review Bot repository grants;
post-cutover checks found no remaining plugin repository arrays. The protected
pre-release backup passed archive verification, all application containers were
healthy and public readiness returned HTTP 200. This verifies the transferred
archive path; the published-release local-image updater gate remains separate.

The 2026-10-14 manual archive cutover deployed clean commit
`2dd613aae9fe14abf07fcbc15abfc4d87e940571` (package v0.1.36) in bundle
`1791958130084-55435898`. The retained source archive and verification report
identify the exact deployment. Local validation passed 737 deterministic tests,
239 browser scenarios and exact-image Node/Compose/backup/restore smoke checks.
The protected pre-release backup passed archive verification; all four production
services are healthy and public health, readiness, admin and asset checks returned
HTTP 200. Configuration, secrets, database and runner-state volumes, PostgreSQL
and CI runner identities were preserved. No migration was added. This remains a
manual archive deployment, separate from the published-release updater gate.

The later 2026-10-14 cutover deployed clean commit
`1afd6f5f58b2a5b31a9e1006ec6bcdc7ffadd526` (package v0.1.37) in bundle
`1791965539905-97510167`, including single-account invites/countdown and GitHub
member account updates. Its Verify workflow passed; the exact images passed local
Node runtime, Compose, migration rerun and backup/restore smoke checks. The host
verified the transferred archive, waited for durable coding checkpoints, verified
the protected pre-release backup and completed readiness checks. All four services
are healthy; public health, readiness and admin requests returned HTTP 200, with
served JavaScript/CSS matching the verified image. Configuration, secrets, database
and runner volumes and existing PostgreSQL/CI runner identities were preserved.
No migration was added. Source, CI and post-deployment receipts remain in the
bundle. This is another manual archive deployment, separate from the published
release updater gate.

## Google confirmation topic deployment (2026-10-24)

The operator-authorized manual archive cutover installed source tree
`45dbf03ccdf3f1c943eeab23215448571d5986d3`, based on pushed fix commit
`5f222bfe13034287d068040a08f64f1f55e7d6e8`, in bundle
`1792842855984-15165143` (package v0.1.44). It replaces bundle
`1792808351773-02844639`. The snapshot retains the previous deployment's group
dialog and other runtime sources; only `src/google/config.ts`,
`src/google/service.ts` and `src/google/telegram.ts` change application behavior.
No dependency or database migration was added.

All four images were built from the isolated retained snapshot. Lint, strict
TypeScript, build, all **1,190 deterministic tests across 130 files** with the
CI-standard 15-second timeout and **44 focused browser checks** passed. Browser
checks covered Google, group dialogs, the catalog, service URLs and updates, using
a separate test port and disposable database filename. The bundle retains the
test isolation patch; no full browser-suite result is claimed for this cutover.
Exact-image Node 24 runtime, CPU transcription imports, offline Code Truth,
Docker Codex lifecycle, merged Compose, readiness, migration rerun and disposable
backup/restore checks passed. All nine frontend artifacts match the prior image.

The guarded cutover verified archive/source checksums, waited for durable coding
checkpoints, stopped writers and verified
`backups/pre-release-1792842855984-15165143.dump` before migrations. App, worker,
runner and Code Truth are healthy. All 45 deployed artifacts match the tested
images; public and loopback health, readiness, admin and versioned asset requests
return HTTP 200. Configuration, credentials, persistent volumes, PostgreSQL and
all three Actions runners were preserved. The verified receipt and source remain
in the bundle; the imported image archive was removed after success.

No account was connected, consent confirmed, webhook registered or manual Telegram
message sent by deployment. Existing flows without a saved topic keep their old
destination; members start `/google connect` again to receive confirmation in the
initiating topic. Live consent/confirmation after this rollout remains a member
acceptance check. See the [incident](../../postmortem/2026-10-24-google-confirmation-topic.md).

## Group management dialog deployment (2026-10-24)

The operator-authorized manual archive cutover installed source tree
`435eb33600b278edf3dba13ebee3e9e80f260230`, based on commit
`7ddfd760057269dfe7cba31b2633a45b6279383a`, in bundle
`1792808351773-02844639` (package v0.1.44). It replaces bundle
`1792800488147-74185335` and moves group management actions into an Edit dialog
opened by the card's top-right pencil icon. No migration was added.

All four release images built from the retained source snapshot. Exact-image
Node runtime, CPU transcription imports, offline Code Truth, merged Compose,
readiness, migration rerun and disposable backup/restore checks passed. The full
browser run passed 382 scenarios. Two stale plugin-catalog expectations were
corrected for the seventh built-in plugin and passed on rerun; the bundle retains
that test-only change as `validation-test-correction.patch` separately from the
application build snapshot.

The protected cutover verified archive checksums and durable coding checkpoints,
then created and validated
`backups/pre-release-1792808351773-02844639.dump`. App, worker, runner and Code
Truth are healthy. All 45 packaged artifacts match the tested images; public and
loopback `/healthz`, `/readyz`, `/admin` and versioned assets return HTTP 200 with
matching JavaScript/CSS hashes. Configuration, credentials, persistent volumes,
PostgreSQL and all three Actions runner containers were preserved.

The initial post-deployment helper missed versioned asset URLs, and the default
Python HTTP client received an edge HTTP 403. Correcting the URL matcher and
identifying the deployment client completed verification without further service
changes. The original logs and final `deployment-receipt.json` remain in the
bundle. The imported image archive was removed after success. No manual Telegram
message, account connection or webhook registration was performed.

## Reference-source blocker fix deployment (2026-10-23)

The operator-authorized manual archive cutover deployed commit
`b4bac2e15e7083f7800cc0a36813a11ed8187483` (package v0.1.44) in bundle
`1792747504017-26715920`, replacing bundle `1792737476277-54958102` from `1261479`.
The snapshot includes the Codex reference-source/blocker correction and the
previously committed Plugins page changes. No database migration was added.

All four images were built from an isolated checkout of that exact commit. Node 24
runtime, Code Truth offline real-index/MCP, full Docker Codex lifecycle/reference
smoke and merged Compose checks passed. The host verified the image and source
archives, acquired the storage/deployment locks, waited for safe checkpoints,
stopped writers, verified its restrictive database backup and completed migrations
and readiness checks through the existing script. Secrets, database, runner state,
PostgreSQL and the separate Actions runners were preserved.

Post-cutover checks confirmed the pinned image identities and exact server, worker,
frontend, supervisor and task artifact hashes. App, worker, runner and Code Truth
are healthy; public `/healthz`, `/readyz` and `/admin` return HTTP 200. Source,
image metadata, verification logs and `deployment-receipt.json` remain in the
bundle; the imported image archive was removed after success. The protected backup
is `backups/pre-release-1792747504017-26715920.dump` and its archive listing verified.

The incident task remains waiting at revision 4 with no live attempt. Deployment
did not continue or publish it; its next authorized input uses the new source
preparation. This manual source snapshot deployment is separate from publishing
a stable GitHub release or exercising the hosted updater's release-selection gate.

## Operator-requested fresh installation (2026-10-18)

At the operator's explicit request to clear the deployment **including data**, the
VPS at `169.58.58.71` was reset and redeployed from clean commit
`cea5d410fa06b0e3c9cf2b420b1a3d7020238c99` (package v0.1.39), in bundle
`1792281550088-85350776`. This was a destructive fresh installation, separate from
the normal data-preserving update procedure above.

The old PostgreSQL and Codex runner volumes, six retained task containers and
their three volumes, prior backups, credentials, update history and deployment
artifacts were removed. The database password, encryption key and runner token
were regenerated. HTTPS routing, the Compose project and the separate Actions
runners were retained. No admin, workspace, bot or external account was created
or connected. The fresh database had zero admins/workspaces and `claimed=false`.

Biome, strict TypeScript, build and all **863 deterministic tests** passed with
disposable PostgreSQL. The exact app, supervisor and task images built; Node 24
runtime, full-stack Compose readiness, fresh migrations/rerun and backup/restore
smoke checks passed. The browser suite could not start because another local test
server occupied port 3107; no browser-suite or rendered-UI verification is claimed.
The host verified the image archive before stopping services and reused the
normal protected deployment script against fresh volumes. All four services were
healthy after cutover; public health, readiness and setup checks returned HTTP 200,
with setup uninitialized. Public JavaScript/CSS matched the verified image.
The host updater and cleanup timer resumed. Source, verification, reset receipt
and protected logs remain in the bundle; the temporary upload and duplicate
bootstrap secrets were removed. Complete first-run setup at
`https://dev.stonegate.me/setup` and reconfigure connections before using the bot.

## Custom domain from the panel

Sign in as a deployment administrator and open **Deployment → Site domain**.
Use **Add custom domain** (or **Edit domain**) and enter a hostname such as
`admin.example.com`, without `https://`, a port or a path. This setting overrides
`PUBLIC_ORIGIN` for generated callback URLs and adds the new HTTPS origin to
allowed admin requests immediately, across the app and worker. No restart or
`.env` edit is needed. Keep the original configured address routed for recovery.

Prepare DNS and HTTPS before switching:

1. At your DNS provider, add an A record pointing the hostname to the VPS public
   IPv4 address. Add AAAA only if your server and proxy also serve IPv6.
2. Configure your existing HTTPS proxy to serve this hostname and forward to the
   app's loopback port. For host-installed Caddy with the default `APP_PORT=3000`,
   the site block is:

   ```caddy
   admin.example.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   Adjust the upstream port if `APP_PORT` differs. A containerized proxy needs a
   reachable container upstream instead of host loopback. Caddy can obtain and
   renew HTTPS certificates when DNS points to the server and ports 80 and 443
   reach it. See the [official Caddy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy).
3. Save the domain in the panel, open its HTTPS address and sign in there. The
   panel stores the hostname; it does not verify DNS or HTTPS availability or
   modify infrastructure. The original site remains an allowed recovery origin.
4. For existing GitHub Apps, copy the Homepage URL, Callback URL and Setup URL
   shown in **Site domain** into GitHub App settings. Pending connections are
   cancelled by domain changes and must be started again. New App manifests use
   the saved address automatically.
5. In webhook mode, use **Register Telegram webhook** only after HTTPS is ready.
   Domain changes clear the saved webhook-ready status but leave the existing
   remote webhook until you explicitly register the new address. Polling mode
   requires no webhook changes.

To remove a custom domain, open **Edit domain → Use default address**. This restores
`PUBLIC_ORIGIN`, revokes the removed origin for admin writes, and requires the same
callback/webhook updates. Saving uses an independent revision; a stale editor
must reload current settings before retrying. Domain changes and their operator
are recorded atomically in the deployment audit. The setting persists in the
existing deployment JSON record, so no database migration is needed.
