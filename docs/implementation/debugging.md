# Debugging RepoDesk

## VPS access

Operator-provided SSH destination, recorded at the user's request on 2026-10-06:

```sh
ssh root@169.58.58.71
```

Admin site: `https://dev.stonegate.me`. Deployment directory: `/opt/repodesk`.
Compose project: `repodesk`. Observed containers: `repodesk-app-1`,
`repodesk-worker-1`, `repodesk-postgres-1`, `repodesk-codex-runner-1`.
Use the existing SSH credentials and verified host key; keep credentials,
encryption keys, private messages and database dumps out of debugging reports.

## Missing Telegram replies

Start with a run ID from **Runs & delivery**. Check run status, `error`, model
attempts, transcript roles/stop reasons, answer length and delivery state.
Read only the relevant workspace and runs. Summarize tool names and outcomes;
avoid dumping full workspace JSON, credentials or chat history.

```sh
ssh root@169.58.58.71 'docker ps --format "{{.Names}} {{.Status}}"'
ssh root@169.58.58.71 'docker logs --since 30m --tail 200 repodesk-worker-1'
```

Interpret the states separately:

- `partial` with an empty result and no delivery can indicate the older silent
  completion bug documented in the [2026-10-06 incident](../../postmortem/2026-10-06-partial-runs-without-replies.md).
- `turn_limit` means all allowed model turns were consumed before a final answer.
  Tool calls consume turns too. Check redundant retrieval and tool failures before
  deciding to increase **Workspace settings → Maximum model turns** and its budget.
- `tool_limit` on older builds means the chat assistant attempted a ninth tool
  call, even if model turns and budget remained. Normal workspace requests now
  have no fixed tool-call count limit; model-turn, spending, timeout, cancellation
  and permission checks still apply. A model turn can contain several tool calls.
  Explicit internal/evaluation caps retain a specific limit failure message.
- No matching connected repository means the coding request has no resolved
  target. Use its full connected repository name; confirm workspace selection and
  actor grants. Do not assume a coding task started.
- A `start_development_task` failure with no task record can be a policy mismatch,
  before GitHub is contacted. **Reviewed** (also the default when omitted) needs
  `propose_coding_task` and Telegram approval; only **Direct** supports the start
  tool. Older builds hide `coding_direct_execution_disabled` as
  `extension_tool_failed`. See the [routing incident](../../postmortem/2026-10-06-codex-reviewed-direct-routing.md).
- `github_app_permissions_missing` means GitHub rejected a scoped installation
  token because its requested permissions are not granted. Verify the App and
  installation both allow Contents and Pull requests read/write for Codex
  publication, plus Issues write for the Reviewed issue workflow. Contents read
  alone can read the checkout while a Direct token (also requesting Pull requests
  read) or publication token still fails. Older builds report this as
  `github_unavailable`. Changing execution policy does not add GitHub permissions.
- `coding_intent_unverified` means the completed intake result did not quote the
  consumed authenticated input at its recorded revision. This occurs after
  repository preparation and Codex execution; it is not a GitHub reachability
  error. Older runner builds allowed a narrative evidence field, causing short
  retries to stop. Updated intake schemas pin the current text and revision while
  preserving the guard. See the [evidence incident](../../postmortem/2026-10-06-codex-intent-evidence.md).
- Repeated Codex requests for a screenshot can indicate the text-only task
  handoff, even when Pi has received the image. Check source attachment metadata,
  Pi transcript image-block counts and the task's persisted attempt inputs without
  dumping image data. In the incident's 0.1.21 build, initial task inputs omit attachments, Codex turns
  contain only text, and photo-only or captioned task answers bypass task routing.
  The 0.1.22 correction passes authorized media to Codex and routes photo-only
  answers to the bound task. Update app, worker, supervisor and task image together. See the
  [screenshot incident](../../postmortem/2026-10-06-codex-screenshot-handoff.md).
- `coding_execution_failed` on v0.1.20 can hide an implementation app-server or
  completed-result error. The old device-auth cleanup removed its session logs
  without persisting a safe failure marker. A task's token total equaling its old
  quota can represent missing usage, not an actual provider token-limit error.
  The updated adapter records a specific safe code plus reported usage and thread
  identity before cleanup. Provider usage/rate limits, connection failures,
  rejected requests, context overflow, sandbox errors and missing/invalid results
  are distinct; raw provider messages are never recorded. See the
  [implementation failure incident](../../postmortem/2026-10-06-codex-implementation-failure.md).
  An operator-authorized live VPS retest on 0.1.21 completed the same wallshader
  request with 694350 reported tokens and passing repository checks; this workload
  would exceed the removed 200000-token guard.
- `coding_base_branch_missing` means Git reported that the configured base branch
  does not exist during preparation. Confirm the saved branch in **Plugins →
  Codex → Repositories** and choose an existing intended branch before a new request.
  `coding_checkout_failed` means cloning failed for another reason; it does not
  prove that a branch is missing or permission was revoked. Both failures stop
  before Codex starts and return safe repository context to Telegram. Older builds
  preserve only `coding_execution_failed` for these failures.
- `coding_result_invalid` means the final JSON failed application validation.
  The updated runner generates field constraints from the validator and allows
  one read-only result correction before stopping. Inspect `resultIssues` in the
  runner status/state or the task's tenant-scoped `coding_task_attempts.data`.
  `too_big` identifies an overlong field, `invalid_type` a missing/wrong type,
  and `custom` on `verificationCommands` or `question` an unmet status-specific
  requirement. Diagnostics contain only known field paths and issue codes, never
  rejected text. Old attempts without these details cannot identify the exact
  rejected field after temporary session cleanup. See the
  [final-result incident](../../postmortem/2026-10-07-codex-final-result-validation.md).
- Repeated check/repair cycles without a terminal error can indicate a malformed
  frozen verification plan. Inspect only the task's runner `verificationCommands`
  and sanitized `/task/check-diagnostics`; compare actual command length with the
  2,000-character schema limit and confirm that the plan includes repository checks.
  A missing argument in a frozen setup command cannot be fixed by ordinary source
  repair. Use a repository script for longer preparation/check logic, and preserve
  the checkpoint before operator-authorized recovery with a fresh plan. See the
  [progress/verification incident](../../postmortem/2026-10-07-progress-flood-and-invalid-verification.md).
- `coding_runner_unavailable` means runner communication or engine reconciliation
  failed; it does not establish an implementation failure. During the 2026-10-06
  release, the old worker remained active while the runner was replaced and marked
  an already verified task failed before its queued follow-up could start. Check
  attempt `checkPassed`, saved checkpoint and container creation times before
  starting another task. The updated deployment waits for checkpoints and stops
  writers before replacing the runner; temporary outages and checkpoint cleanup
  acknowledgements remain retryable. See the
  [deployment handoff incident](../../postmortem/2026-10-06-codex-deployment-handoff.md).
- A pending delivery is queued separately from generation. A failed delivery has
  a Telegram or policy error. An unknown delivery must be inspected before any
  resend, because Telegram might already have accepted it.

The local fix creates a durable notice when an addressed run finishes without
answer text, including the specific limit when known. Pending approvals keep
their existing delivery flow. Duplicate run jobs do not create a second notice;
revoked actors cannot receive a new delivery. Empty notices are not saved as model
answers or committed as discussion memory. Old terminal runs are not replayed.

SSH inspection does not itself authorize deployment, configuration changes or
manual Telegram messages. Follow the [VPS release runbook](vps-deployment.md) for
an authorized rollout.
