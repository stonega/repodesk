# Recovering an interrupted coding task

The deterministic Docker fixture uses a local Git repository and fake Codex/GitHub
implementations. It sends no Telegram messages, paid model requests or GitHub
writes. Run it against a local Docker daemon with the source's matching images:

```sh
docker build --target codex-job -t repodesk-codex-job:interruption-verify .
docker build --target codex-supervisor -t repodesk-codex-supervisor:interruption-verify .
CODEX_SMOKE_JOB_IMAGE=repodesk-codex-job:interruption-verify \
CODEX_SMOKE_SUPERVISOR_IMAGE=repodesk-codex-supervisor:interruption-verify \
NO_PROXY=localhost,127.0.0.1 bun scripts/codex-smoke.ts
```

The interruption scenario starts an opted-in task, writes partial work and sends
SIGTERM to that fixture's job container. After supervisor restart, status must be
`interrupted` with a durable `recoveryId`. A management-authenticated
`POST /tasks/:workspace/:attempt/resume-interrupted` supplies that ID and a fresh
provider key. A repeated request after another supervisor restart must not create
another execution. The fake agent asserts that the partial work survived; the
runner's independent checks must pass before status becomes `ready`. Fixtures
remove their own containers, networks and volumes afterward.

The application integration tests separately exercise actor/source revocation,
Stop, live-token authorization races, credential replacement, busy/uncertain
recovery responses, sign-in recovery and refusal to replay publication:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
NO_PROXY=localhost,127.0.0.1 bun test tests/integration/development.test.ts
bun test tests/unit/codex-interruption.test.ts tests/unit/codex-runner.test.ts
```

Use a disposable test PostgreSQL instance for the integration command. The
runner unit cases also simulate a changed host boot ID with a missing signal
marker, OOM, stale recovery identities, retention expiry, capacity waits and
uncertain container creation. The fixture does not reboot the host or restart its
Docker daemon. Those remain separate staging acceptance checks.

Production recovery is application-owned: its private resume request follows
current task authorization and live repository checks. A saved work directory,
HTTP management credential or repository file does not independently grant
permission to resume. Existing failed tasks without interruption evidence and
uncertain publication are never bulk-replayed.
