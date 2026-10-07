# Repository reports, conversation skills and work handoffs

Accepted for local implementation by the user on **2026-10-07**. This implements
R01–R03 from the [launch research](../research/every-agent-features.md#recommended-additions).
Live provider evaluation and deployment remain separate release steps.

## Delivery plan

| Slice | Result | Acceptance |
| --- | --- | --- |
| 1. Repository reads | Read-only issue/PR lists and item status with dates, reviewers, canonical URLs, paging and incomplete-coverage disclosure | Selected repository and current actor access checked before and after HTTP; no write token; missing permissions, cancellation and partial pages handled |
| 2. Repository schedules | Existing daily/weekly workflows can pin repository sources and connection revision | Preview names repositories and destination; private repository group reports require an admin; grants rechecked at activation, dispatch, reads and delivery; duplicate/missed occurrences retain existing behavior |
| 3. Conversation skills | Read an accessible completed run, propose a sanitized skill, approve a disabled catalog draft, then admin publish/enable | Another user's private run is inaccessible; source edits/removal revoke proposals and derived drafts; duplicate approval/tool replay creates one draft; existing workflow versions stay pinned |
| 4. Work handoff | Query current task/checkpoint/question/PR and retained discussion decisions/todos | Private requests aggregate the actor's own work; group requests remain in the current topic; coding access, source retention and output scope rechecked; no guessed remote merge status |
| 5. Product integration | Agent instructions, workflow editor, skill provenance and runnable examples | Features discoverable in ordinary Telegram requests; existing workspaces gain app-owned tools without rewriting custom skill permissions |
| 6. Verification | Deterministic unit/integration tests, browser checks for changed forms, required repository checks | `bun run check`, `bun run typecheck`, `bun test`, `bun run build`; no live Telegram, GitHub or model calls |

## Contracts

Repository queries use the existing GitHub App registry and repository ID selection.
Tokens request only Issues/Pull requests read permissions for one repository.
Lists have bounded page/output sizes and report whether the result is complete.
Merged PR windows use `merged_at`, not `closed_at`; issue lists exclude PRs.
Default repository report ranges are previous complete local calendar days in the
schedule's timezone, including DST transitions. Explicit ISO query ranges override
the default. Individual descriptions disclose bounded excerpts.
Titles and descriptions are reference data. Metadata alone does not prove user impact
or that checks passed. Existing Apps may need permission approval in GitHub.

Workflow repository sources are an explicit optional schema field. The approved
payload pins selected IDs and connection revision; edits need a new approval.
Group approval explains the audience, and only a workspace admin can authorize a
private repository report there. Ad-hoc private repository reads stay in private
chat; group scheduled reads are restricted to their approved repositories.
Repository access and group publication permission are independent checks.

Skill proposals refer to one completed run accessible to the actor. The model drafts
the procedure, inputs, output format and an example, rather than copying a full
transcript. The requester reviews the full content and explicitly consents to an
admin-visible team draft. Approval creates a disabled, unpublished skill; current
admin publication controls make it available to teammates. Requested tool names
cannot grant executable extensions or repository rights. Provenance and source hashes
remain attached. Source edits/removal invalidate pending proposals and unpublished
drafts; privacy cleanup removes their derived content. Admin publication approves
a standalone reusable procedure: it remains until edited or archived, like other
approved instructions, while provenance marks that the original source expired.
The existing Test control remains a deterministic policy preview.

Handoff queries read application records: assistant runs, reviewed coding tasks,
continuous-development tasks and discussion summaries. They return confirmed state,
retrieval time, next action, waiting question and verification/PR evidence when present.
Personal briefs include only the actor's tasks and personal discussions; group briefs
include only the current group/topic and require current coding authority. Reads
record source/scope dependencies so revocation or erasure also blocks a queued answer.
They do not scan personal agent directories or change task state.

Keep the standalone architecture, existing JSONB records and relational coding tasks.
Use additive optional fields so old records remain readable. No dependency is needed.
Preserve existing edits in the working tree, especially deployment and Codex execution.

## Implementation status

All six slices are implemented locally. API tokens request read permissions only;
source/destination/actor dependencies are rechecked for queued output. The skills
and workflow forms reuse existing controls. Handoffs read tenant-scoped relational
tasks in batches and register all input/context dependencies, including indirect
repository evidence from older assistant reports.

The added tool definitions exposed a long-conversation compaction regression.
Descriptions were condensed; after completing a bounded summary batch, the same
run uses an 85% retrigger threshold (initial trigger remains 80%). Provider context,
output, turn and dollar limits remain enforced. This prevents a needless second
summary from consuming the turn reserved for an answer.

These features add no dependency or migration. No deployment or live provider write occurred.
Biome, strict TypeScript, build, all **502 deterministic tests** with disposable
PostgreSQL and the built host Node runtime contract passed. **19 browser scenarios**
passed, including repository-source editing and conversation-skill publication with
desktop/mobile inspection. See [implementation evidence](implementation-status.md).
The final pass also preserves concurrent membership/GitHub account changes in the
working tree; the feature code uses the current shared authorization helpers.
Live semantic usefulness, multi-page report quality and teammate skill reuse remain
pilot acceptance in [the examples](../../examples/team-workflows.md).
