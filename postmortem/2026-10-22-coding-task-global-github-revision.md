# Coding task stopped after another repository changed visibility

Investigated on 2026-10-22 through the operator-authorized VPS connection.
Inspection was read-only: no deployment, configuration change, task replay,
model call or external message was performed. The pre-release backup was read
as a stream for comparison; it was not restored or copied into this repository.

## Confirmed impact

Task `9e10fc68-b332-47de-9ac8-1acdc0332bf8` targeted
`stonega/repodesk-landing`, base branch `main`, for a FAQ icon transition.
It entered implementation after intake and then failed with
`coding_configuration_changed`. The panel displayed:

> Repository configuration changed; the task was stopped.

The task's recorded times are:

| Event | UTC | Asia/Taipei |
| --- | --- | --- |
| Task created | 2026-10-22 06:36:33.998 | 2026-10-22 14:36:33.998 |
| Intake attempt reserved | 2026-10-22 06:36:36.725 | 2026-10-22 14:36:36.725 |
| Work attempt reserved | 2026-10-22 06:38:16.762 | 2026-10-22 14:38:16.762 |
| Task failed | 2026-10-22 06:41:27.771 | 2026-10-22 14:41:27.771 |

The intake attempt succeeded and reported 65,934 tokens. The work attempt was
cancelled by the runner without a final result. Both retained checkouts were
clean when inspected: no staged or unstaged changes. There was no verified
revision, independent runner check result or PR recorded for this task. The task
token total accounts for intake; it does not establish the interrupted work
attempt's usage.

App, worker, runner, Code Truth and PostgreSQL were healthy during inspection.
The running application reported package version `0.1.42`.

## Cause and evidence

The task payload retained GitHub connection revision **1** and Codex configuration
revision **2**. The current workspace had GitHub revision **2**, while Codex
revision remained **2**. The installation, target repository and base branch
still matched. Its publication policy also remained `publishByDefault: true`.

The pre-release backup taken at 06:06:10 UTC retained GitHub revision 1. Comparing
its selected repositories with current state found:

- Both snapshots contained the same 428 numeric repository identities and the
  same installation identity.
- Excluding `pushed_at` and `updated_at`, the sole repository metadata difference
  was `stonega/clipboard-center-extension` (repository ID `1421985011`):
  `private` changed from `true` to `false`.
- The target `stonega/repodesk-landing` (repository ID `1422993219`) had unchanged
  metadata, including its `main` default branch.
- Retained workspace audit records showed no GitHub reconnect/disconnect or
  Codex settings update during this task.

`RepositorySync.sync` updates metadata for all selected repositories. Its
`repositoryPolicy` comparison ignores activity timestamps but includes privacy;
a difference increments the shared `w.github.revision`.
In the incident build, `checkCodingPayload` required that global revision to equal
the task's saved `payload.githubRevision` before checking its reconstructed
destination. Therefore a visibility change in another selected repository
invalidated this task too.
`checkDevelopment` invokes that check during execution, causing cancellation.

This is a workspace-wide invalidation boundary, rather than evidence of a
configuration change in the task's own repository. The available snapshots do
not identify who changed the other repository's visibility or the exact refresh
time; repository metadata refresh does not retain that field-level audit trail.

## Correction and recovery

No historical authority snapshot or terminal task was edited, and no automatic
retry was requested. A new authorized request can capture the current connection
revision; the inspected work attempt has no patch or publication to recover.

New task payloads include `githubScope`: the connection generation, target
repository revision and visibility. Metadata refreshes retain the connection
generation and advance revisions only for changed/removed repository identities.
The broad workspace revision still fences ordinary reads/approvals and demands
fresh member permissions. It no longer invalidates an unrelated scoped task.
Target generation changes stop a task even before the next permission sync;
restoring metadata does not revive an older grant. Current destination, actor
permissions, installation, Codex settings and publication policy remain checked.

Permission sync previously also cancelled every coding task when its broad
connection revision changed or any repository permission was lost. It now limits
repository-specific cancellation to tasks using those repositories, including
collaborator inputs. Identity loss, account disconnect/reconnect, connection
replacement and records without a known target retain full invalidation.

Existing connections acquire scoped generations during metadata refresh; the
optional persisted fields require no SQL migration. Historical task payloads
without `githubScope` retain global revision validation. No failed task is
automatically replayed, and the incident task remains untouched.

Deterministic regressions cover the original refresh → stale permissions → sync
→ same-attempt publication journey, duplicate sync/polls, target metadata
restoration, collaborator revocation, same-installation reconnection and denial
before publication. A field-level refresh audit remains a possible follow-up;
the correction does not add one. Production rollout and live task acceptance
remain pending.

Validation passed lint, strict TypeScript, production build and 1,098 deterministic
tests across 121 files with disposable PostgreSQL. No dependency, SQL migration,
UI or deployment configuration changed. The investigation and correction did not
restart production tasks or send external messages.

Source references: [metadata refresh](../src/github/repository-sync.ts),
[payload validation](../src/coding/policy.ts),
[task validation](../src/coding/tasks.ts).
