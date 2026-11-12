# Missing model prices blocked budgeted requests

On 2026-11-11, a workspace request stopped with
`model_pricing_required_for_budget` because its model lacked token price metadata
and the workspace had a finite dollar budget. This was an application policy
check before model dispatch. The operator requested a policy change so missing
token prices count as zero.

The guard existed in Pi execution, chat reservations and background memory
reservations. Historical unpriced usage also prevented finite budget enforcement
with `unpriced_usage_requires_reconciliation`.

Missing rates now default individually to zero. Known rates and reconciled charges
still count toward budgets. Chat, memory and admin self-check settlement record
the resulting cost and retain token counts. Historical unpriced calls without
reconciled charges count as zero when calculating usage and remaining budgets.

A deterministic regression exercises the production Executor, Pi runner,
PostgreSQL accounting and delivery worker with finite and zero-dollar budgets.
It includes historical unpriced usage and duplicate execution. Unit coverage
checks partial prices, catalog and currency fallback, and authorized charge
reconciliation. Verification and deployment status are recorded in the
implementation status document.

The operator-authorized VPS rollout deployed source `af51715` in bundle
`1794367751621-08425833`. The isolated release passed all 1,482 tests, exact-image
runtime and Compose smoke checks, and backup/restore validation. Public health
and readiness return HTTP 200, all services are healthy, and the 55 running
artifacts match the verified images.
