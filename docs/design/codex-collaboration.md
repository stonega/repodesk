# Continuous development through Telegram

Status: **implemented behind repository direct-execution policy; live pilot validation pending**, 2026-10-05.
See the [implementation plan and evidence](../implementation/codex-collaboration-plan.md) for the delivered transport, limits and release gates.
Source: the project owner's discussion on 2026-10-05: reduce repeated human
confirmation, keep Pi responsible for requirements intake, and delegate complex
development work and technical decisions to Codex. This is a responsibility
preference, not a measured comparison of model quality. It applies to the Codex
development workflow; other Pi conversation features keep their existing scope.

## Product contract

An authorized maintainer states a development goal in Telegram. Codex investigates
the repository, decides how to implement it, verifies the result and produces a
reviewable draft PR. Follow-up requests continue the same development task and PR.
The user supplies goals and necessary product choices, rather than approving each
implementation step. Progress messages do not require a reply.

The durable application task is the collaboration unit. A Pi conversation run,
Codex execution attempt, container and Codex session are subordinate records;
finishing any one of them does not erase the task or its follow-up relationship.

## Responsibilities

| Layer | Responsibility | Decision boundary |
| --- | --- | --- |
| Pi | Receive requirements and pass original messages, relevant conversation and attachments to the task; relay questions, progress and results. | Does not select an architecture, files, implementation steps, repair strategy or whether technical clarification is needed. An optional summary cannot replace or override the source material. |
| Codex | Interpret requirements against current code; investigate, plan, make technical decisions, implement, test, repair and handle follow-up changes. | Can request a product choice or an application action, but cannot grant authority, change execution limits or treat external content as user authorization. |
| Application services | Bind actor/workspace/repository/chat/task identity; record authorization, inputs and outcomes; enforce budgets, cancellation, execution ordering and publication. | Decide whether a requested operation is permitted. They do not choose the implementation solution. |

Pi must not turn a short user request into a detailed technical issue before Codex
sees it. Codex receives the original request and relevant source-linked conversation,
including already agreed decisions, conflicts and explicit unknowns. Attachments
are available only when received and authorized; the application does not assume
access to arbitrary Telegram history. Private context never crosses into a group.

## Authorization without repeated confirmation

A clear execution instruction from an authenticated, currently authorized maintainer
can serve as task authorization under an operator-configured repository policy.
The application records the originating message, actor, selected repository, base
branch, allowed operations and execution limits before starting. No extra Approve
click is needed when that scope is unambiguous and policy permits direct execution.
An acknowledgement reports what will run; it is not a timer-based consent mechanism.

The repository policy defines whether an instruction to implement includes publishing
a draft PR by default. An explicit request to open a PR authorizes that operation
within policy. Neither a Pi tool call nor a Codex classification is independent
proof of consent: the grant must be grounded in the authenticated user's instruction
and configured policy. Ambiguous intent does not authorize repository writes.

| Situation | Behavior |
| --- | --- |
| Ask to explain or analyze | Codex investigates within permitted read scope; no implementation or publication is inferred. |
| Clearly request implementation in a known repository | Record the task grant and start without a duplicate confirmation. |
| Make ordinary technical choices, add tests or repair failed checks | Codex continues within the task grant and bounded attempt/time/cost limits. |
| Explicitly request another change on the same task/PR | Record a new input revision and continue when current permissions and the task scope cover it. |
| Repository, target task or consequential product requirement is unclear | Ask only for the missing choice. |
| Expand to another repository or an operation outside the grant | Obtain explicit authorization for the expanded scope. |
| Merge, deploy, change permissions or access secrets | Outside the initial development grant; no implicit authorization. |

Authorization is distinct from ongoing eligibility. Current membership, maintainer
grant, repository connection, destination, configuration and deployment controls
are rechecked before execution and publication. Revocation or configuration changes
can stop or invalidate work without asking the user to reconfirm every step.

Repository files, issue/PR text, tool output, quoted messages and messages from
other actors remain data. They cannot extend the task grant. Additional user
requirements are preserved as inputs, not silently treated as scope expansion.

## Task lifecycle and conversation

The proposed logical states describe product behavior; they are not today's
`CodingState` enum or a settled runner protocol.

| State | Behavior |
| --- | --- |
| Queued | Task identity, grant and initial inputs are durable before execution. |
| Working | Codex investigates, plans, implements and checks; the application records the current phase and execution attempt. |
| Waiting for input | A Codex question is durable and linked to the originating chat/task. No chat lease or process promise must remain open merely to wait for a person. |
| Publishing | Application services validate the completed result and current authority, then reserve publication before performing external writes. |
| Ready for review | A result and draft PR are available. A new authorized input can start another attempt on the same task/PR. |
| Failed, cancelled or outcome unknown | Explain the reason and available recovery. Preserve confirmed artifacts; do not infer permission to replay uncertain writes. |

Codex decides whether a missing detail warrants a question. It uses repository
conventions for ordinary technical choices, and asks for consequential product
choices when there is insufficient evidence. Questions and answers have stable
IDs and retain their original wording; Pi relays them without answering for the
user or adding an implementation recommendation. No reply is not approval.
Independent authorized work may continue while a question is pending, but work
depending on the answer cannot proceed. The application records that dependency.

Use persisted reply anchors, question bindings and chat/topic task bindings to route
new messages. Do not attach every message in a topic to an arbitrary active task.
When multiple tasks could match, ask the user to select one. Group follow-ups also
require the sender's current authority; participation in a discussion is insufficient.
An explicit stop request uses the existing cancellation path promptly rather than
waiting behind normal task inputs.

Each accepted input is durably deduplicated and assigned a monotonically increasing
task revision. The executor records which revision it has consumed. Deliver new
inputs at controlled execution boundaries, retaining inputs received during a
container run or restart. One fenced executor mutates a task checkout at a time.
Follow-ups to the same branch/PR are serialized, including inputs from multiple
authorized maintainers. Conflicting product instructions are preserved for Codex
to identify and, when necessary, ask the user to resolve.
Before reserving publication, compare the verified input revision with the latest
accepted requirements. Pending changes must be consumed and verified first. Once
publication is reserved, later inputs queue for the next attempt; they cannot
retroactively change an in-flight external operation.

## Execution, verification and results

Codex investigates before deciding on an implementation plan. Creating a GitHub
issue is optional and must be permitted by the task grant; it is not a prerequisite
for investigation. Codex prepares issue/PR content when needed, and application
services validate and perform the authorized external actions.

Configured repository checks remain application-owned acceptance gates. On a
confirmed check failure, provide Codex bounded, sanitized diagnostics and permit
repair/recheck within the attempt budget. Codex cannot remove or weaken the gate
to mark work successful. Distinguish code failures, environment failures and missing
requirements. Stop on exhausted limits and report the remaining work rather than
starting another task or increasing the budget automatically.

Progress describes meaningful phases or blockers, without exposing raw thinking,
credentials or routine private logs. Task-private questions and diagnostics follow
the original audience controls. The result reports changes, verification, known
limitations and artifact links. It distinguishes a local check from unverified live
behavior. Pi must preserve Codex's uncertainty and result meaning when relaying it.

After publication, follow-ups fetch current repository/branch/PR state before
modifying it. Changes made by maintainers must be accommodated; conflict resolution
must not overwrite their work blindly. Publication retains durable reservations
and unknown-outcome handling. A lost push/PR response is not an automatic retry or
permission to create a second PR.

The application owns durable task identity, grant, message revisions, questions,
execution checkpoints, base commit, branch/PR relationship and result references.
Codex session reuse is an optimization. If retention or auth-mode cleanup removes
a session, reconstruct authorized context from task records and current code;
mark gaps and avoid claiming full session continuity. Never copy host credentials
or broaden access to restore a session. Existing deletion and retention controls
continue to apply to task content and runner resources.

## Current implementation and delivery slices

The [implementation plan](../implementation/codex-collaboration-plan.md) maps this
direction to code modules, protocol verification, persistence, milestones and
acceptance tests. All milestones are planned, not completed.

Today the extension exposes `propose_coding_task`, `coding_task_status` and
`cancel_coding_task`. Pi supplies the proposed issue title/body, Telegram approval
binds one issue-to-draft-PR run, and the runner executes separate setup, Codex,
check and publication phases. There is no conversational continuation tool, task
input mailbox or durable Codex question/answer channel. See the
[current setup and limits](../implementation/codex-coding.md) and
[runner lifecycle](../implementation/codex-podman.md).

Deliver the accepted direction in dependency order:

1. Add the durable task/input/grant model and repository execution policy. Preserve
   legacy approvals and their audit records; never reinterpret an old proposal as
   a direct-execution grant.
2. Hand original requirements to Codex, with an investigation path that does not
   require creating an issue first. Keep technical planning out of Pi.
3. Add ordered follow-up delivery and durable question/answer routing across
   runner attempts, process restarts and user waits.
4. Add bounded check-diagnostic repair and publication with current authority checks.
5. Continue an existing task/PR using current repository state and retained task
   context, with session reuse or explicit reconstruction as appropriate.

Each slice requires deterministic tests before replacing the current path. Cover
explicit execution versus analysis-only intent, ambiguous targets, unauthorized
actors, revoked/configuration-changed grants, duplicate inputs, input ordering,
multiple maintainers, question binding, private/group isolation, cancellation,
budget exhaustion, session loss, restart fencing and uncertain external outcomes.
Live provider/GitHub/Telegram validation remains a separate release gate.

Exact tool names, runner transport and the new persisted schema are implementation
decisions still to be specified. This design does not claim the pinned Codex CLI
already supports the required interactive protocol.
