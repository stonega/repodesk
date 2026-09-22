# Release and recovery runbook

The local release checks are implemented. Do not treat them as evidence of a live
Telegram/model pilot. No host deployment or webhook registration was performed while
implementing the repository.

## Build and local release checks

Run the four required commands, real PostgreSQL integration tests, browser tests,
and `bun run test:runtime`. CI repeats these and builds/smokes the Docker image.
The Bun, Node and PostgreSQL base images are pinned by digest in Docker/Compose.
Publish the resulting application image to your registry and deploy its immutable
`@sha256:` digest through `APP_IMAGE`, then use `docker compose up --no-build -d`.
`deepx-agent:local` is only the local build tag.

On the host, provision an HTTPS reverse proxy, private PostgreSQL storage, separate
secret/backup storage and a responsible operator. Set explicit retention and budgets.
Run migrations once before API/worker startup; Compose enforces this dependency.
Roll forward migrations rather than reverting an image against an incompatible schema.

## Staging demonstration

Use only your dedicated staging bot/group and explicit model spend cap.

1. Claim setup, create admin, save draft, reload and verify it resumes.
2. Check bot identity, reconcile the HTTPS webhook, verify owner, configure model,
   whitelist and skills, then activate.
3. Confirm `/help`; forged webhook calls must return 401. Duplicate update delivery
   must create one run. Link a group as both workspace and Telegram administrator.
4. With explicit visibility/collection consent, add representative source messages.
   Request a recap. Confirm references, gaps, topic and group/private boundaries.
5. Propose Friday recurrence. Inspect next three instants and approve once; replay
   the callback and verify no second activation.
6. Reply `/correct save Put blockers first`, approve, then restart app and worker.
7. Observe one scheduled recap using the pinned workflow/skill and corrected
   instruction. Inspect generation, usage and delivery separately in the panel.
8. Pause it in the panel and confirm no subsequent occurrence runs. Revoke a test
   owner's eligibility and confirm their session, callbacks and pending work fail.
9. Simulate a Telegram timeout through a test adapter; verify `delivery_unknown`
   and no automatic resend. Perform the same check for unknown provider charges.
10. Complete backup/restore and workspace deletion drills, then record the actual
    provider/model, costs, retention agreement and support owner before inviting teams.

## Backups and restore

`bash scripts/backup.sh` writes a restrictive custom-format PostgreSQL dump under
`backups/`. Configure encrypted off-host storage and scheduled execution on the host.
Back up the encryption key separately; a database backup alone cannot decrypt credentials.

`bash scripts/restore-rehearsal.sh backups/FILE.dump` creates a uniquely named sibling
database, restores with `--exit-on-error`, checks schema/deployment/workspace counts,
and drops only that disposable database. It never overwrites the application database.
`COMPOSE_PROJECT_NAME` and the usual Compose configuration must identify the intended stack.

For actual disaster recovery, stop writers, restore to a new volume/database, inject
the matching encryption key, validate schema and credential decryption in an isolated
host with outbound delivery disabled, then deliberately move traffic. Review restored
`running`/`sending` operations: a backup cannot establish whether remote effects happened
after it was taken. Reconcile those before resuming the worker. Do not drop a useful
volume with `docker compose down -v`.

## Unknown outcomes and failures

- **Unknown delivery:** inspect Telegram. In Runs, resolve as sent with the observed
  remote message ID or abandon without resending. Neither option issues another send.
  Create an explicit new run only if you intend another publication.
- **Run timeout:** `failed (run_timeout)` means the worker reached
  `RUN_TIMEOUT_SECONDS` (300 seconds by default), not that the user cancelled it.
  Review provider latency and reasoning settings; if needed, increase the bounded
  deadline and redeploy after pending work drains. Provider billing still needs
  reconciliation when the attempt is unknown. Do not blindly replay it.
- **Unknown charge:** inspect provider billing. Record the actual charge and a billing
  reference in the run's reconciliation control. The unknown reservation persists until
  then. Retention purges content without erasing current budget accounting.
- **Worker crash:** expired leases are fenced. Complete transcript/tool-result boundaries
  can resume; uncertain provider attempts or missing tool outcomes stop with a visible
  error. Do not patch the transcript manually.
- **Queue exhaustion:** the run becomes `failed` with `queue_retries_exhausted` and an
  audit event. Authorized Retry creates a new run and budget reservation. Pending intents
  that were never enqueued remain in the transactional outbox.
- **Destination blocked/removed:** permanent send errors stop; bot removal disables the
  binding and dependent work. Group migrations require explicit relinking.
- **Emergency pause:** Operations pauses new dispatch/delivery. Existing provider or
  network calls may already have incurred costs/effects; inspect their recorded outcomes.

## Account and key recovery

`node dist/operator.js recover USERNAME PASSWORD_FILE` updates an existing local
operator through host access and revokes sessions. It never resets `deployment.claimed`.
The operator can explicitly restore eligibility of an existing workspace owner/admin
through Operations; that action is audited and does not authorize conversation access.

For key rotation, pause processing and stop app/worker, take a protected backup, and
run an audited offline migration that decrypts each named credential with the old key
and re-encrypts with the new key using `src/setup/credentials.ts`. Verify round trips
before committing and replacing the runtime secret. Keep the old key with old backups.
There is no blind runtime-key replacement: losing the key requires re-entering bot/model
credentials and reconciling the webhook secret. Never print decrypted credentials.

## Operational limits

Monitor `/readyz`, worker heartbeat, oldest pending outbox age, queue failures, budget
reservations and unknown deliveries. Logs contain event codes, not raw message bodies
or upstream exception text. Run IDs and versioned audit events support investigation.

The JSONB aggregate is intentionally capped for small pilots. Scale the storage model
before raising the 2,000-message / 1,000-run / 20-concurrent-request workspace bounds.
Normal UI pages return up to 100 records per API page. Workspace policies permit at
most 500 whitelist IDs. Schedules are daily/weekly only and skip five-minute-late runs.

The provider receives authorized retained context; `store:false` prevents application
session storage but does not override provider abuse-monitoring retention. The deletion
screen states this limit. No API claims to purge data the provider does not expose.
