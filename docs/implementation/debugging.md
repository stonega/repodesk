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

If a group request has no run, check **Group access** first. Adding the bot to
Telegram does not bind the group to a workspace. Unbound group updates can be
received successfully with a null `inbox.workspace_id` and are ignored. Use
**Group access → New** to generate a one-use command, then send it in the intended
group as an active workspace member who is also a Telegram group administrator.
This panel flow does not require personal Telegram identity verification.
Wait for **Group linked** before testing `/ask@your_bot hi`. See
[the group-link example](../../examples/group-linking.http).

If `/ask@your_bot hi` works but plain `@your_bot hi` does not, check Telegram
privacy mode and the saved group's active state separately. Disabling privacy
requires removing and re-adding the bot. Removal marks the RepoDesk group inactive;
re-adding it in Telegram does not reactivate that link. Generate and send a fresh
**Group access → New** command, wait for **Group linked**, then recheck visibility
and retry the mention. Bot administrator access and message collection are not
required for this regular-member setup. See [the group guide](../user/groups.md).

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
- `coding_repository_target_unverified` means the tool's target quote was not
  present in the authenticated source text. For example, a user can name
  `componenthunt` while the tool incorrectly quotes `stonega/componenthunt`.
  Keep `repositoryId` bound to the connected repository and quote the original
  short name. Target mismatch/ambiguity errors also precede task creation; none
  establishes a GitHub outage. Correct the arguments rather than advising a retry
  after waiting or reconnecting.
- A completed intake result reporting sandbox startup failure can hide a shell
  tool error rather than a failed model turn or repository checkout. The shipped
  Docker restrictions block the pinned CLI's default bubblewrap namespace setup
  on the local reproduction host. Ordinary intake/analysis now select Landlock
  while retaining read-only/network denial; protected PR reviews retain their
  stronger split policy. Run the real sandbox probe in `scripts/codex-smoke.ts` on
  the affected host. See the [sandbox investigation](../../postmortem/2026-10-19-codex-intake-sandbox-startup.md).
- A Review Bot result asking to restore sandbox access with zero inspected files
  can be the bubblewrap namespace failure confirmed on VPS v0.1.42. Read the saved
  result separately from a later cancellation. Updated review/answer jobs disable
  native shell and use application-owned committed-source tools; rebuild the task
  image and run the real review source proof in `scripts/codex-smoke.ts` before
  rollout. No host namespace/security-policy relaxation is required. See the
  [review incident](../../postmortem/2026-10-20-review-bot-vps-sandbox.md).
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
- A Codex progress message saying upstream synchronization needs authentication
  can come from a redundant `git pull` inside the implementation container. A
  successful preparation does not install GitHub credentials for Codex; the
  application authenticates checkout and publication separately. Check the saved
  activity for `could not read Username` and the command that produced it before
  advising account reconnection. The corrected handoff names the pinned repository
  and commit and explains this boundary. A goal explicitly requiring newer remote
  source remains an application-side requirement, not proof of expired credentials.
  See the [redundant-pull incident](../../postmortem/2026-10-23-codex-redundant-git-pull.md).
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
- `coding_execution_failed` can also follow an externally terminated implementation
  container without a failure marker. Inspect its phase, exit code, `OOMKilled`,
  host shutdown journal and retained work before interpreting the generic message
  as a repository test failure. The 2026-10-18 landing task exited 143 during a VPS
  reboot after earlier browser problems; its four-file diff survived, but no final
  result, independent verification or publication was recorded. Follow-up host
  logs show a power-key event and power-off; Docker and persistent services did
  restart after the next boot. Task containers use `--restart=no`; the incident's
  runner build did not resume an externally terminated implementation. The prior activity
  gap and the actor behind the power event remain unexplained. See the
  [reboot incident](../../postmortem/2026-10-18-codex-task-interrupted-by-vps-reboot.md).
- `coding_execution_interrupted` on a new opted-in attempt means the runner has
  confirmed a job signal or non-OOM host interruption and retained its workspace.
  The application displays recovery, revalidates current access and reacquires
  credentials before resuming the same attempt. Busy slots, temporary access
  outages and account sign-in can delay recovery. Check the original task rather
  than creating duplicate work. Ordinary failures, old terminal records, expired
  work and uncertain publication are not replayed. See [runner recovery](codex-runner.md#lifecycle-and-recovery).
- `coding_base_branch_missing` means Git reported that the configured base branch
  does not exist during preparation. Confirm the saved branch in **Plugins →
  Codex → Repositories** and choose an existing intended branch before a new request.
  `coding_checkout_failed` means cloning failed for another reason; it does not
  prove that a branch is missing or permission was revoked. Both failures stop
  before Codex starts and return safe repository context to Telegram. Older builds
  preserve only `coding_execution_failed` for these failures.
- `coding_configuration_changed` checks the saved Codex revision, GitHub connection
  generation, target repository revision, destination and publication policy.
  New tasks retain these in `payload.githubScope`; unrelated repository changes
  can require a fresh permission sync but preserve the attempt. Target visibility,
  branch/name or connection changes still stop it. Older tasks without this
  snapshot use the shared GitHub revision, so another repository's metadata change
  can invalidate them. Compare the saved scope and current metadata, inspect work
  and publication state before retrying, and do not rewrite historical authority.
  See the
  [global revision incident](../../postmortem/2026-10-22-coding-task-global-github-revision.md).
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
