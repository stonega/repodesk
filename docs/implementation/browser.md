# Shared host Browser plugin

Status: implemented and locally verified, 2026-10-31. This document tracks the
requested feature and its verification; production installation and live account
acceptance remain separate deployment steps.

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

No host installer, production migration/deployment, live website login, model call,
Telegram message or webhook registration was performed. Deployment still requires
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
