# Continuous Codex collaboration — implementation plan

Date: 2026-10-05. Status: **M0–M5 implemented and locally verified; M6 operator controls implemented, live pilot gate pending**.
Product authority: [accepted collaboration design](../design/codex-collaboration.md).
Current baseline: [coding tasks](codex-coding.md) and [Podman runner](codex-podman.md).

## Delivered implementation and validation

Updated 2026-10-06: the user removed execution-cycle, repair-count, active-time
and token quotas from settings and runtime enforcement. Migration 014 strips
old overrides and separates reported token usage from unknown usage. Current
repository policy contains only execution mode and default PR publication.
The earlier quota/budget clauses in the original delivery sequence below are
superseded; authority, cancellation, isolation, retention and verification gates
remain required. Edit opens with the current repository selected and its search
dropdown closed until the user interacts with it.

Updated 2026-10-05: the user removed setup/check configuration entirely. Codex
prepares the environment and returns a bounded repository verification plan. The
runner freezes that plan during repair and replays it without model/GitHub credentials,
with an additional patch-integrity check. Migration 013 removes obsolete command
settings and invalidates affected old grants. Earlier local evidence below predates
this automatic-verification revision; see the implementation log for its checks.

The original delivery sequence below remains the acceptance contract. The selected
transport is a private Codex app-server JSONL client in the existing container,
using CLI 0.155.1. Questions are validated completed-turn envelopes, and inputs
queue at confirmed turn boundaries. Native connection-local questions/live steering
are not used for durable delivery. Waiting frees the task's runner slot. As of
2026-10-07 the runner defaults to four active tasks, configurable through
`CODEX_RUNNER_CONCURRENCY`; one task's attempts stay serialized. Tasks sharing a
workspace device-login cache serialize their Codex phases while other phases can
overlap. See [runner concurrency and resource limits](codex-podman.md#lifecycle-and-recovery).

Migration `011_coding_collaboration.sql` adds tenant-scoped task/input/grant/
attempt/event records. Direct mode is opt-in per repository; omitted policy retains
reviewed approvals. Pi's tools resolve original source IDs. Source-bound intent
interpretations append execution-grant events; model output cannot change repository
identity, policy or publication credentials. Application services recheck
all participating maintainers, audience, source retention, configuration and bot
identity before execution/publication.

Check repair reacquires task credentials within the same isolated work volume and
records each repair before launch. Usage is accumulated by turn ID, excluding
replayed events from earlier turns. Missing usage is marked as unknown. A verified
revision cannot publish while an earlier-arriving input remains unconsumed. Fresh
publication preserves one branch/PR, checks current state and expected head, uses
non-force push, and returns to work on confirmed non-fast-forward rejection.
Ambiguous writes are inspected through GitHub using the exact recorded commit;
unconfirmed outcomes stop without replay. New isolated cycles rebuild context from
retained original inputs, question/answer decisions and current code when sessions
or checkpoints are lost. Source expiry/deletion scrubs private relational content
and retries runner erasure by attempt identity.

Reproducible local evidence:

- `bun scripts/codex-protocol-proof.ts`: real pinned CLI with a local fake Responses
  provider, structured question/answer, resume, missing-session reconstruction,
  token accounting and cancellation. Passed on the host and inside the isolated
  job image. No host credentials or paid calls.
- `tests/integration/development.test.ts`: disposable real PostgreSQL tests for
  atomic input/outbox records, rollback, duplicate updates, edits, tenant/audience
  boundaries, ordered collaborators, two-worker fencing, intent evidence, questions,
  pending inputs, revocation during token minting, incomplete usage, same-PR
  follow-up, closed PR, unknown-publication reconciliation and private-state erasure.
- `tests/unit/codex-runner.test.ts`: legacy compatibility plus checkpoint/slot release,
  repair beyond the retired quotas with sealed credentials and cumulative usage.
- `bun scripts/codex-smoke.ts`: real rootless Podman with fake Codex/GitHub, local Git,
  provider/device credentials, checkpoint recovery, repeated check repair, fresh
  and same-PR publication, remote-head fencing, device continuation and erasure.
  Set `CODEX_SMOKE_PODMAN_SOCKET` when using a temporary rootless service socket.
- The existing admin browser journey verifies reviewed defaults, explicit direct
  policy, publication default persistence and desktop/mobile form layout.

Biome, TypeScript, Bun build, all 351 Bun tests, all 19 browser journeys,
application Node runtime contract, all three image builds and Compose configuration
passed. The protocol and Podman fixtures use synthetic messages and fake external
services; their evidence does not establish live-model interpretation quality.

The dedicated live pilot remains pending: authenticated maintainer → question →
answer → in-flight input → failed check/repair → one PR → restart/session loss
→ follow-up on that PR. Evaluate analysis/execute/ambiguous/quoted-instruction intent
with the actual configured model. No local fake proves natural-language consent
quality, device-account billing or live GitHub/Telegram behavior. Pilot enablement,
account connection and external test messages require their own explicit scope.

Upgrade with the additive migration and rebuilt app/supervisor/job images. Back up
and restore the new relational tables alongside workspace/outbox state. To roll back
behavior, disable direct policy/new starts and drain/cancel existing attempts first.
Changing repository policy invalidates existing pinned tasks. Keep tables and
confirmed artifacts; do not run a destructive down migration, reinterpret queued
inputs as legacy approvals, or restart unknown writes. Local validation includes
migration reruns, application image runtime smoke and Compose validation.

## Outcome and first release

An authorized maintainer can ask in Telegram to implement a change and open a
PR, without a redundant approval click when repository policy permits it.
Codex receives the original requirements, investigates code, makes technical
decisions, asks necessary product questions, implements and verifies the change.
Further messages and PR feedback continue the same task and PR.
Pi handles requirements intake and relay. Application services own identity,
authorization, ordering, budgets, persistence, cancellation and publication.

The first release supports text requirements and received, authorized message
references in private chats and linked group Topics. Do not add file ingestion as
an incidental dependency: preserve existing attachment references and state when
their contents cannot be supplied. Keep the current one-active-runner-task limit
until continuation and recovery are verified. Merge, deployment, automatic reviewer
monitoring, cross-repository execution and new model selection are outside this plan.

The end-to-end acceptance journey is:

1. A maintainer requests a fix and PR in a selected repository; the bot
   acknowledges scope and Codex starts without a duplicate approval prompt.
2. Codex asks a consequential product question. The answer reaches the same task;
   waiting does not hold a Telegram request lease or require a container forever.
3. The maintainer supplies another requirement during work. Codex receives it in
   order and verifies the resulting revision before publication.
4. A Codex-selected check fails; Codex receives diagnostics and repairs it within limits.
5. The application publishes one PR and reports verification and limitations.
6. The maintainer requests another change after completion. The application obtains
   current branch/PR state and Codex updates that PR, preserving others' changes.
7. A restart or lost session does not duplicate inputs, publication or the PR.

## Implementation decisions

### Durable tasks and attempts

Use new tenant-scoped relational tables for the continuous workflow, rather than
putting growing input histories and event streams into workspace JSONB. Keep coding
configuration and existing `Workspace.codingTasks` legacy records in their current
location. New tables participate in the same PostgreSQL transaction as ingress,
workspace policy checks and outbox/delivery intents. No second deployment surface
or new queue/database service is needed.

Proposed tables, with names finalized when the migration is written:

| Record | Required contents and constraints |
| --- | --- |
| `coding_tasks` | Workspace, initiator, repository/base branch, origin bot/chat/topic, logical state, current phase, latest/consumed/verified input revision, branch/PR references, execution fence, cancellation and retention timestamps. |
| `coding_task_inputs` | Task/workspace, monotonic revision, authenticated source update/message IDs, author, input kind, original text and allowed context references. Unique ingress identity and unique task revision. Edits are new inputs, not rewrites of consent evidence. |
| `coding_task_grants` | Immutable actor-bound scope, source message, permitted operations, repository/configuration revisions and limits. Scope changes append grants; Codex cannot write or enlarge them. |
| `coding_task_attempts` | Attempt ID, task, fence, input revision, runner attempt key, Codex thread/turn references, phase, start/end, checks, usage reservations and sanitized outcome. One live executor per task. |
| `coding_task_events` | Deduplicated ordered questions, answers, progress, checkpoint and artifact metadata; stable application question IDs and confirmed Telegram reply anchors. Separate private content from routine runtime logs. |

Bound records and private event payloads by documented retention and size limits.
Question answers retain original wording and author/source references. SQL queries
always require workspace identity. Implement workspace deletion and source-expiry
invalidation explicitly; current soft deletion does not imply a foreign-key cascade.
Retain minimal tombstones/accounting where needed without retaining private content.

Use logical task states from the design and separate attempt phases. A task ready
for review can accept a new attempt. A container exit cannot alone mark the whole
task finished. Waiting time has an inactivity/retention policy separate from active
execution time; waiting tasks release the scarce runner slot at a checkpoint.

### Codex conversation transport

Prefer a small TypeScript adapter around Codex app-server inside the existing
isolated coding container. Official documentation describes thread start/resume,
turn start/steer/interrupt and streamed events; some input/tool features are
experimental. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server).

This is a proposed integration, not a compatibility finding. The image pins CLI
0.155.1. Context7's versioned reference includes thread continuation, but some
question/tool search results resolve to `main`; they do not establish availability
in the pinned build. M0 must settle the required subset using that build's schema
and a local fake-provider fixture before selecting the production transport.

Keep the app-server connection private to the trusted adapter. Prefer attached
stdin/stdout through the Podman control layer, with bounded framing and backpressure,
over adding a public listener. Persist normalized events before acknowledging their
application handling. Do not expose general app-server configuration, process or
filesystem APIs as Telegram tools. No Podman socket, GitHub credential or runner
management credential enters the coding container.

Native user-input requests are usable only if the pinned protocol supports the
needed mode and recovery. Otherwise, have Codex finish a turn with a validated
`needs_input` result, checkpoint, and start a new turn with the user's answer.
Use typed, validated envelopes for questions/results; do not parse conversational
phrasing to decide that a task needs input or is ready to publish. A lost transport
acknowledgement requires reconciliation before any resend; exactly-once steering
must not be assumed. Queue at the next confirmed turn boundary when live steering
cannot be reconciled safely. Durable task inputs remain authoritative in either case.

### Requirements, authority and publication

Proposed Pi-facing tools are `start_development_task`, `send_development_input`,
`development_task_status` and `cancel_development_task`. The start/input tools take
source IDs and an existing repository/task binding, not a model-written technical
issue body. Services resolve original messages, identity and context from storage;
model-provided actor/workspace/permission fields never establish authority.
Questions and task-bound follow-ups route through application bindings, without
asking Pi to plan or decide whether a technical clarification is necessary.

Repository settings distinguish legacy reviewed execution from scoped direct
execution, define whether implementation defaults to a PR, and bound active
time, attempts and provider usage. Existing installations retain their reviewed
mode until the operator explicitly saves the new policy. In direct mode, a clear
authenticated user execution instruction supplies task-level authorization;
analysis-only or ambiguous requests do not authorize implementation/publication.
Codex can interpret intent, but the application validates its interpretation against
the original addressed message and configured policy. Uncertain intent is resolved
with the user. Include semantic intent evaluation in release gates; deterministic
identity checks cannot prove natural-language intent by themselves.

Codex can request optional issue creation and prepare issue/PR content within the
task grant. Application services perform external writes using the existing
reservation pattern. Keep read preparation, credential-free Codex/checks, patch
export and credentialed publication separate. Preserve current `.github/` change
restrictions; configuration of extra write permissions is not part of this plan.
No issue is required to investigate code or begin authorized implementation.

## Delivery sequence

Deliver each milestone as a reviewable change with its acceptance evidence. Keep
new execution behind the repository policy/feature gate until M0–M5 pass together.

### M0 — prove the conversation protocol

- Inspect the pinned CLI's app-server schema/help and test thread start, turn
  completion, continuation, interrupt, steering and question/answer events against
  a local fake provider. Verify custom-provider and device-mode session paths.
- Record the smallest method/event allowlist, experimental opt-ins, bounded payload
  sizes, disconnect behavior and how an input acknowledgement is reconciled.
- Prove a waiting task can checkpoint, release its container/runner slot and
  recover a question without relying on a connection-local request ID.
- Choose native questions or structured completed-turn questions; choose safe
  boundary delivery if live steering cannot meet the durability contract.

Files: new `src/coding/local/conversation.ts` adapter and fake protocol fixtures;
extend `src/coding/local/podman.ts`, `tests/unit/codex-runner.test.ts` and
`scripts/codex-smoke.ts` only as needed for the proof. No dependency or CLI upgrade
is assumed. Any required upgrade must have explicit compatibility evidence and
remain pinned.

Exit: a documented, deterministic protocol fixture and real-container smoke proof
with no paid model calls, real Telegram messages or GitHub writes. If the protocol
is inadequate, revise the adapter decision before implementing the dependent slices.

### M1 — durable tasks, grants and execution policy

- Add an additive SQL migration, typed schemas and a task repository/service.
  Allocate revisions and reserve attempts transactionally. Enforce task fences,
  tenant queries, unique source identities and operation IDs in PostgreSQL.
- Add repository execution mode, publication default and limits to configuration
  validation/admin APIs. Record direct grants from authenticated source messages.
- Preserve legacy approvals/tasks and display their existing artifacts. Add cleanup
  for new task content, stale questions and grants invalidated by source deletion.
- Keep cancellation available to the initiator after maintainer revocation, as today.

Files: `migrations/` (next unused migration number), `src/coding/config.ts`,
`src/coding/policy.ts`, `src/coding/service.ts`, new `src/coding/tasks.ts` and
`src/coding/task-store.ts`, `src/admin/routes.ts`, `src/privacy/service.ts`, and
worker maintenance in `src/jobs/queue.ts`/`src/worker.ts` as required.

Exit: real-PostgreSQL tests prove atomic task/input/outbox commits, rollback,
duplicate rejection, fencing, legacy behavior, revocation and complete soft-delete
cleanup. No feature is enabled by migration alone.

### M2 — original requirements reach a continuing Codex task

- Replace technical issue drafting in the new extension path with source-based
  intake. Preserve original text, agreed decisions and authorized context references.
  Update Pi's coding-specific instructions without relaxing other proposal approvals.
- Add versioned runner start/status/input/event contracts, with task and attempt
  identity, consumed revision and checkpoints. Make issue metadata optional for
  the continuous path; legacy job payloads remain distinguishable.
- Use M0's adapter to investigate and execute. Store resumable session references
  separately from device credentials; reconstruction must also work after cleanup.
- Reject implementation/publication for an analysis-only grant. In analysis mode,
  permit investigation scratch state but do not export a repository change as a
  deliverable. Report the result without inventing implementation authorization.

Files: `src/coding/extension.ts`, `src/agent/context.ts`, `src/coding/service.ts`,
`src/coding/local/{protocol,client,runner-server,supervisor,job}.ts` and the M0 adapter.

Exit: fake-runner/provider tests show original requirement handoff, no Pi technical
plan, no compulsory issue creation, explicit direct execution, analysis-only
boundaries, restart recovery and no duplicate container attempt.

### M3 — follow-ups, questions and progress through Telegram

- Add deterministic task routing from confirmed question/reply anchors and
  workspace/bot/chat/topic bindings. Require attributable current maintainer identity
  for every input; ask for a task selection only when the binding is ambiguous.
- Persist question text and answer bindings before delivery. Relay questions and
  answers unchanged in meaning; never auto-answer or treat elapsed time as consent.
- Accept ordered inputs during work, waiting and ready-for-review states. Use M0's
  safe delivery strategy and retain pending inputs across restarts. Serialize
  collaborators; preserve conflicting requirements for Codex to resolve.
- Send bounded phase/blocker updates without raw thinking or default UUID footers.
  Record confirmed delivery IDs for reply routing. Unknown sends remain unknown.
- Stop immediately through the cancellation path, rather than queuing behind input.

Files: `src/telegram/{webhook,router}.ts`, task routing in a new
`src/coding/telegram.ts`, `src/workspaces/threads.ts`, `src/jobs/delivery.ts`,
`src/coding/policy.ts`, the task service and runner adapter.

Exit: tests cover duplicate/edited updates, answers after restart, ambiguous topics,
two maintainers, unauthorized group users, cross-workspace/private-context denial,
out-of-order arrivals, waiting-slot release and cancellation while waiting/working.

### M4 — automatic verification and bounded repair

- Return bounded, sanitized check outcomes to Codex. Separate failed assertions,
  setup/environment failure, missing requirements and executor interruption.
- Reserve a repair attempt before dispatch, recheck authority and limits, then
  let Codex select the repair. Rerun the initially captured verification plan afterward.
  Start with at most two automatic repair attempts per execution cycle, configurable
  within task limits; never let an agent weaken the gate or reset its budget.
- Reacquire task-scoped model credentials for each repair through the existing
  credential lifecycle. Do not accidentally rely on credentials discarded after
  today's implementation phase. Device logout stops further implementation.
- Reserve usage separately from Pi chat. Settle reported usage when available;
  preserve uncertain reservations. Exact device-account billing may be unavailable,
  so do not claim a measured dollar ceiling where only time/attempt limits exist.
- Bind the verified patch/check result to the consumed input revision. Pending
  requirements block publication until consumed and verified. Inputs arriving
  after publication reservation queue for the next attempt.

Files: `src/coding/local/{job,supervisor,protocol,settings}.ts`, task service,
provider proxy in `src/coding/local/runner-server.ts`, accounting integration and tests.

Exit: deterministic failures exercise successful repair, exhausted limits,
credential rotation/logout, cancellation between checks, stale verified revisions,
and unknown model usage. No background process survives a cancelled attempt.

### M5 — update the same PR and reconstruct lost sessions

- Record application-generated task branch identity, PR number/URL and published
  commit. Follow-up attempts fetch current branch/PR state before planning changes.
- Publish from the verified artifact in a separate credentialed container. For an
  existing PR, update its branch rather than opening another PR or issue.
- Check the expected remote branch head and use non-force publication. If it
  changed, fetch the new state and return to implementation/checks within limits;
  do not overwrite others' commits or repeatedly retry a stale patch.
- Handle merged/closed PRs, missing branches and unrecoverable conflicts explicitly;
  do not silently recreate a PR or choose a new target branch.
- Resume a usable Codex session; otherwise reconstruct from retained requirements,
  decisions, questions, checked outcomes and current code. Missing/expired context
  is reported or clarified, never recovered from unauthorized history.
- Reconcile interrupted branch/PR writes by inspecting authorized remote state
  through application services. Until reconciled, mark publication unknown and
  block replay. Preserve existing confirmed links and task records.

Files: task/publication services, `src/coding/local/{job,supervisor,protocol}.ts`,
scoped GitHub support in `src/github/app.ts`, and the conversation adapter.

Exit: tests prove one PR across repeated follow-ups, no forced overwrite, remote-head
race recovery, session loss in both auth modes, closed/merged PR handling and unknown
publication outcomes without duplicate writes.

### M6 — operator controls, documentation and release validation

- Add execution policy/limits and continuous task status to `web/coding.tsx` and
  existing admin routes, including legacy/new task distinction. Apply
  [UI preferences](../design/ui-rules.md); keep settings readable and credentials
  write-only. Use existing layouts/components rather than a new dashboard surface.
- Update setup, Telegram help/journeys, HTTP examples, runner smoke fixtures and
  implementation evidence only when behavior is actually delivered.
- Verify additive upgrades and backup/restore of task records. Disable new starts
  by policy to roll back behavior; drain or cancel attempts before a binary rollback.
  Preserve pending inputs/questions and do not reinterpret them as legacy approvals.
  No destructive down migration or automatic restart of uncertain writes.
- Run the acceptance journey on a dedicated staging repository and bot under
  explicit live-test authorization, including analysis/execute intent evaluation,
  a restart while waiting, a session-loss recovery and a same-PR follow-up.

Exit: all local gates and the authorized staging evidence pass before enabling
scoped direct execution for pilot repositories. Operators can revert to the legacy
workflow without losing current artifacts or silently publishing pending work.

## Validation and sequencing

Keep existing coding policy, runner and integration suites and add focused task
store, conversation protocol and Telegram task-routing suites. Fake providers,
fake GitHub, fake Telegram, controlled clocks and real local PostgreSQL cover normal
behavior and failure paths deterministically. Container smoke uses local Git and
a fake Codex executable; it is distinct from protocol tests and live model quality.

After each implementation slice, run `bun run check`, `bun run typecheck`,
`bun test` and `bun run build`. When changing images, containers or deployment,
also build/smoke-test the Docker image, validate Compose configuration, and run
the Podman coding smoke test. Run relevant browser checks for the settings changes.
Update runnable examples together with changed interfaces.

Dependencies: M0 and M1 establish the protocol and durability; M2 depends on both;
M3 and M4 extend that task runtime; M5 depends on input ordering, verified revisions
and recovery; M6 closes operator and release gates. Do not enable a partial workflow
that can start automatically but cannot stop, clarify, verify or recover safely.

No calendar estimate is assigned before M0: protocol compatibility, pending-input
reconciliation and device-mode session cleanup determine the remaining effort.
The first implementation change should be the M0 compatibility fixture/proof,
followed by M1's additive persistence and policy changes.
