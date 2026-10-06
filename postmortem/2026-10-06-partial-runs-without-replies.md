# Partial model runs completed without Telegram replies

Date: 2026-10-06. VPS inspection was read-only.

## Impact and evidence

The user reported two requests receiving no reply. Runs
`9b22c784-04f8-42af-a810-a42a3d4fc2a2` and
`aeaa9534-88b8-4e9b-a531-a70fc99de94f` both had status `partial`, three model
attempts, a saved maximum of three turns, an empty result and no delivery.
The earlier greeting run `8193557e-609c-4003-8351-5abe77634483` succeeded and
was delivered, confirming that the configured transport could send replies.

The VPS app, worker, database and Codex runner were healthy. Worker logs recorded
the two runs completing at 01:44:17 and 01:45:55 UTC, without a subsequent
delivery event. Each model attempt ended with `toolUse`. The last turn called
`record_discussion`; no final assistant text was generated. The runs also used
chat/history retrieval and repository discovery. The `repodesk` lookup returned
zero matching repositories, and neither run started a coding task.

## Cause

`PiRunner` correctly stopped at the model-turn boundary and returned a partial
result. `Executor` created a result delivery only when `result.text` was nonempty.
A tool-only partial result therefore completed silently. The run stored no reason
to explain the partial state. This was generation exhaustion followed by a
missing notification, not a Telegram send timeout.

## Local correction

Partial runtime results now carry a reason (`turn_limit`, `output_limit`,
`incomplete_response` or `empty_response`). Empty final model replies also count
as partial. The executor records the reason and creates a durable, run-scoped
notice even when answer text is empty or whitespace. Existing approval notices
remain authoritative; authorization and fencing still gate delivery. Duplicate
jobs cannot replay the run or duplicate its notice.

Deterministic regressions cover three tool-only turns followed by exactly one
notice to the original chat/topic/reply, blank runner replies, pending approvals,
revocation and duplicate delivery handling. No live model call, Telegram send,
database mutation or deployment was performed during diagnosis. Applying the fix
to the VPS requires a release; the two old terminal runs remain unchanged.

## Validation

`bun run check` and `bun run build` passed. The full deterministic suite against
a disposable PostgreSQL instance reported 383 passes and two failures in
concurrently changed admin-access tests (duplicate Telegram identity and an
operator-access HTTP expectation). Both new completion/delivery regressions and
the runtime reason tests passed. A focused system-suite rerun reproduced the
same two admin failures while the new regressions passed again. Strict typecheck
reported two errors in the separately changing attachment/PDF implementation;
none were in this fix. These unrelated workspace changes were preserved.

Before committing, validated an isolated copy containing only this fix on top of
the concurrently committed admin-access correction. Lint, strict typecheck and
build passed; all 385 deterministic tests passed with disposable PostgreSQL.
Uncommitted attachment and UI changes were excluded from that validation.

See [debugging access and procedure](../docs/implementation/debugging.md).
