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
edit an enabled skill's JSON in **Skills**, add `query_model_cost` to `tools`, and
publish it before starting a new request. Existing published skills are unchanged.
No plugin installation, extra API credentials or migration is required.

These are application accounting estimates based on recorded model usage and
configured prices (or an operator's reconciliation), not provider billing data.
Unknown/reserved amounts are not confirmed charges. Retention limits history to
up to 90 days. The report is a snapshot; subsequent calls, including generation of
the final answer, are excluded. Asking the bot uses the normal model budget.

Local automated validation uses fake model responses and a disposable database;
it does not send Telegram messages or query a live provider.
