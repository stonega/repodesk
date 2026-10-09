# Automation

- `build.ts`: backend Node entry points and React Router assets.
- `operator.ts`: host-only password recovery.
- `register-webhook.ts`: explicit opt-in staging webhook reconciliation.
- `evaluate.ts`: explicit, spend-capped live model evaluation; never run by normal checks.
- `runtime-contract.ts`: fake-provider Pi contract under Node; no credentials required.
- `open-code-review-smoke.ts`: offline OCR preparation in a prebuilt `codex-job` image; exact refs, exclusions, rules and preparation failure, with disposable Docker volumes and no credentials. Run `bun scripts/open-code-review-smoke.ts IMAGE_TAG`.
- `backup.sh`: protected PostgreSQL custom dump through Compose.
- `restore-rehearsal.sh`: restore into a disposable sibling DB, verify, remove it.
- `start-local.sh`: start the configured local Podman stack; pass `--build` to rebuild images.
- `deploy-vps.sh`: release-bundle host cutover with locking, backup, migrations and readiness checks; see [VPS deployment](../docs/implementation/vps-deployment.md).
- `update-host.mjs`: dependency-free Node host daemon for approved panel updates; verifies GitHub release/CI identity, builds pinned Docker images and invokes the protected cutover. See [installation](../docs/implementation/updates.md).

`src/db/migrate.ts` is the one-shot schema/job migration entry point. No ordinary
startup command registers webhooks, connects accounts or starts paid evaluations.
See [setup](../docs/implementation/setup.md) and [runbook](../docs/implementation/release-runbook.md).

## Skills UI verification

`bash scripts/verify-skills.sh` prepares dependencies and runs the required quality,
type, database, build and Node runtime checks plus the skills, team-workflow and
admin browser suites. It targets Debian 12 x86-64 with Bun 1.3.14 and Node 24
available (the coding runner environment). It downloads and extracts PostgreSQL
and Chromium libraries into ignored `node_modules/.cache/verify-skills` without
sudo or system service changes. A disposable local database uses port 55439;
browser tests use port 3107. Both ports must be free. No application database,
model credentials, GitHub credentials or external API calls are needed. First use
requires package/download network access. The database is removed on exit.

For runners with a short command timeout, run `bash scripts/verify-skills.sh quality`
and `bash scripts/verify-skills.sh browser` separately. Each phase prepares its own
environment and database; together they run the same checks as the default command.
Temporary subprocess fixtures use the checkout cache because `/tmp` may be mounted
with execution disabled.

For runs API/UI changes, use `bash scripts/verify-skills.sh quality` and
`bash scripts/verify-skills.sh runs-browser`. The latter runs the runs and admin
browser suites with the same independent preparation and disposable database.

For a release, run `bash scripts/verify-skills.sh quality` and
`bash scripts/verify-skills.sh release-browser`. The latter prepares the same
environment and runs the entire browser suite instead of only the skills-related
suites. Container builds, Compose smoke/restore and Codex lifecycle smoke checks
still require Docker. Verify runs the application container and Compose checks;
run the Codex lifecycle smoke explicitly when validating runner changes. See the
release runbook and [host update installation](../docs/implementation/updates.md).
