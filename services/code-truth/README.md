# Local Code Truth service

Private, read-only MCP service for DeepX Agent. Reuses the source-query core of
`../deepx-code-truth`; see [source provenance](UPSTREAM.md). Runs separately with
Bun because the upstream process adapter uses Bun. The bot remains a Node service.

Follow [the application setup guide](../../docs/implementation/code-truth.md).
Install dependencies from the application root before checking the integration:

```sh
bun install --frozen-lockfile
bun install --cwd services/code-truth --frozen-lockfile
bun run check
bun run typecheck
bun run --cwd services/code-truth typecheck
bun test
```

Local runtime variables: `CODE_TRUTH_TOKEN_FILE` (or `CODE_TRUTH_TOKEN`, at least
32 characters), `DATA_DIR` (default `./data`), `HOST` (default `127.0.0.1`), `PORT`
(default `3010`), and optional read-only `GITHUB_TOKEN`. Never expose this service
publicly. Its token authorizes repository configuration and all index queries;
operator and workspace authorization belong to the bot API and worker.

`GET /health/live` is public. All other endpoints require bearer authentication
and reject browser Origin headers. `POST /configure` accepts a validated workspace
UUID and configured GitHub targets, returning an immutable configuration namespace,
sync status and index provenance. `POST /mcp/:namespace` is stateless Streamable HTTP
MCP scoped to that configuration. No tool can supply a repository URL or host path.

No public OAuth or GitHub organization login is needed for this private transport.
Do not use the included upstream Codex example to connect to this private service;
it is retained only for the upstream tool-contract regression test.
