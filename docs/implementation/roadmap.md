# Implementation roadmap

Status: 2026-09-18. The local P0 implementation is present and checked. A live pilot
has not been deployed or validated. See [implementation evidence](implementation-status.md).

| Slices | Local result | Remaining external gate |
| --- | --- | --- |
| I01 | Pi 0.85.1, explicit OpenAI provider, fake tool flow, Node 24 contract checks | Credentialed model comparison and billing review |
| I02 | PostgreSQL migrations, atomic inbox/outbox, pg-boss adapter, worker/leases | Production capacity/load review |
| I02A/I04A | Claimed setup, sessions, encrypted settings, verified Telegram linking, admin SPA | Staging HTTPS and browser session review on actual domain |
| I03/I04 | Webhook/router, scoped onboarding/linking/collection, delivery state machine | Dedicated bot `/help`, visibility and group-admin checks |
| I05 | Bounded Pi requests, source IDs, budgets, cancellation and checkpoints | Live recap usefulness and groundedness evaluation |
| I06 | Approved daily/weekly workflows, DST, unique occurrences, pause/resume | Friday recap across a staging restart |
| I07/I07A | Corrections, instruction approval, skill catalog/version/import/rollback and policy test | Team acceptance of skill output conventions |
| I08 | Retention/deletion, diagnostics/recovery, CI, image checks, backup/restore tools | Host deployment, protected backups, operator ownership and launch drill |
| Extensions | Pi-format plugins, operator panel, scoped tools/hooks, live configuration revisions and durable outcomes | Review each installed extension against the [headless contract](../design/llm-extensions.md) |

The repository uses workspace JSONB aggregates under row locks for the pilot, with
relational inbox/outbox/binding/session constraints. Read the architecture's capacity
limits before raising budgets or inviting large groups.

## Release sequence

1. Follow [setup](setup.md) on a staging HTTPS host and connect a dedicated test bot.
2. Run the explicitly paid model evaluation with a chosen cap; select a model.
3. Complete the [release runbook](release-runbook.md) demonstration and failure drills.
4. Record retention policy, provider data-handling terms and responsible operator.
5. Invite pilot teams only after those gates pass.

## After the pilot

Read-only connectors, multiple group sources, files, proactive suggestions, executable
skill bundles, Telegram web login, Mini App, voice, payments and arbitrary external
writes remain outside the implemented release. Reassess from pilot evidence before
building them. Competitor research remains source-linked research, not a shipping claim.
