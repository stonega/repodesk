# Implementation roadmap

Status: updated 2026-09-27. The local P0 implementation is present and checked. A live pilot
has not been deployed or validated. See [implementation evidence](implementation-status.md).
This table records the original team-assistant foundation. The current product focus
is the [GitHub journey](../design/github-workflows.md).

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
| GitHub App | Workspace installation and selected repository connection | Live installation and permission review |
| Code Truth | Configured repository source queries through a private local service | Live repository indexing and answer-quality evaluation |
| Issues | Requester-approved issue draft and durable GitHub submission | Live issue creation and unknown-outcome drill |
| Coding | Maintainer-approved issue-to-draft-PR tasks with local Podman runner | Runner setup and live end-to-end task |

The repository uses workspace JSONB aggregates under row locks for the pilot, with
relational inbox/outbox/binding/session constraints. Read the architecture's capacity
limits before raising budgets or inviting large groups.

## Release sequence

1. Follow [setup](setup.md) on a staging HTTPS host with a dedicated test bot,
   GitHub App and selected test repository. Enable Code Truth for a known branch.
2. Run capped model evaluations: source question with checked citations, exact issue
   approval and one configured maintainer coding task through a draft PR.
3. Exercise denied repository access, revoked grants and unknown GitHub outcomes;
   complete the [release runbook](release-runbook.md) recovery drills.
4. Record model/provider behavior, retention policy, data-handling terms and the
   responsible operator. Invite pilot teams only after these gates pass.

## After the pilot

Prioritize a read-only issue/PR metadata tool if the GitHub pilot supports it; define
the user questions, freshness and App permissions before implementation. Multiple
group sources, files, proactive suggestions, executable skill bundles, other
connectors, Telegram web login, Mini App, voice, payments and broader GitHub writes
remain later work. Competitor research remains source-linked research, not a
shipping claim.
