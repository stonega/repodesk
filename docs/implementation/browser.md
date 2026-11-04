# Shared host Browser plugin

## Paused-task coordination and recovery (2026-11-04)

Pi Browser work now keeps one controller per verified member/bot/private Topic.
Short English/Chinese progress and continuation controls inspect its saved state
without another model run. Pending consent is never inferred from “continue”. An
explicit retry after expiration queues the original run with its transcript and
an attributed input; the next action needs a fresh decision. Cancelled, denied,
uncertain and revoked attempts are not automatically revived. Other questions
and attachments retain normal routing, while the broker binds concurrent Browser
observers to the original task and blocks takeover, navigation, filling and new
approval creation, even after the original task ends. Private history alone does
not establish Browser task ownership.

Wait messages distinguish website, action, secure input and control, with only a
safe exact origin and operation description. Pi expiration/denial/cancellation
gets a deduplicated outcome notice. Requested status is refreshed before delivery;
outdated terminal notices are suppressed after continuation. Current membership,
source, Browser configuration, profile epoch, bot and actor/Topic guards remain.

Approved controls can report a denied destination without closing the browser.
The saved outcome keeps its unavailable status and bounded origins on replay;
an uncertain submission is never redispatched. Pi is instructed to inspect the
current page/tabs and distinguish necessary destinations from optional background
requests before a new decision, rather than restarting the form.

Native download status now verifies file existence, regular-file identity, link
count, nonzero size and the saved byte count. Downloads stream into exclusive
owner-private files with the existing 25 MiB bound; failed, empty and oversized
copies are removed. Fixed download failure codes enter the private tool status,
without upstream exception text. A completed click or a page banner is not file
completion evidence. Browser's private artifact page remains the delivery surface.

Production-composition regressions reproduce status contention and expiry/retry;
all three fail on the previous `main`. Further tests cover scope/revocation,
observer reconstruction, stale notices, unavailable receipts and partial files.
Real-DOM tests exercise an approved denied-origin redirect and a real local HTTP
download through file verification. See the [incident](../../postmortem/2026-11-04-browser-task-contention.md).
Validation passes lint, strict TypeScript, build, the 16-case offline Node startup
contract with zero external startup calls, and 1,419 deterministic tests across
151 files with disposable PostgreSQL. All 17 focused browser scenarios pass:
five native interaction/file cases and 12 desktop/mobile Browser UI cases.
Code Truth catalog regeneration and the service smoke also pass; the bundled
catalog is unchanged. No dependency or SQL migration was added.

CI runs the complete browser suite across two isolated database-backed matrix
jobs, with one Playwright worker per shard. This preserves serial fixture behavior
while avoiding the previous whole-suite job timeout. The required `checks` job
still requires both shards, the quality job and the container checks to pass.

These changes are implemented but not deployed. Native Telegram rendering, the packaged headed-host
release smoke and a coordinated app/host VPS rollout remain release checks. No
historical run, website decision or live submission was replayed.

## Telegram continuation confirmation (2026-11-04)

Successful Browser approvals and private-input submissions now create a short
Telegram continuation confirmation when the originating Pi/plugin run is queued
again or the Codex browser wait is cleared. The delivery intent and continuation
marker are saved atomically, with a stable request-based ID, private provenance
and the original chat/Topic. Retries and reconstruction cannot create a second
intent. An unavailable or uncertain operation does not claim success; an approval
that transitions into another required input retains its waiting prompt.

The delivery worker rechecks the current task, membership, Browser authorization
and bot. Delayed notices are suppressed after cancellation, completion, another
wait or a newer Browser continuation. Deterministic production-composition tests
cover the authenticated member decision, repeated maintenance/delivery, secure
input, Codex, denial/expiry and stale-notice suppression. Native Telegram
desktop/mobile rendering and production deployment remain separate checks.

Validation: lint, strict TypeScript, build, the Node runtime contract (16 startup
cases, zero external startup calls) and all 1,392 deterministic tests across
149 files pass with disposable PostgreSQL and a 15-second test deadline. The
21 focused Browser integration tests also pass with the final notification
assertions. No dependency or SQL migration was added.

## Redirect website consent (2026-11-02)

The native proxy now returns bounded denied CONNECT origins to the current
Browser consumer. An HTTPS redirect to an unapproved origin returns an unavailable
navigation with `blockedOrigins`, keeps the headed session available for consent
and does not become a generic service outage. Pi requests the required origin,
then continues the original goal after approval. Current saved websites are not
expanded implicitly. A new navigation or controller policy clears old denials.
Deterministic proxy tests and the real headed HTTPS redirect fixture enforce this
boundary. See the [incident](../../postmortem/2026-11-02-browser-partitioned-cookie.md).

## Partitioned-cookie checkpoint correction (2026-11-02)

The private native checkpoint now preserves Chromium's cross-site partition bit
alongside `partitionKey`. This repairs navigation to sites such as YouTube whose
session cookies carry that metadata. Unknown checkpoint data remains rejected;
`browser_checkpoint_invalid` is the safe failure code. The real native fixture
covers partitioned cookies through encrypted worker/root checkpoints, with no
cookie metadata exposed to Pi. See the [incident](../../postmortem/2026-11-02-browser-partitioned-cookie.md)
and [deployment evidence](vps-deployment.md).

## Interrupted navigation and repeated consent (2026-11-02)

An unfinished navigation receipt no longer creates another website request for
an already allowed origin. A lost host response keeps its original uncertain
receipt, while fresh calls in the same run can inspect the page and navigate
without repeating site consent. Operation replay protection, exact-origin checks
and separate external-action approvals remain enforced.

The production-composition regression simulates a lost navigation response after
approval, then checks page inspection, repeated site requests, repeated navigation
and another path on the same origin. It requires one website decision and retains
the original uncertain receipt. This is a local correction, not deployment evidence.

Validation in the development workspace: lint, strict TypeScript, build, the Node
runtime contract and all 1,386 deterministic tests across 149 files pass with
disposable PostgreSQL. The new regression first failed with a second website wait
and passes after the fix.
The isolated commit on the latest `main` also passes lint, strict TypeScript,
build, the Node runtime contract and all 1,384 tests across 150 files.

## Remembered websites and Pi continuity (2026-11-01)

Website decisions now save exact-origin permissions in the encrypted owner
repository, independently of task/controller IDs and temporary leases. Current
membership, private destination, consumer/plugin grants, configuration generation
and profile epoch remain mandatory. Close/restart preserves saved permissions;
the member page lists them and can revoke a site, cancel pending work and queue
host closure. Profile deletion and changed authority invalidate earlier consent.
Schema defaults retain existing temporary grants and pending decisions without
upgrading them to permanent authorization. No SQL migration is needed.

Pi's context and Browser/Codex tool guidance keep website work within the current
conversation/run. Consent and secure input resume its existing transcript and
original goal. Codex remains a Browser consumer inside authorized coding work.

The native protocol adds an inspection-only `review` command, an
`approvalRequired` result and optional `routineOrigins` policy. The app dispatches
routine interactions only after an explicit host decision and binds execution to
the inspected page. The host rechecks the actual element at dispatch. Ordinary
nonsensitive fields, direct HTTP(S) links and non-submitting focus/navigation keys
can proceed on remembered origins. Native links navigate without firing page
click handlers. Buttons, Enter/Delete/Backspace, pointer clicks, unsupported
controls and explicit `requireApproval:true` effects still require review. Tool
instructions require that flag for external changes, including auto-saving fields;
generic DOM inspection cannot infer arbitrary application auto-save behavior.
Sensitive fields continue through the bound secure-input path.

The application and native host were released together. The latest repair release
`41406054824-1` includes remembered website consent, redirect handling and
partitioned-cookie compatibility; see [deployment evidence](vps-deployment.md).
Live website-account and Telegram/model acceptance remain separate checks.

The full development workspace passed lint, strict types, all 1,378 deterministic
tests with disposable PostgreSQL, build, the Node runtime contract (16 startup cases, zero external
calls), 15 Browser scenarios and the Code Truth service smoke after catalog
regeneration. Desktop/mobile and both themes were inspected for consent, saved
sites, empty/loading, pending/failed revocation and the resulting empty summary.
The current native package passes the real headed-host smoke, including routine
fill/navigation and blocked unapproved submission, along with existing
isolation/input/restart/download checks. That smoke image overlays the current
package onto the previously provisioned test runtime; a fresh Debian package
download stalled and was stopped. This is not a fresh OS-dependency rebuild or a
production cutover. No live account, model or Telegram call was made.

The isolated commit for `main` also passes 1,363 deterministic tests, lint,
strict types, build and 17 Browser/catalog scenarios. Its Node 24 application
image passes the offline runtime contract using the existing test runtime
dependencies. Unrelated voice, Code Truth UI and cross-channel coding work was
excluded from that commit and remains in the development working tree.

## Earlier deployment baseline (2026-10-31)

Status: implemented, verified and deployed to the existing VPS entry, 2026-10-31,
release `41170079370-1`. Live website account acceptance remains separate from the
synthetic deployment checks. See [deployment evidence](vps-deployment.md).

## Required behavior and evidence

- [x] A bundled Browser plugin defaults to enabled for new/existing workspaces;
  an explicit Disable survives upgrades and fences every consumer.
- [x] Chat, Codex and other authorized plugins use one application-owned service
  and can hand off the same user's session without a second login.
- [x] Workspace plus verified user identity scopes profiles, credentials, tabs,
  display, control, screenshots and downloads. Cross-user/admin substitution is
  denied through production APIs, not only by hidden UI.
- [x] The host service runs normal headed Chrome with a persistent private
  profile, an isolated virtual display and filesystem/process identity. There is
  no headless fallback and no public raw browser-debugging endpoint.
- [x] Ordinary members can authenticate to one interaction page, inspect and
  control their own session, and submit task-bound passwords/codes. They do not
  need administrator access or a prior remote-desktop login.
- [x] Input is applied only to the current authorized origin, page, task and
  generation. Duplicate, expired, cancelled, foreign and stale submissions fail
  safely. Values stay out of model messages, ordinary run history and diagnostics.
- [x] A durable single-controller lease supports plugin handoff, human takeover,
  cancellation and restart recovery without replaying ambiguous external writes.
- [x] Private browser results retain their authorization in run/thread/task
  history, artifacts, source reuse and final delivery.
- [x] Network/file/preview access and external action approval are enforced by
  application services. Page/repository content grants no authority.
- [x] Process/tab/download limits, idle shutdown, profile cleanup, revocation,
  logout and deletion are implemented and documented.
- [x] Registration performs zero optional service/credential/startup calls.
  `scripts/fixtures/plugin-startup.ts`, deterministic tests and the packaged
  Node runtime contract cover ordinary members, denied/stale grants, missing
  service/configuration and failed dependencies.
- [x] Required lint, strict types, deterministic PostgreSQL tests, build and Node
  runtime checks pass. Desktop/mobile and both themes are inspected with focused
  interaction regressions. The exact Docker image passes smoke checks and merged
  Compose configuration validates. No production cutover is implied.

## Implementation decisions

The browser remains a host service; API/database/worker keep their existing Docker
deployment. The plugin is a facade, not a separate browser per consuming plugin.
Browser control metadata belongs in a dedicated tenant/user-scoped repository;
private page content and raw input do not belong in workspace configuration JSON
or public plugin summaries. Password input is request-only initially; persistent
browser authentication is independent of storing a reusable password.

UI acceptance follows the Browser, shared plugin heading/toggle, modal editor,
loading, toast and card-spacing rules. Plugin details show saved enablement and
service readiness separately. The member interaction page is a task interaction;
it is not a saved-record form. Configuration changes use existing shared dialogs.
Required states include loading, no profile, unavailable service, disabled plugin,
waiting permission/input/control, active control, expired/cancelled requests,
pending submission, recoverable errors and completed actions.

## Progress

- Design requirements are recorded in `docs/design/admin-panel.md` and
  `docs/design/ui-rules.md`; existing unrelated worktree edits are preserved.
- Production composition, extension execution receipts, member identity and the
  default-enabled Obsidian integration have been inspected before coding.
- Added `src/browser/` coordination schemas, owner derivation, run authorization,
  exclusive control generations, input binding, uncertain-operation receipts,
  authenticated Unix-socket transport and an encrypted PostgreSQL repository.
  Migration `022_browser_profiles.sql` has been exercised only against disposable
  test databases; it has not been applied to a deployment.
- Added 37 deterministic tests covering tenant/user separation, ordinary-member
  authorization, control handoff, stale executors, cancelled/expired/duplicate
  input, unknown outcomes, socket authentication, sanitized errors, encrypted
  record substitution, rollback and concurrent database acquisition.
- Foundation validation passed `bun run check`, `bun run typecheck`, `bun test`
  (**1,304 tests across 140 files**, disposable PostgreSQL), `bun run build` and
  `bun run test:runtime`. The existing runtime contract still verifies 16 startup
  cases with zero external calls; Browser registration and its startup-fixture
  additions remain pending, so this is not Browser integration acceptance.
- Implemented the native host supervisor, per-owner locked Linux accounts,
  independent authenticated Xvfb displays, sandboxed headed Chrome workers,
  owner-private artifacts and an authenticated Unix socket. Added exact-origin,
  DNS-pinned egress with nftables protection against direct socket/DNS/WebRTC
  bypass, expiry and revocation of existing connections and pending DNS work.
- Session cookies survive graceful idle/restart through encrypted root-owned
  owner-bound checkpoints; logout replaces the checkpoint instead of reviving
  old authentication. Control journals fsync both files and directory entries.
  Teardown revokes the proxy first and attempts every cleanup step.
- Added bounded download-progress cancellation, file-chooser interception and
  restricted editing/navigation keys. Host artifact reads enforce ownership,
  origin grants, expiry, regular-file/no-link checks and size limits. Private
  screenshots/downloads are still awaiting their application delivery boundary.
- Added seventeen focused deterministic cases (54 Browser tests in total), plus
  a Node WebSocket proxy contract and a real headed host smoke using the actual
  packaged service. Synthetic smoke evidence covers two separate UIDs/logins,
  private displays and files, secure input, controller fencing/handoff, cookie
  restart/logout persistence, screenshots/downloads, oversized transfer
  cancellation, WebSockets, service workers, direct-network denial and the
  standalone CLI. Sensitive input retains its original DOM element and field
  attributes; an actual same-selector field replacement is rejected by the smoke.
- Added explicit host packaging, a systemd unit/installer and an optional Compose
  bridge. The installer fixture verifies retained tokens, settings and profiles
  inside a disposable container. See [host setup and limitations](browser-host.md).
  No installer, account login or firewall change has run on the developer host or
  a production VPS.
- At the native-host milestone, validation passed lint, strict types, **1,335 tests across 144 files**
  with disposable PostgreSQL, build and the Node runtime contract. The application
  Docker image also passes the offline Node contract. Native-host and installer
  fixtures pass in isolated Docker, and the merged Compose file, shell syntax and
  systemd unit validate. The startup fixture still has the existing 16 cases;
  Browser production registration, UI verification and their coverage are pending.

## Application and consumer integration (2026-10-31)

- Registered the default-enabled bundled tools with lazy host credentials. The
  production startup fixture includes Browser in its existing 16 zero-external-call
  cases. Explicit Disable survives unrelated file-plugin edits.
- Added private PostgreSQL grants, site/action/control decisions, exact page
  bindings and durable waiting. Chat and granted file-plugin calls resume the same
  run/tool receipt; reclaimed waits do not replay an uncertain tool.
- Added member-only Telegram Mini App routes and the shared Browser page, without
  a panel account. Signed identity, current bot/member, request origin, owner and
  control generation are checked by application services. The page supports
  secure task input, masked screenshots/downloads, manual takeover, focused-field
  private input, return/close and profile deletion.
- Added saved admin summaries, the title-row enable switch and modal preview
  editing. File plugins receive `context.browser` only in explicitly granted tool
  invocations. Hooks have no Browser context. Current plugin revision/permission
  and original call identity fence every operation.
- Added the Codex capability gateway, supervisor forwarding and native dynamic
  tools. An attempt receives a stable, signed four-hour capability through the
  existing task channel. The host key/socket are never passed to jobs. Browser
  receipts remain in the encrypted owner repository; passwords are not model
  tool arguments/results. The actual pinned Codex 0.155.1 proof uses a local fake
  provider and verifies waiting and restoration of tools on the same thread.
- Private runs, approvals, messages, deliveries and topic summaries are encrypted
  in workspace storage. Browser provenance follows source/handoff/skill/task
  reads, final delivery and coding-task history; shared panel summaries redact
  private bodies. Browser-derived content cannot automatically write the shared
  Obsidian vault or become a reusable shared skill.
- Six focused UI regressions pass at 390/1280px, with light/dark screenshots for
  saved summaries, file-plugin permission editing and member input. Initial
  desktop/mobile screenshots were visually inspected. Additional empty/error,
  screenshot/control and lifecycle state checks remain in final verification.
- The full PostgreSQL suite passed **1,356 tests across 148 files** with a
  15-second test deadline. The default five-second run hit an intermittent
  group-conversation timeout; its isolated 20-test rerun passed. This does not
  justify changing product behavior or claiming the default-deadline run passed.

## Final local verification (2026-10-31)

- `bun run check`, `bun run typecheck`, `bun run build` and
  `bun run test:runtime` pass. The final full PostgreSQL run is **1,363 passed,
  zero failed across 148 files** (`bun test --timeout 15000`). The larger deadline
  accounts for the earlier shared-VPS group-conversation timing failure; the
  default five-second full run is not claimed as passed.
- Thirteen production-composition Browser tests cover signed member access,
  same-run Chat/file-plugin continuations, actual Codex capability dispatch,
  secure input, disable persistence, exact reviewed-page enforcement, consent
  without navigation, stale receipts, expiry/close/delete and crash recovery.
  Revoked file-plugin access also terminates its existing wait without replay.
  Supervisor tests verify that capabilities stay out of job input/environment,
  current channel tokens select the target and revoked in-flight calls fail.
- Fifteen Playwright scenarios pass, including ten Browser scenarios and five
  existing member-history scenarios. Rendered desktop/mobile layouts at 1280px
  and 390px were inspected in light/dark themes: saved summaries, permission
  editor, private input, loading/empty/expired states, pending submission,
  unavailable-service feedback, takeover confirmation and manual controls.
  Fixtures use synthetic identities, websites and screenshots; this is not a
  claim of testing every real website or Telegram client.
- The exact application image passes the offline Node 24 runtime contract:
  16 integration-startup cases with zero external calls. Its isolated migrated
  database smoke serves `/healthz` and `/mini` while denying unauthenticated
  member/Codex requests. The current supervisor image starts and denies an
  unauthenticated Browser channel. The pinned Codex 0.155.1 job image passes the
  native dynamic-tool proof using a local fake provider, including waiting,
  three Browser invocations and tool restoration on the same thread.
- The current packaged headed host and installer pass isolated Docker checks.
  Native evidence includes separate Linux identities/cookies/displays, secure
  input, masking, observation during input, controller fencing, restart/logout,
  private and bounded downloads, replaced-field rejection and network isolation.
  Merged Compose configuration validates. The bundled Code Truth catalog was
  regenerated and its local service smoke passes without a catalog-content diff.

At the end of local verification, no host installer, production migration/deployment,
live website login, model call, Telegram message or webhook registration had been
performed. The subsequent rollout below provides deployment evidence. Deployment requires
explicit host provisioning, the Compose bridge and the bot's HTTPS Mini App URL.
Website-specific account challenges and real-client acceptance belong to that
operator-controlled rollout. See the [user workflow](../user/browser.md),
[operator guide](../user/browser-host.md) and [examples](../../examples/browser.md).

## Deployment preparation regressions (2026-10-31)

The host journal now reuses the controller schema, including a granted plugin's
configuration revision. The real headed smoke verifies that revision survives
subsequent commands and restart, and that an older revision is fenced. The host
installer explicitly grants locked profile UIDs read/execute access to public
service code after its restrictive umask. Its disposable installer proof imports
Playwright as an unprivileged account while confirming the root host key remains
unreadable. These corrections were identified before production cutover.

The first VPS pre-cutover probe exposed a Node/Ubuntu 24.04 compatibility issue:
`nft -f -` rejects Node's socket-backed stdin as a non-regular input file. The
firewall now passes each bounded command batch as one argument, preserving atomic
rule updates without a shell or temporary rule files. The `nft-compatibility`
Docker target runs the production firewall under Node and Ubuntu 24.04, checking
default denial, the selected proxy exception, validation and restart revocation.
This is separate from the Debian headed-browser and installer checks.

A second deployment gate waits for the native Unix socket's final mode/GID before
probing it; systemd process activation alone does not establish readiness. The
unit now preserves its runtime directory across restart and stop/start, because
existing Docker bind mounts must retain the directory inode when the socket is
replaced. The installer regression checks that policy; rollout acceptance also
restarts the real unit and invokes Browser from the existing API/worker mounts.

## VPS rollout acceptance (2026-10-31)

Release `41170079370-1` uses the existing `https://dev.stonegate.me` entry. API,
worker, Codex runner, Code Truth and PostgreSQL are healthy. Google Chrome
`156.0.8078.79` runs headed on the host with private profiles; the host uses Node
`v24.21.0` without replacing the global Node configuration. Native host code comes
from `350dfe7fdbf6e8cb93e75d7c4ab572516b608cc4`; the final systemd override preserves
the runtime directory across restarts. Both existing API and worker containers
successfully invoke headed Browser after an actual service restart.

The final full suite passes **1,365 tests, zero failed across 148 files**, with
10,068 assertions and the 15-second deadline. Lint, strict types, build and the
Node runtime contract pass. The production receipt verifies 51 image artifacts,
public/loopback assets and preserved configuration, volumes, PostgreSQL and CI
runners. Public member and Codex Browser endpoints reject unsigned requests with
HTTP 401. The existing Telegram main Mini App is configured. No real website
login, test Telegram message, webhook registration or paid model call was used.

An earlier cutover failed because a deployment-only flattened Compose file omitted
inherited encryption-key mounts. The previous release was restored, the composition
was corrected and per-service preflight regressions were added before the successful
new cutover. Both backups are retained. See the
[incident record](../../postmortem/2026-10-31-browser-deployment-secret-mount.md).
