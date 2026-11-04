# Progress requests interrupted private Browser work

## Impact and evidence

Read-only VPS inspection on 2026-11-04 found four runs in the reported private
Topic. The original 2026-11-01 request and its “continue” turn had ended `partial`
with `browser_request_expired`. A 2026-11-04 retry retained its own browser goal,
but “what is the progress” created another run. That run queried history, opened
SnapYT again, filled the URL and requested another Submit approval. The original
retry then waited for control held by the progress run. No successful download
was recorded in the inspected tool results.

One earlier approved Submit returned `browser_destination_denied` and was retained
as an unknown action outcome. The available evidence does not establish whether
SnapYT could ultimately produce the requested video, or identify that denied
destination as a required site rather than an optional resource.

The original retry was `92c9022b-08cd-43dd-9e1a-5118a7a04551`; the competing
progress run was `a676942b-bf6a-41e7-8f92-654617acbb5d`. Tenant scope was
`3b2dfe82-61c6-444e-8058-7a179f2bf27a`. The operator's SSH route failed, so the
existing self-hosted diagnostic workflow was used in status mode with a read-only
database transaction. Only scoped metadata, action kinds, safe origins and fixed
codes were emitted. Private bodies were decrypted in memory and never printed.
See [metadata inspection](https://github.com/stonega/repodesk/actions/runs/41768494330)
and [scoped tool/control trace](https://github.com/stonega/repodesk/actions/runs/41768919776).

The VPS app, worker and Browser were healthy on release
`1793614570991-61029298`; the newer continuation-confirmation commit had not been
deployed. Production state, site consent and browser actions were not changed.

## Causes

- Ordinary input during `awaiting_approval` created another assistant run. Live
  input joining covered active generation, while natural progress requests did
  not have a Browser task control path.
- Browser leases and generation fencing protected individual operations, but did
  not prevent a second assistant turn in the same Topic from becoming a browser
  controller after the earlier lease expired. A status request could restart the
  form and block the original goal.
- All wait types used the same generic text. Expiration changed a Pi run to
  `partial` without a durable human explanation.
- Denied-origin recovery handled navigation more completely than approved
  controls. Replaying a stored unavailable operation could incorrectly return
  `completed`, despite not dispatching it again.
- A download manifest alone did not prove that the saved file still existed with
  its recorded size. A completed page interaction was insufficient evidence of
  task completion.

## Corrections

Private task controls are scoped to current workspace/member/bot/Topic authority.
Recognized short English/Chinese status and continuation inputs inspect the
existing task without another run. Pending consent is not granted by “continue”.
An explicit retry of expired Pi work preserves the original goal/transcript,
records the new authenticated input and requests fresh decisions. Denied,
cancelled, uncertain or revoked work is not implicitly revived. Intervening
unrelated work is not redirected into an older expired Browser task.

The broker now records actual Browser participation separately from inherited
private history. Concurrent observers are durably bound to the original task and
cannot take over, navigate, fill or create approvals; the restriction persists
after its completion or service reconstruction. Other Topics retain the explicit
handoff contract. Wait messages distinguish their kind and safe origin/operation;
terminal waits receive idempotent feedback. Delayed requested status refreshes its
facts, while obsolete terminal notices remain fenced.

Review regressions also cover retryable Telegram rate limits and continuation
checkpoints. Requested status remains refreshable across confirmed-safe retries,
including adding or removing the Browser link as the task changes state. A
continuation records the actual human input while retaining the current goal for
later approvals and secure-input labels, including earlier queued goal edits.
A final durable refresh also covers a task transition between delivery claim and
dispatch. Regressions reproduce the former lost reply and verify that revocation
still cancels it before transport. Fixed terminal notices retain their fences.

Denied approved interactions retain bounded origin diagnostics and the current
session. Unavailable operation replay stays unavailable, without repeating the
effect. Guidance requires inspection before a new decision and excludes optional
autofill/analytics/advertising origins from automatic consent requests.

Download copying uses a bounded owner-private stream. Empty, oversized or failed
copies are removed, and fixed failure codes replace silent failure. Completion
metadata requires an authorized nonempty regular file with one link and the
recorded size. The model must verify native download evidence rather than infer
success from a click, link or page banner. These checks establish a saved file;
they do not independently prove that arbitrary downloaded content is a playable
video or guarantee that a third-party downloader supports every video.

## Regression and release boundary

Three production-composition regressions fail against the prior `main`: progress
creates no competing run, an arbitrary observer cannot steal an expired lease,
and expired action feedback/retry retains the original run with fresh approval.
They pass with the correction. Further checks cover observer persistence, refreshed
status, stale notices, actor/Topic/bot/revocation/forward boundaries, failed receipt
replay and invalid/partial files. Real-DOM tests exercise an approved cross-origin
control and a real local HTTP download through verified artifact retrieval.

Final validation passes lint, strict TypeScript, build, 1,423 deterministic tests
across 151 files and all 17 focused browser scenarios. The built Node runtime
contract passes 16 startup cases with zero external startup calls. Code Truth
catalog regeneration produces no diff and the service smoke passes.

No production task was resumed or approved during this work. Native Telegram
desktop/mobile rendering, the exact packaged headed-host smoke and a coordinated
app/native-host VPS rollout remain release checks. Historical records are not
automatically rewritten, cancelled, merged or replayed.
