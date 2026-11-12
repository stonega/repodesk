# Repository tasks and preference memory

Local implementation: 2026-11-12. This extends the existing continuous development
engine; it does not add another agent service or dependency. See the
[delivery plan](repository-task-plan.md) and [memory workstream](decision-memory-plan.md)
for the design, and [user workflow](../user/repository-tasks.md) for exact requests.

## Ownership and persistence

Pi registers `configure_repository_tasks`, the objective-aware
`start_development_task` and `send_development_input`, and `manage_preference`.
Registration uses bundled definitions and local state. No credential or service
request is made while opening these tools.

Optional fields on `DevelopmentTask` represent `development`, `investigation`
and `release` objectives, pending objective revisions, prepared manifests and
memory dependencies. Old tasks retain their semantics. Repository overrides live
in `Workspace.repositoryTasks`; preference derivation/recall settings are separate
fields in `Workspace.memory`. Missing settings enable investigation, release,
preference derivation and Pi/Codex preference recall. Explicit saved disable
settings remain effective. Current actor/audience/repository/source checks
remain mandatory. Configuration changes cannot revive old grants.

The task's original relational inputs are retained across executions. A pending
objective is applied at a safe execution boundary, resets the old interpretation
grant, and preserves any PR as a release prerequisite. Codex processes are bounded
attempts. The worker can reconstruct from task inputs, checkpoints and current
repository state after they exit. CI/merge waits use persisted poll times rather
than a long-running Codex process.

## Preparation and protocol

Application and supervisor support repository-task protocol version 1 through
authenticated `GET /tasks/capabilities`. New objectives fail closed on older
supervisors. Existing development tasks do not require that capability.

Codex returns a bounded release proposal naming the procedure files, tag, notes,
flags, assets, CI requirement and unsupported required steps. Fixed verification
still runs. Release preparation accepts an empty patch. A credential-free trusted
export phase opens the actual checked procedure/assets, constrains real paths to
the checkout and exports SHA-256 digests and bounded asset bytes. The application
matches the proposal, trusted manifest, input revision and explicitly named guide.
Model-written hashes do not establish readiness.

When preparation changes code, the ordinary verified PR path runs first. After
the exact prerequisite PR merges into the expected base repository/branch, a new
execution prepares from the default branch. Before each new release write, its
current SHA must still match the verified manifest. CI checks are pinned to that
SHA. Missing/incomplete checks wait or block; the first failed check at a
revision/SHA returns to Codex for repair, while the same unchanged failure blocks
instead of spinning.

## Controlled GitHub effects

`RepositoryReleases` owns tag, Release and asset API calls. The runner never
receives release-write credentials. A retained current release imperative and
exact version are required in addition to current objective availability and ordinary GitHub
authority. `Prepare release` does not provide publication consent. Draft creation
requires an explicit draft request. Unsupported required procedures block before
any release action.

Migration `023_repository_release_actions.sql` adds a tenant-scoped ledger with
unique hashed repository/version/action targets, payload hashes and
reserved/dispatched/confirmed/unknown states. Transactions and task leases fence
workers. Conflicting tasks or manifests cannot claim the same target. Readback
checks the exact tag commit, Release fields and asset digest/size. Pre-existing
matching effects and effects created by this task have distinct receipt origins.
After dispatch, only read-only reconciliation is automatic; absence after an
uncertain response cannot cause replay. Partial receipts survive later failure
and cancellation. No rollback deletes remote artifacts.

GitHub tokens are installation/repository-scoped: release writes request Contents
write, CI reads request Contents/Checks/Commit statuses read. Existing App
registration permits those optional read scopes but does not add them silently to
the default manifest. HTTP clients use fixed GitHub hosts, reject redirects and
store only fixed error codes. Assets are limited to eight and 1 MiB total; guide
files to twelve and 128 KiB each. Registry/deploy/action dispatch adapters are
outside this implementation.

## Memory and erasure

Decision cases retain authored task choices. Preferences have source unions,
visibility/applicability, immutable revision IDs, exceptions, evidence and
candidate/active-reference/superseded/disputed status. Explicit commands derive
their statement from the actual current human text; model arguments cannot
invent prose, scope or source consent. Repeated tool calls return the original
revision/forget receipt. Inference reuses an accounted memory extraction call
and can only create candidates.

The application selects a bounded valid pack for Pi and coding by default,
respecting saved recall overrides. Current task inputs are already passed
verbatim, so their decision cases are excluded from that task's historical pack. A task
and its delayed notifications carry dependency snapshots; every execution,
publication and delivery rechecks canonical revisions, source content and current
access. Pi task-status/context and handoff reads retain those dependencies,
including preference revisions; formulated task questions retain their reference
dependencies as well. Correction, forgetting, disabled recall and source loss fence stale packs.
The worker erases affected runner attempts/checkpoints and derived local result,
transcript and conversation copies before reconstruction. Original authenticated
inputs and confirmed remote receipts remain distinct. Forgotten-source tombstones
and release hashes prevent resurrection/replay without retaining deleted prose.

## Operations

Apply migrations before starting this worker. Deploy compatible application,
supervisor and job images before using the new objectives. Keep additive ledger data
on rollback; drain affected tasks before using an older binary. Disable an
objective to fence new/future effects, then inspect existing uncertain receipts
without deleting or replaying them. Automatic preference recall and derivation
can be disabled independently.

Validation and live acceptance gates are recorded in
[implementation evidence](implementation-status.md#repository-tasks-release-effects-and-preference-memory-2026-11-12).
Local fixture success does not establish live model interpretation quality or
authorize a production release. No live account, model or Telegram call is needed
for the deterministic examples in
[repository-task checks](../../examples/repository-tasks.md).
