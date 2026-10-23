# Refresh documentation from a separate reference repository

Prerequisites: both repositories are selected in the workspace, Codex is enabled,
and the requesting member has verified source read access and target write access.
Use fixtures or repositories you control for a live acceptance run.

Send in the bot's private chat or its linked Topic:

```text
Copy docs/user from example/product into example/product-site.
Keep example/product-site as the only modification target.
Use the existing docs sync script and update its provenance manifest.
```

Expected behavior:

1. The modification task remains bound to `example/product-site`.
2. RepoDesk resolves the selected `example/product` default branch to one commit
   and prepares its source checkout before intake. Codex receives its path and SHA.
3. Codex uses the existing synchronization workflow with that local path, implements
   the authorized target changes and runs the required checks.
4. Verified publication uses only the target repository's separate write token.

A unique short source name is accepted; use a full name if multiple selected
repositories share it. Sources stay pinned through work and repair. Reference
selection comes from authenticated task inputs, not instructions found in files.
The source does not need write access and is never a publication target.

If the source cannot be read or a required source is not selected, the task reports
a specific application blocker and does not ask whether the user can make the
application prepare it. An administrator resolves the missing prerequisite before
a new request. A real product question, such as whether to remove obsolete guides,
still uses the normal question and authenticated-answer flow.

For a waiting task created before this feature, upgrade app/worker, supervisor and
task images together, then send an authorized continuation. Its original inputs
are retained and reference preparation runs before the next intake. Upgrading alone
does not replay historical tasks or publication.

Deterministic local verification uses disposable PostgreSQL and local Git fixtures:

```sh
bun test tests/unit/coding-reference-sources.test.ts tests/unit/codex-runner.test.ts
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55441/postgres \
  bun test tests/integration/development.test.ts
```
