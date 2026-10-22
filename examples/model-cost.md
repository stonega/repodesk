# Query model API costs in Telegram

In an authorized **private chat** with the bot, select the workspace and ask:

```text
How much have I spent on model API calls this month? Break it down by model.
What did my model calls cost today?
Show my model API costs across retained history.
```

Workspace owners/admins can also ask:

```text
What is our workspace's model API cost this month, and how much budget remains?
```

The application tool is `query_model_cost`. Its JSON arguments are optional:

```json
{ "scope": "self", "period": "month" }
```

`scope` accepts `self` (default) or `workspace` (owner/admin only). `period` accepts
`today`, `month` (default), or `retained`. Calendar boundaries use UTC. The response
contains USD totals and per-model totals with separate settled, reserved and unknown
amounts. Workspace reports also include the current month's budget, regardless of
the selected reporting period. Regular members cannot query another user's usage.
Group requests must move to private chat before querying costs.

New workspaces' starter skills include the tool grant. For an existing workspace,
open a custom skill's **Edit** dialog in **Skills**, select **Query model cost**
and choose **Save skill** before starting a new request. Read-only presets can be
replaced by a separate custom skill when different tools are needed.
No plugin installation, extra API credentials or migration is required.

These are application accounting estimates based on recorded model usage and
configured prices (or an operator's reconciliation), not provider billing data.
Entered prices may use another currency with an operator-saved USD exchange rate.
Accounting converts those overrides to USD using each run's pinned rate; catalog
fallback prices are already USD. Editing the rate does not revalue earlier usage.
Run and monthly budgets default to None (unlimited). For an unknown custom model,
prices may be omitted; the report counts unpriced calls separately and excludes
their costs from dollar totals. Enter both prices before configuring a finite budget.
Unknown/reserved amounts are not confirmed charges. Retention limits history to
up to 90 days. The report is a snapshot; subsequent calls, including generation of
the final answer, are excluded. Asking the bot uses the normal model budget.

Local automated validation uses fake model responses and a disposable database;
it does not send Telegram messages or query a live provider.
