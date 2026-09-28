# Source provenance

The `src/upstream/` code and baseline tests were copied from the sibling
`../deepx-code-truth` at commit `e3b57d428bd8164362271e9bdff7d380d83c107b`
on 2026-09-20. That checkout's unrelated OAuth edits were not copied or changed.
This checked-in copy makes the bot build independent of a sibling checkout.

Included: immutable GitHub archive snapshots, CodeGraph 1.5.0 process adapter,
repository validation, read-only MCP tools, bounded dependency manifest retrieval,
and their deterministic tests. Formatting follows this repository's Biome config.
The MCP identity check was adapted from `githubLogin` to `localPrincipal`, which
our private service sets only after verifying the service bearer token. The
upstream OAuth server, OAuth database and organization login are not included.
The retained config module includes upstream config helpers used by baseline tests;
the local entrypoint does not invoke its OAuth environment configuration.

The companion skill in `../../skills/repodesk-code-truth/SKILL.md` comes from the same
commit. Its fixed three-repository list was replaced by workspace-configured targets.
Network selection, context-first queries, provenance and the response notice remain.

Keep updates explicit: diff the upstream core against this copy, preserve the local
identity boundary, update this commit record, and run both application and service
tests. `package.json` and `bun.lock` pin the original runtime dependencies; the main
application adds MCP SDK 1.29.0 for its internal client. CodeGraph, Octokit, Express,
Tar and Zod 3 stay in this separately deployed Bun service. The bot still uses Node.
