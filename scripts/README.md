# Automation

- `build.ts`: backend Node entry points and React Router assets.
- `operator.ts`: host-only password recovery.
- `register-webhook.ts`: explicit opt-in staging webhook reconciliation.
- `evaluate.ts`: explicit, spend-capped live model evaluation; never run by normal checks.
- `runtime-contract.ts`: fake-provider Pi contract under Node; no credentials required.
- `backup.sh`: protected PostgreSQL custom dump through Compose.
- `restore-rehearsal.sh`: restore into a disposable sibling DB, verify, remove it.
- `start-local.sh`: start the configured local Podman stack; pass `--build` to rebuild images.
- `deploy-vps.sh`: release-bundle host cutover with locking, backup, migrations and readiness checks; see [VPS deployment](../docs/implementation/vps-deployment.md).

`src/db/migrate.ts` is the one-shot schema/job migration entry point. No ordinary
startup command registers webhooks, connects accounts or starts paid evaluations.
See [setup](../docs/implementation/setup.md) and [runbook](../docs/implementation/release-runbook.md).
