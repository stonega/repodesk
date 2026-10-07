# Codex final-result validation stopped a card UI task

Date: 2026-10-07. Investigation: read-only VPS inspection and local deterministic
validation probes. Task: `ee3780ce-9a74-464f-87c9-a20be6ceab74`.
Implementation checkout: `3ad3defeedcb5218c79b41126a6a98253cf57cc5`
(the v0.1.24 release commit).

## Confirmed outcome

The request to improve the “Update connected services” card reached Codex with
one image. Intake succeeded. The implementation made changes to four files, but
the conversation adapter rejected its final result with `coding_result_invalid`.
The task failed before the supervisor launched independent verification or
publication. No PR is recorded, and verified revision remains zero.

Times below use Asia/Taipei (UTC+08:00), matching the reported screenshots.

| Time | Evidence |
| --- | --- |
| 10:20:36 | Application task created. |
| 10:32:29–10:33:04 | Successful intake attempt; 59,494 reported tokens. |
| 10:33:17 | Implementation runner attempt started. |
| 10:42:00 | Job wrote `failure-code` and `conversation-failure.json` with `coding_result_invalid`. |
| 10:42:02 | Runner and application task recorded failure; implementation reported 2,415,320 tokens. |

The task totals 2,474,814 reported tokens with `usageUnknown: false`. These are
reported usage, not evidence of a quota failure or a dollar cost. The implementation
ran for approximately eight minutes and 45 seconds.

## Failure mechanism and evidence limit

[The conversation adapter](../src/coding/local/conversation.ts) waits for a
completed turn, requires nonempty final text, parses JSON, then calls
`developmentResult.safeParse`. A failed parse becomes `coding_result_invalid`.
The retained job-side failure marker establishes failure in that adapter, rather
than later supervisor validation. It establishes that the final text was valid
JSON but did not satisfy the application's result validator.

The exact rejected field cannot be recovered from the retained artifacts. The
adapter discards `parsed.error.issues` and the rejected value. The job persists
only the allowlisted code, thread ID and usage. It writes `conversation.json`
only after successful validation. Device-code execution places Codex sessions
under the temporary `/auth` volume, which the supervisor removes on exit.
The implementation container and auth volume are absent. The retained work
volume has no final conversation result or verification plan.

## Confirmed contract defect, not a proven field-level trigger

[The output schema and runtime validator](../src/coding/development.ts) have
different constraints. The schema sent to Codex omits string length limits,
nonnegative evidence revisions, the requirement for a nonempty question when
asking for input, and a nonempty verification plan when reporting completion.
It permits outputs the runtime validator rejects.

Local deterministic probes demonstrated rejection of three otherwise ordinary
result envelopes permitted by the sent schema: `completed` with an empty
verification array, a verification command longer than 2,000 characters, and a
title longer than 200 characters. A valid control result passes.

This proves a defect that can produce this failure. It does **not** prove that
any of those three fields triggered this specific production attempt. Missing
or invalid fields are not distinguishable after the diagnostic information was
discarded.

## Retained implementation and recovery boundary

The work checkout remains on the VPS. Its unstaged changes cover
`docs/design/admin-panel.md`, `tests/browser/site-domain.e2e.ts`,
`web/site-domain.tsx` and `web/style.css`: 246 insertions and 71 deletions.
No exported `result.patch` exists because result validation failed before export.
A browser test artifact says `passed`, but this alone does not establish which
tests ran or satisfy the application's independent verification gate.

Do not describe the implementation as verified or published. Recovery can inspect
and preserve the retained changes, then obtain a valid completion envelope and
run normal checks under current authorization. This investigation did not resume
the task, call a model, publish changes, deploy, or send Telegram messages.

## Recommended correction

- Keep the output schema and runtime constraints aligned, including status-specific
  requirements and supported string/array bounds.
- Retain bounded validation issue codes and allowlisted field paths before cleanup,
  excluding rejected values, prompts, provider messages and credentials.
- Consider bounded result-correction turns that preserve the checkout, current
  permissions and any fixed verification plan. Independent checks and publication
  authorization must still succeed before a task is complete.

## Subsequent authorized source correction

The user requested a fix after the investigation. Result field schemas now derive
from the Zod validator, including string, number and array bounds. Status-specific
rules remain runtime checks with named issue paths and schema descriptions because
the [supported output schema](https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas)
does not support root unions or conditional composition.

Missing output, malformed JSON and invalid result fields receive one read-only
result-correction turn in the same live thread and checkout. The same output
schema is supplied again, and the correction prompt preserves authorization,
schema-pinned evidence and fixed checks. Failed provider/auth/execution turns are
not replayed through this path. Independent verification and publication gates
remain required after corrected output.

Allowlisted issue codes and field paths persist through the job failure marker,
supervisor status/state and fenced tenant attempt record. No rejected values or
private keys enter these diagnostics. Usage includes both turns and preserves
unknown reporting through authentication pauses. Adapter and supervisor share
a 512 KiB result capture bound that accommodates the allowed Unicode/JSON fields.

Deterministic tests cover field limits, correction success/exhaustion, cancellation,
authentication interruption, replayed events, cumulative/unknown usage, diagnostic
privacy, restart/erasure and attempt persistence. The pinned Codex protocol proof
uses a local fake provider; no paid model or live GitHub/Telegram call is made.
Production rollout and recovery of the original stopped task remain separate.

Verification for this correction: lint, TypeScript, build, all 511 tests with an
isolated PostgreSQL database, Node runtime checks, the real pinned Codex protocol
proof against a fake provider, and Docker job/supervisor lifecycle smoke passed.
The host proxy initially broke eight local HTTP fixture tests; rerunning with the
documented localhost `NO_PROXY` bypass passed the full suite.
