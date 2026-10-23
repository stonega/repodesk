# Missing reference source repeatedly presented as a user question

Incident and read-only VPS investigation: 2026-10-23. Status: **correction
implemented and verified locally; deployment and live task recovery pending**.

## Impact

Task `4efebd18-d3a6-41ed-bf92-340ecbb9f10e` requests a documentation refresh
in `stonega/repodesk-landing`, using `stonega/repodesk` as the reference source.
Four successful intake executions returned the same request for application-side
preparation of a pinned reference source. Each result became a new Telegram
question ending with “Reply here to continue.”

After those attempts, the task remained in `waiting`, phase `intake`, at consumed
revision 4. All four attempts reported `hasChanges: false`; implementation and verification had not
started. This is separate from the earlier task whose publication failed on a
corrupted UTF-8 patch.

## Evidence and timeline

Times below are Taipei time (UTC+8) on 2026-10-23.

| Time | Observation |
| --- | --- |
| 15:37:08 | Task created with `repodesk-landing` as its modification target. |
| 15:39:14 | First intake requested a pinned `repodesk` documentation source. |
| 15:53:19 | The user's continuation was persisted as answer revision 2. |
| 15:54:46 | Second intake returned the identical question. |
| 15:56–15:57 | Pi handled the user's target confirmation as conversation; it did not append a task input. |
| 15:58:29 | The instruction to send the task to Codex was persisted as answer revision 3. |
| 15:59:41 | Third intake returned the identical question. |
| 16:28:32 | A later user input specifying `docs/user` was recorded as revision 4. |
| 16:28:36 | Pi separately proposed reading unpinned `main` through the active task-conversation channel. |
| 16:30:32 | Codex answered that this proposal did not supply the required source or replace the application requirement. |
| 16:30:52 | Fourth intake returned the identical question and the task returned to `waiting`. |

The initial inspection caught the fourth attempt running. A follow-up read-only
inspection after the user's second screenshot confirmed its waiting outcome.
The investigation did not submit that input, send the task-conversation proposal,
or resume the task.

The second through fourth persisted attempt inputs contain the accepted answers. Their
reference context also contains the preceding questions and answers. Codex's
second result explicitly recognizes the continuation instruction, while reporting
that the required source is still absent. The three Telegram notices have separate
question IDs and confirmed message IDs: these are new executions producing the
same question, rather than delivery retries of one notice. The fourth also has
its own durable question ID.

Task activity shows that `/task` contains the prepared target repository but no
reference checkout. The target's `scripts/sync-docs.ts` reads a local source
checkout, enumerates `docs/user/`, and records its Git revision in a provenance
manifest. The existing manifest points to an older source revision; it does not
supply the current source files needed for a refresh. The final intake result
correctly identifies `repodesk` as a reference, not the modification target.

At inspection, the app, worker, PostgreSQL and Codex runner were healthy. Relevant
Pi runs completed successfully. The two continuation runs were bound to the task;
the intervening target-confirmation run was not.

## Cause

The coding handoff treats another remote source outside the prepared snapshot as
an application-side requirement and directs Codex to return `needs_input`.
However, the result protocol does not distinguish a product question for the user
from a missing source that the application must prepare.

`DevelopmentExecutor` converts a successful `needs_input` result into `waiting`,
generates a new question ID, and adds the instruction to reply. `appendDevelopment`
records an answer, clears the question and queues another intake when
`canImplement` is false. No reference source is prepared by that transition.
Consequently, the next attempt receives the answer but encounters the same
unchanged environment and returns the same blocker.

The displayed question asks whether the application can supply an execution
prerequisite. A user's confirmation cannot create that prerequisite. Repeated
confirmation therefore cannot resolve this task. Pi's additional request for a
documentation file list also does not address the observed blocker: Codex had
already identified the existing user-guide synchronization workflow.

The fourth attempt exposes an additional orchestration mismatch. The authenticated
input was only `docs/user`. Pi generated a separate technical proposal to read
the source directly from unpinned `main`, sent through `ask_development_task`.
The saved exchange confirms that the longer Telegram message beginning with
“Codex:” was the asynchronous answer to that proposal, while the following
question came from the fourth intake result. Both channels completed successfully.
The proposal did not add a reference checkout, and a Pi task-conversation message
cannot override the application's source-preparation constraints. Describing a
fallback therefore did not repair the prerequisite, even though the documentation
scope and modification target were already understood.

## Correction and recovery

The worker now resolves other selected repositories named in authenticated task
inputs independently of the modification target, verifies every contributor's
source read access, and pins their default branches before intake. A dedicated
Contents-read credential prepares exact-commit reference checkouts and is excluded
from durable runner/job data and Codex. The handoff supplies source paths and
provenance; verification rejects changed reference content. Source connection and
permission changes fence later execution and publication. Pi receives the source
and blocker state and cannot replace those requirements through task conversation.

The result protocol now separates source/environment blockers from user product
questions. An application blocker records an explicit failure without creating
another question or instructing the user to reply. Genuine product questions keep
the existing durable answer flow. Transient GitHub lookup failures retain queued
work for automatic retry before another model execution.

Deterministic coverage reproduces the original short source name and continuation
of a historical source question, source read-only grants, permission revocation,
lookup failures/recovery, credential isolation, duplicate dispatch and reference
integrity. Real Git proves that preparation selects the pinned commit despite a
newer branch tip. The full 1,177-test suite, focused collaboration/runner tests,
Biome, strict TypeScript, build and Node runtime contract passed. Task/supervisor
images built and passed the real Docker smoke with a new reference-source fixture,
plus the existing pinned sandbox/OCR proof and lifecycle checks. Compose configuration
validated. No dependency or migration was added.

Read-only VPS verification confirmed both incident repositories are selected and
the requesting actor has source read access. After deploying matching app/worker,
supervisor and task images, an authorized continuation of the waiting task prepares
the named source from its retained original inputs. Upgrading alone does not replay
the task. Preserve `repodesk-landing` as the only modification/publication target;
do not mark implementation authorized merely to bypass intake. Live model
interpretation and the deployed continuation remain unverified.

This investigation did not change production data, restart or deploy services,
resume tasks, send Telegram messages, or perform GitHub writes. The subsequent
correction remains local; no live recovery was performed.
