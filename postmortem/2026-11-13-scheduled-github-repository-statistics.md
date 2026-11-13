# Scheduled GitHub statistics had no authenticated tool

Date: 2026-11-13. Status: corrected locally; production deployment and live
model acceptance remain outstanding.

## Report and production evidence

The Wallshader daily statistics workflow ran at 08:00 Asia/Taipei on November 13.
Read-only VPS inspection confirmed its saved private Topic destination, model
transcript and delivered text. Three browser calls returned the local policy
code `browser_private_task_required`. The public page reader returned repository
text, while its API URL attempt returned `web_read_http_failed`. The latter code
does not establish the upstream HTTP status or a GitHub App permission problem.
The final answer reported unavailable counts and was marked succeeded because
generation and text delivery completed.

The VPS was healthy and running v0.1.46, source `b6ab2b9`. GitHub App credentials
were not used by those web-reader attempts. A separate weather widget failure
in the supplied screenshot is covered by the scheduled-private-widgets incident;
this correction does not change browser or Telegram widget policies.

## Cause and correction

GitHub's repository API supports installation tokens with Metadata read access
and returns star, fork and notification-subscriber counts. RepoDesk's registered
metadata tool accepted only issues and pull requests. Repository synchronization
also discarded count fields. The model had no registered authenticated query for
the report and tried unrelated retrieval paths.

The existing metadata tool now accepts `kind: repository`. It uses a
repository-scoped Metadata-read installation token, validates repository identity
and safe nonnegative counters, and returns bounded totals with a canonical URL
and retrieval time. Watchers use `subscribers_count`, not `watchers_count`.
Existing membership, current repository access, workflow-source and queued
delivery guards remain in effect. Instructions identify this query for ordinary
questions and schedules. No historical deltas are inferred from one snapshot.

## Regression and release boundary

Deterministic tests exercise the real Store, workflow dispatcher, PluginService,
Pi extension, Executor and DeliveryWorker with fake GitHub, model and Telegram
transports. They cover ordinary members, private Topics, restarts, duplicate
dispatch/execution/delivery and revocation before delivery. Service tests cover
zero counts, watcher semantics, least-privilege tokens, forged parameters,
cross-workspace/source boundaries, stale permissions, cancellation, revocation
during requests and invalid/upstream failure responses. Production startup keeps
registration local, with no optional-service or credential lookup.

All 27 new tests, lint, strict types, build and the 16-case offline startup
contract pass with Bun 1.3.14 and disposable PostgreSQL. The complete test run
recorded 1,644 passes and one unchanged native-runtime supervisor failure across
167 files. All six native-runtime tests pass on an isolated retry; the original
full run remains recorded as failing. Lint reports nine pre-existing diagnostic
script warnings. Browser tests are not selected for this API/tool-only change
against baseline `0424ce9`; UI/routes/configuration/dependencies are unchanged,
and no previous browser result is reused.

During PR integration, the complete browser run exposed a stale preset-preview
height assertion already present in main. It limited complete expanded
instructions to the old short-preset height. CI browser shard 2 recorded 206
passes and four such failures; shard 1, quality and containers passed. The
follow-up test preserves compact collapsed summaries and preview chrome while
asserting that expanded instructions retain their entire saved text. All nine
focused preset scenarios pass, with desktop/mobile and both themes inspected.
No product UI or preset content changed. This passing focused result does not
turn the earlier interrupted/failed whole workflow into a full pass; the updated
PR head requires fresh CI verification before merge.

No schedule mutation, live model/Telegram request, historical replay or production
deployment is part of this local correction.

Reference: [GitHub Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository),
checked 2026-11-13.
