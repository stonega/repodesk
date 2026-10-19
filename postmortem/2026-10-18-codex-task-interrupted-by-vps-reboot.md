# Codex landing task interrupted by a VPS reboot

Incident: 2026-10-18. Investigation: 2026-10-19. Status: **diagnosed on the VPS;
recovery correction implemented and checked locally; deployment and historical
task recovery remain pending**.

## Impact

Task `278a45e5-fbb0-46b4-9cf3-b720eba308ea` requested removal of the decorative
arrow from `stonega/repodesk-landing`. It ended with `coding_execution_failed`,
displayed as “Implementation or repository verification failed.” The implementation
container was terminated during a host reboot. No independent verification or
publication phase was reached; the application has no PR recorded for this task.

The retained work volume contains four modified files: the walkthrough component,
its styles, a unit test and a browser test. There is no exported `result.patch`
or final `conversation.json`. These changes are unverified work, not a completed
checkpoint or a published result.

## Evidence and timeline

All times below are UTC on 2026-10-18; Taipei time is UTC+8.

| Time | Observation |
| --- | --- |
| 08:43:17 | Application task created. |
| 08:44:00 | Intake completed with implementation intent. |
| 08:44:24 | Work container started after successful preparation and setup. |
| 08:46:45 | Recorded command applied the arrow/style removal and regression tests. |
| 08:47:16 | Agent command running frozen install, lint, types, unit tests and build exited successfully. These are agent-run checks, not the runner's independent verification. |
| 08:48:44 | Browser execution failed after Chromium download; subsequent diagnostics identified missing system libraries. An earlier invocation also found `bunx` unavailable. |
| 08:50–08:51 | Agent extracted libraries into its writable home. Browser output then showed successful desktop and partial mobile checks, including the new desktop arrow check. This did not establish a full suite pass. |
| 08:51:34 | A browser subprocess reported exit 143. This precedes the host shutdown and is a separate termination; its initiator is not established. |
| 08:51:57 | Last retained Codex session event returned a running command session for another browser run with four workers. No later session event or final task result is retained. |
| 12:51:45 | Systemd-logind recorded `Power key pressed short.` followed by `Powering off...`. |
| 12:51:47 | Systemd began stopping Docker during host shutdown. |
| 12:51:49 | Implementation container exited with code 143; `OOMKilled` is false. |
| 12:52:02 | Systemd reached `poweroff.target` / `System Power Off`. |
| 13:05:00 | First retained kernel record of the next boot. |
| 13:05:02–13:05:05 | Systemd started Docker; the daemon restored the application services and completed initialization. |
| 13:05:10 | Runner recorded the implementation attempt as failed. |
| 13:05:38 | Application task persisted `failed` / `coding_execution_failed`. |

Evidence was read from the task-scoped application/attempt records, runner state,
container inspection, retained command activity, session event/tool metadata,
browser artifacts and host journal. Model reasoning, credentials and unrelated
conversation content are excluded from this report.

The implementation attempt is `cac67347-7fd3-4787-b255-1bd204666033`; its Docker
resource prefix is `deepx-codex-f15a016ac4e20b2340db4b0cf2c286d6`. The final browser
artifact reports 14 failed test IDs. Available error contexts include browser
target crashes, closed browser contexts and page-setup timeouts. These artifacts
do not establish whether resource exhaustion or another browser problem caused
those failures.

## Cause and limits

The **terminal failure is established**: Docker stopped during the VPS shutdown,
terminating the still-active implementation container with SIGTERM (exit 143).
The task container has no restart policy. On reconciliation,
`RunnerSupervisor.advance` classifies a nonzero implementation exit without a
recognized failure marker as `coding_execution_failed`. No safe failure marker
or final result survived this externally terminated execution. The application
therefore shows the generic implementation/verification message, rather than an
infrastructure-interruption reason. Its `verifiedRevision` remains zero.

Browser setup and execution were already problematic before shutdown, but they
did not themselves produce the terminal application failure. The missing-library
workaround progressed to passing tests; the final rerun still left failed browser
artifacts. The roughly four-hour gap after the last session event is unexplained:
there is insufficient evidence to attribute it to a provider wait, command hang
or adapter failure. No provider-limit or authentication failure was recorded.

Follow-up inspection establishes a power-key event, orderly **power-off**, and a
subsequent boot with a newer kernel. This was not just a Docker daemon crash.
The guest journal does not identify the person or infrastructure action behind
the power-key event, or what powered the VPS on again approximately thirteen
minutes later. Provider/hypervisor event history is needed to attribute those
actions. Stopping an unattended upgrade service during shutdown is not proof
that unattended upgrades caused it. Task stdout cannot fill these gaps because
its Docker logging driver is `none`.

## Why services restarted but the task did not

Read-only inspection on 2026-10-19 confirmed that `docker.service` is enabled,
active and configured with systemd `Restart=always`. The next boot started it
at 13:05:02 UTC; initialization completed at 13:05:05. The application, worker,
PostgreSQL and Codex supervisor all have Docker `unless-stopped` restart policies
and resumed at approximately 13:05:03. The daemon and persistent services did
restart automatically.

The task implementation container has `RestartPolicy.Name=no` and
`RestartCount=0`; its start time remains 08:44:24 and its final state remains
`exited` / 143. `containerArgs` explicitly supplies `--restart=no` for task phases.
This matches Docker's documented behavior: the `no` policy never automatically
restarts a container. See [Docker's restart-policy documentation](https://github.com/docker/docs/blob/main/content/manuals/engine/containers/start-containers-automatically.md).

In the incident build, the supervisor's `initialize` reloads durable records. Its five-second `sweep`
and status reads inspect the original container through `advance`; they do not
restart an exited implementation. In this incident, the nonzero exit caused
`failed` / `coding_execution_failed`. Later sweeps skip terminal records. The
implemented recovery can observe a task container that survives a supervisor
restart, but does not resume this externally terminated implementation after a
host power cycle.

Automatic Docker restarts would rerun a phase's entrypoint using its old input.
The common task policy also covers preparation, checks and publication. A proper
recovery implementation must distinguish interrupted work from cancellation,
ordinary failures and uncertain publication, then recheck authorization and
credentials before resuming the retained work. Enabling automatic restarts for
all task phases does not provide those checks.

## Recovery and prevention work

Investigation was read-only on the VPS. App, worker, database and runner were
healthy when inspected. No task was resumed, record altered, PR published or
service restarted during this investigation.

Before recovery, preserve the retained four-file diff within the authorized
task's private scope; an exported checkpoint is absent and retention still applies.
Recover through an explicitly authorized execution that reruns complete checks
and independent verification before publication. Do not mark the old task
successful or treat the partial browser output as verification.

The following follow-up work remains outside this correction:

- Provide a repeatable, unprivileged browser environment and consistent Bun CLI
  entry points so each task does not need to discover missing libraries.
- Make a long absence of task activity observable without inventing a provider
  error, silently restarting work or weakening the verification gate.

## Local recovery correction (2026-10-19)

New continuous coding attempts opt into interruption recovery. Each phase has an
execution identity and the job records SIGTERM with that identity. A changed
Docker host boot ID with a confirmed non-OOM signal exit supplies fallback evidence.
Known failure markers and publication are excluded. The supervisor persists
`interrupted`, releases capacity, seals any current account cache and removes its
temporary auth volume. The worker checks current task/source/repository authority
and obtains fresh credentials before a recovery-ID-bound resume of the same
attempt and work volume. Partial preparation clones can be recreated; partial
implementation and frozen independent checks survive. Missing model usage is
explicitly unknown.

Duplicate requests and lost acknowledgements cannot start another recovery.
Running work is adopted after supervisor restart; ambiguous created/missing
containers remain unknown. Stop, account disconnect, current permission loss,
expired checkpoints and uncertain publication continue to block resumption.
Historical failures are not automatically restarted. Recovery edits the existing
Telegram progress message, and its admin status retains Stop.

Local validation includes deterministic runner/application tests, desktop/mobile
browser checks and a real Docker fixture that terminates an executing job with
SIGTERM, restarts the supervisor twice, verifies retained partial work and passes
independent checks before `ready`. Application, supervisor and task images built;
the application image passed the Node 24 runtime contract and Compose validated.
No production service, account or historical task was changed. A real host power
cycle and live Telegram rendering remain staging acceptance checks. See the
[repeatable fixture](../examples/codex-interruption.md).
