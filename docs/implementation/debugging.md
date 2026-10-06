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
- `coding_execution_failed` on v0.1.20 can hide an implementation app-server or
  completed-result error. The old device-auth cleanup removed its session logs
  without persisting a safe failure marker. A task's token total equaling its old
  quota can represent missing usage, not an actual provider token-limit error.
  The updated adapter records a specific safe code plus reported usage and thread
  identity before cleanup. Provider usage/rate limits, connection failures,
  rejected requests, context overflow, sandbox errors and missing/invalid results
  are distinct; raw provider messages are never recorded. See the
  [implementation failure incident](../../postmortem/2026-10-06-codex-implementation-failure.md).
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
