# Telegram feedback plan for the friend beta

Date: 2026-10-06. Status: **implemented locally; live beta acceptance pending**.

Friends and colleagues should be able to tell whether RepoDesk has accepted their
request, is working, needs their input, has stopped, or has finished. When something
fails, the reply should explain what happened and what the user or administrator
can do next. This plan covers that feedback for ordinary assistant requests and
both Reviewed and Direct Codex tasks before an invite-only beta.

Keep ordinary private replies conversational, using the existing native thinking
preview and Stop control. Longer coding tasks need a small number of factual stage
updates. Application state determines these notices; a model's claim alone cannot
establish that execution started, checks passed, or a PR was published.

## Baseline before implementation

| Area | Present in the working tree | Work for this milestone |
| --- | --- | --- |
| Ordinary private replies | Native thinking previews, Stop, durable final delivery and partial-response notices | Check queued, initialization, recovery and failure exits for missing or confusing notices |
| Direct coding tasks | Start, question, input-received, sign-in and result notices; task-bound status and cancellation | Add readable stages, consistent outcome wording and confirmed stopping feedback |
| Reviewed coding tasks | Exact approval, durable tasks and state notifications | Replace task UUIDs, internal state names and fault codes in routine notices with readable explanations |
| Runner progress | `LocalStatus` reports preparation, setup, implementation, checks and publication phases | Persist useful phase changes and route them to Telegram without duplicate or stale updates |
| Failure text | A coding failure catalog translates several known faults | Add actionable recovery guidance and a readable fallback; cover assistant failures too |
| Delivery | Durable intents, permission checks, rate-limit handling and unknown-send reconciliation | Apply those controls to every new notice and suppress obsolete pending progress |

The working tree already contains changes to coding failure messages and execution
policy. Build on those changes. Codex execution-cycle, repair-count, active-time and
token quotas have been removed by user instruction; notification timers must not
reintroduce execution limits. Existing permissions, cancellation, retention,
container isolation and provider/account limits continue to apply.

## User experience

The messages below are proposed examples. Use the saved repository name and actual
state; keep routine notices short and keep diagnostics in the admin panel.

| Situation | Example reply | Required evidence |
| --- | --- | --- |
| Task accepted | “Your request for owner/repo is queued. Use /status to check it or /cancel to stop it.” | Task and initial input committed |
| Work starts | “I’m investigating the change in owner/repo.” | Runner attempt accepted in the relevant intake or analysis phase |
| Environment preparation | “I’m preparing the repository environment.” | Confirmed runner preparation/setup phase |
| Implementation | “I’m implementing the change.” | Implementation authorized and runner in the work phase |
| Verification | “The changes are ready for checks. I’m running them now.” | Confirmed check phase, not a model summary |
| Repair | “A check failed. I’m working on a repair before publishing.” | Failed check and a repair actually started |
| Question | “Should this apply to all users or only administrators? Reply here to continue.” | Persisted question in the waiting task |
| Sign-in required | “Your task is paused because Codex needs sign-in. Ask the workspace operator to reconnect the account in Plugins → Codex → Configuration.” | Confirmed authentication pause; maintain the existing authorized continuation behavior |
| Stop requested | “Stopping your task…” | Cancellation committed while an attempt is still active |
| Stopped | “Your task has stopped.” | Local cancellation complete and runner stop confirmed, or no attempt ever started |
| Ready without publication | “The changes passed the recorded checks. Publication has not been requested.” | Verified revision with no publication grant |
| Publishing | “The checks passed. I’m opening or updating your draft PR.” | Verification and publication reservation for the current revision |
| Completed | “The recorded checks passed. Here is your draft PR: …” | Confirmed PR URL and published revision |
| Publication uncertain | “I couldn’t confirm whether GitHub accepted the update. An administrator needs to check GitHub before another attempt.” | Persisted unknown outcome; never automatically replay the write |
| Unmapped failure | “I couldn’t finish this task. Ask the workspace administrator to inspect it in the panel.” | Safe generic fallback with internal diagnostic reference retained separately |

Completion wording must describe the recorded verification accurately; passing a
check plan does not establish that every possible test or behavior was checked.
Cancellation does not retract confirmed messages or GitHub artifacts. If a write
was already in flight, report its uncertain or confirmed outcome instead of claiming
that cancellation prevented it.

## Delivered implementation

The application now translates task status and failures into readable replies,
records confirmed runner stages with durable notification identities, combines
fast transitions, and suppresses obsolete pending progress. Status and cancellation
target the replied-to or active task/request, with an authenticated selection when
several are available. Selections recheck every target before delivery and again
before the action. Delivery checks reuse their transaction's connection.

Cancellation distinguishes a recorded stop from confirmed termination. Native Stop
and cancellation of an original request reach its linked coding task using existing
task permissions. Missing runner records and in-flight publication produce honest
uncertainty. Pi handoff text and previews cannot announce that queued coding work
has finished; a failed chat response explains the existing handoff separately.
Ordinary run cancellation receipts remain visible in scoped admin run details.

The following delivery sequence remains the implementation and acceptance contract.

### Local verification on 2026 10 06

Biome, strict TypeScript checking and Bun build passed. All **451 deterministic
tests** passed against disposable PostgreSQL, including phase deduplication, stale
progress suppression, task selection and revocation, single-connection delivery,
confirmed stopping, native Stop after handoff and independent chat/task failures.
All **25 affected admin and Codex browser scenarios** passed; desktop and mobile
feedback screenshots were inspected.

The application, supervisor and job Docker images built. The isolated Node runtime
contract and merged Docker Compose configuration passed. Container smoke covered
provider/device fixtures, questions, reconstruction, repeated repair, publication
fencing, authentication recovery, erasure and cancellation with fake external
services. A fresh image migration/API/worker smoke returned HTTP 200 for health,
readiness, setup and the Codex page. Temporary test state was isolated from the
application database. No live model, Telegram or GitHub acceptance is implied.

## Delivery sequence

### 1 Audit exits and define readable outcomes

List every assistant and coding exit: success, partial output, awaiting approval,
product question, authentication pause, cancellation, failure and unknown outcome.
Include initialization failures, queued recovery and queue exhaustion, not only
exceptions caught during model execution. Define which existing notification owns
each outcome so approval prompts and task acknowledgements do not get duplicate
generic replies.

Introduce a small application-owned presentation layer for status labels and
failure messages. Each failure explanation names the problem, the next step and
who can take it. Distinguish retryable reads from potentially completed external
writes. Keep internal codes in records and operator diagnostics; unknown codes get
a readable fallback. Reuse existing durable state and delivery helpers without new
dependencies or a second job system.

Primary entry points: `src/jobs/execute.ts`, `src/jobs/queue.ts`,
`src/coding/failure-messages.ts`, `src/coding/policy.ts`,
`src/coding/executor.ts` and `src/coding/service.ts`.

Acceptance: every accepted request has a persisted outcome or explicit waiting
state and a defined authorized notification path. Intentionally ignored group
traffic remains silent. Loss of eligibility must not cause a notice that reveals
private task details.

### 2 Add truthful progress and readable status

Map the runner's existing phase and the task's intake/analysis/work mode to readable
stages. Persist stage changes and their delivery intents together under the existing
task/workspace locks; keep remote runner and Telegram calls outside those locks.
Use stable event IDs that distinguish task, execution fence, input revision and
stage transition. Replaying a poll must not create another notice, while a later
real repair or follow-up can produce a new transition.

Send one acknowledgement for an accepted coding task, then coalesce rapid routine
transitions. As an initial notification policy, allow routine updates at most once
per ten seconds per task. Questions, sign-in pauses and final outcomes bypass that
throttle. A phase lasting two minutes may produce one delayed update if a recent
runner poll confirms it is still active. This is a notification threshold, not an
execution deadline. Suppress pending progress when the task advances or terminates;
an already in-flight send cannot be recalled.

Keep short private assistant replies on native previews without an extra immediate
queued acknowledgement. Check long private queue waits and provide one delayed
queue notice when needed. Ordinary group assistant replies keep their current
final-only behavior; coding stage notices go only to the task's original authorized
chat/topic. Scheduled runs use their existing delivery and owner-notification rules.

Make `/status` describe the current stage, whether input is required, and any
confirmed issue/PR link. Keep diagnostic IDs available through explicit status and
troubleshooting, but do not put UUID footers on routine answers. When the runner is
unreachable, describe the last confirmed stage and the unavailable connection;
do not claim continuing work from an old snapshot.

Primary entry points: `src/coding/local/protocol.ts`,
`src/coding/local/supervisor.ts`, `src/coding/executor.ts`,
`src/coding/service.ts`, `src/coding/tasks.ts`, `src/coding/policy.ts`,
`src/coding/telegram.ts`, `src/telegram/webhook.ts` and `src/jobs/delivery.ts`.

Acceptance: a slow task shows a factual current stage; repeated polls and restarts
do not duplicate updates; terminal tasks do not send queued progress afterwards.
Task handoff from Pi to Codex does not misleadingly announce that the requested
implementation has finished.

### 3 Make status and cancellation easy to target

Preserve native Stop for ordinary private generation and existing explicit-ID
commands. A reply or a unique task in the current Topic should make `/status` and
`/cancel` usable without copying a UUID. If there are multiple eligible candidates,
offer a task selection and preserve the intended operation after selection;
choosing a target for cancellation must not append `/cancel` as a new coding input.
Outside Topics, use confirmed reply anchors or offer an authorized selection.

Send the stopping receipt after cancellation is committed. Send final confirmation
only after execution has stopped; queued/waiting tasks with no attempt can confirm
immediately. Cover both Telegram and authorized admin cancellation so task observers
see the same truthful result. Repeated cancellation must not restart work or create
duplicate confirmations. Preserve existing cancellation authority and audience
checks rather than granting broader access through the new targeting interface.

Primary entry points: `src/coding/telegram.ts`, `src/coding/tasks.ts`,
`src/coding/policy.ts`, `src/coding/executor.ts`, `src/coding/service.ts`,
`src/workspaces/service.ts`, `src/telegram/generation.ts`,
`src/telegram/webhook.ts` and `src/jobs/delivery.ts`.

Acceptance: queued, working, checking, waiting, sign-in-paused and publishing tasks
all have an accurate stop response. Ordinary-run cancellation blocks pending final
publication. Another user's private run or another tenant's task is never selectable.

### 4 Close failure and delivery gaps

Apply the readable failure catalog to initialization errors, timeouts and incomplete
assistant replies, runner/provider failures, failed verification, missing GitHub
permissions and unknown publication. An ordinary user should be told when an
administrator must act rather than be sent to an inaccessible settings page.
Preserve necessary product questions and existing account-recovery notices.

Retain separate execution and delivery outcomes. When Telegram is unavailable,
persist the notice and expose its delivery failure or uncertainty in the existing
admin view. Do not automatically resend an ambiguous send or replay an uncertain
GitHub write. Cancellation and permission changes must suppress stale results while
allowing only cancellation receipts that remain authorized. Honour existing pause
controls; feedback must never resume paused execution.

Primary entry points: `src/jobs/execute.ts`, `src/jobs/queue.ts`,
`src/jobs/delivery.ts`, `src/coding/failure-messages.ts`,
`src/coding/executor.ts`, `src/coding/policy.ts` and `src/coding/service.ts`.
Reuse the existing run and coding detail surfaces for operator inspection.

Acceptance: every reachable, eligible requester receives a useful outcome or
waiting notice. When delivery itself fails, the operator can distinguish that
failure from generation failure. No raw provider exception, secret, command output
or private reasoning appears in routine notices.

### 5 Verify the experience and prepare the beta

Add deterministic regressions for the cases below, using fake providers/Telegram
and disposable PostgreSQL. Extend the existing suites rather than duplicate them.
Use an injected clock for notification delays and coalescing.

| Scenario | Required observation |
| --- | --- |
| Fast private answer | Native preview and one final answer; no extra queued acknowledgement |
| Tool-only or empty assistant completion | One readable partial/failure notice |
| Runner or extension initialization failure | Persisted error and an authorized notice |
| Slow Reviewed and Direct coding tasks | Accurate stage updates and readable `/status` |
| Failed check followed by repair | Repair announced only after it starts; completion follows verified outcome |
| Necessary question and reply | Clear waiting state; answer continues the same task |
| Authentication pause and reconnect | Next step identifies the operator; authorized continuation has one resume notice |
| Cancellation in each lifecycle stage | Honest stopping/stopped/unknown result; no later unauthorized publication |
| Multiple tasks and task selection | Status/cancel intent survives selection; no accidental new task input |
| Duplicate update, poll, restart or worker claim | No duplicate notice intent or replayed external write |
| Completion races queued progress | Obsolete pending updates suppressed; final outcome remains available |
| Revocation, deletion, workspace switch and private/group boundary | No cross-tenant or cross-audience notice leakage |
| Telegram rate limit or unknown send | Existing retry/reconciliation behavior retained |
| Unknown fault code or unavailable runner | Readable fallback and last-confirmed-state wording |

Run `bun run check`, `bun run typecheck`, `bun test` and `bun run build` after
implementation, with the existing PostgreSQL test setup. Run affected browser checks
when web presentation changes. Build and smoke-test affected application/runner
images and validate `docker compose config` when deployment or runner contracts
change. Update `docs/user/telegram-experience.md` and command examples with the
implemented behavior; reconcile obsolete wording in the touched sections.

Complete a live acceptance session on a dedicated bot and repository with explicitly
scoped account access, model spend and GitHub writes. Exercise one ordinary question,
one Reviewed task, one Direct task, a necessary question, a slow phase, a check
repair, cancellation, a restart and a follow-up on the same PR. Inspect both the
chat and stored delivery outcomes. Local fixtures establish control behavior;
the live session establishes that the configured services work together.

## Beta acceptance

The feedback milestone is ready when all local checks pass and the live session
confirms the following:

- A new tester can understand whether work is queued, active, waiting or complete
  without reading logs or asking the developer.
- `/status`, native Stop and task cancellation work in their documented contexts;
  stopping feedback matches the actual outcome.
- Accepted requests do not disappear silently. Delivery outages remain visible
  to the operator even when Telegram cannot receive a notice.
- Success messages link only confirmed artifacts and describe recorded checks
  accurately; unknown outcomes never trigger automatic write replay.
- Restarts and duplicate events preserve notification identity and privacy.

Suggested rollout: first complete the staging session, then invite three to five
friends or colleagues. Track confusing messages, missing outcomes and requests that
need developer explanation during their first week. Record problems with sanitized
task/run references in operator diagnostics. Invitations and deployment are later
actions; creating this plan does not perform them.

The remaining beta gate is the live acceptance session described above. Local
fixtures verify application controls and recovery; the configured Telegram, GitHub
and model accounts still need that end-to-end check before inviting testers.

## Related contracts

- [UI rules](../design/ui-rules.md)
- [Telegram experience](../user/telegram-experience.md)
- [Continuous coding implementation](codex-coding.md)
- [Continuous collaboration plan](codex-collaboration-plan.md)
- [Release and recovery runbook](release-runbook.md)
- [Partial runs without replies](../../postmortem/2026-10-06-partial-runs-without-replies.md)
- [Manual feedback acceptance](../../examples/telegram-feedback.md)
