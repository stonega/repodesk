# Repository tasks, releases and preference correction

These examples use ordinary Telegram text after selecting a repository and
configuring Codex. Investigation/release tasks, preference derivation and Pi/Codex
preference recall are enabled by default. No extra activation is needed. A
workspace owner/admin can restore defaults after an explicit disable:

```text
Configure repository tasks: example/project investigation=true release=true
Configure preference learning: derive=true recall=pi_and_coding
```

Try an investigation, then explicitly change the same task's objective:

```text
Use Codex to explain example/project's release procedure
Prepare release example/project v1.2.0 following docs/release.md
Release example/project v1.2.0 following docs/release.md
```

Preparation reports a verified manifest without external publication consent.
The release request is a new authenticated input revision. A merge or CI wait
keeps the task identity while releasing Codex. Supported effects are version tags,
GitHub Releases and bounded assets; required npm/deployment steps block completion.
Only use a disposable pilot repository for real publication.

Preference commands use the returned exact ID and revision:

```text
Remember preference: In example/project, use concise routine summaries
What preferences do you remember with their evidence?
Correct preference pref:REPLACE_ID: In example/project, explain failures in detail
Add preference exception pref:REPLACE_ID: Include all reproduction steps for regressions
Forget preference pref:REPLACE_ID
```

Deterministic verification, with a disposable PostgreSQL URL:

```sh
bun test tests/unit/repository-objectives.test.ts tests/unit/release-artifacts.test.ts tests/unit/preferences.test.ts
TEST_DATABASE_URL=postgres://fixture:fixture@127.0.0.1:5432/fixture bun test --timeout 30000 tests/integration/development.test.ts tests/integration/long-term-memory.test.ts
bun run build
node dist/runtime-contract.js
```

The integration fixtures use injected GitHub/model/runner transports. They cover
process reconstruction, empty-patch preparation, exact manifest matching, merge
and CI waits, explicit capability revocation, old protocol rejection, uncertain write readback,
candidate-only derivation, immutable corrections and forgotten coding context.

Build the current `codex-job` and `codex-supervisor` Docker targets before the
container smoke. This executes the real pinned sandbox probe and then fake
Codex/GitHub fixtures; it makes no live model or GitHub request:

```sh
docker build --target codex-job -t localhost/repodesk-repository-job:verify .
docker build --target codex-supervisor -t localhost/repodesk-repository-supervisor:verify .
CODEX_SMOKE_JOB_IMAGE=localhost/repodesk-repository-job:verify CODEX_SMOKE_SUPERVISOR_IMAGE=localhost/repodesk-repository-supervisor:verify bun scripts/codex-smoke.ts
```

The release case verifies an ignored built asset and committed guide through the
real trusted export container, accepts an empty patch, checks the pinned commit
and survives a supervisor restart before erasure.
