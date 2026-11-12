# Nowledge Mem plugin

RepoDesk includes an optional built-in Nowledge Mem adapter for private Telegram
knowledge recall and explicitly authored memory saves. It is disabled initially;
configure **Plugins → Nowledge Mem** in each workspace. No dependency was added.

## Upstream review and adapter choice

Reviewed on 2026-11-12:

- [Installation](https://mem.nowledge.co/docs/installation): install and start Mem,
  install its required models, and verify a first saved memory. Linux/headless
  deployment needs a remote LLM for Mem's own processing.
- [Pi connector](https://mem.nowledge.co/docs/integrations/pi): the standard
  `nowledge-mem-pi` package loads startup context and synchronizes local Pi session
  branches. Its CLI/session-file discovery and automatic transcript export do not
  fit RepoDesk's headless, multi-user extension contract.
- [Remote access](https://mem.nowledge.co/docs/remote-access): use the Mem server
  base URL and an API key in the Authorization Bearer header. `/mcp/` is the MCP
  endpoint, not the REST base. A running local or remote Mem is required.
- [Spaces](https://mem.nowledge.co/docs/api/spaces/get),
  [search](https://mem.nowledge.co/docs/api/memories/search/post),
  [list](https://mem.nowledge.co/docs/api/memories/get),
  [read](https://mem.nowledge.co/docs/api/memories/memory_id/get) and
  [create/upsert](https://mem.nowledge.co/docs/api/memories/post) define the REST
  operations implemented by this adapter.

RepoDesk uses application-owned services around Pi rather than installing the
terminal connector. It does not read `~/.nowledge-mem`, `~/.pi`, ambient `NMEM_*`
variables or local transcripts. It does not automatically inject Mem Rules,
identities or Working Memory into the system prompt. Upstream content is historical
reference and cannot authorize actions or replace application policy.

## Configuration and scope

Only the owning deployment operator can view/change a workspace's connection.
The API uses existing session, origin and CSRF middleware. Saving uses the shared
plugin revision, audit entries and catalog digest. Changes invalidate older work.
File extension tool names cannot collide with either Nowledge Mem tool, including
while this built-in is disabled. The legacy file registry remains preserved.

Choose one active Telegram member, enter the HTTPS server base URL and API key,
then use **Find Spaces** to discover available names. A sole Space is selected
automatically; several require a choice. Save the configuration, then enable the
plugin with its independent title switch. HTTP is supported only on loopback;
inside Docker, localhost means that container. Use a reachable HTTPS Access
Anywhere endpoint for a desktop Mem on another machine.

The key is AES-GCM encrypted with workspace-bound authenticated data. API responses
and saved summaries expose only whether a key exists. Changing the server or
member clears the old key unless a fresh key is supplied; disabling retains the
key, while Remove saved API key removes it and disables the plugin. No upstream
calls occur during view, configuration save, registration, or unrelated greetings.
Space discovery is an explicit, authenticated operator action.

One workspace connection belongs to one selected member. It is not an organization
vault or a grant to all members. Every operation checks the active member, private
chat destination, interactive run, fence, current plugin revision, enabled state,
current deployment and configured bot identity. The model cannot choose an actor,
server, key or Space. Both outgoing requests and returned memory identities are
checked against the configured exact Space. Space selection is an application
boundary; it does not make a server-wide Mem API key a Space-scoped credential.

Private read dependencies are retained on the run. Current authorization is
rechecked for source-derived answers, handoffs and delivery, including bot changes,
member revocation, plugin disablement and configuration changes. This does not
query Mem again to discover remote edits or deletions of already returned content.
Normal RepoDesk message retention still applies. Disconnecting does not delete
records already saved in Mem; use Mem to manage its own retention and deletion.

## Chat operations and durable writes

- `query_nowledge_mem({query?, id?, limit?})`: list memories when query/id are
  absent, search with query, or read one exact ID. Query and ID are exclusive;
  the maximum result count is ten. Search/list excerpts are capped at 1,200
  characters each; full reads at 16,000, with an explicit truncation marker.
- `save_nowledge_mem({sourceId})`: accept only an explicit exact-content command in
  the current human message, such as `Save to Nowledge Mem: We use PostgreSQL.` or
  `保存到 Nowledge Mem：我們使用 PostgreSQL。`. The application extracts the text
  after the colon. The model cannot substitute content, summarize a transcript,
  approve a write from retrieved history, or select a different destination.

Before an external save, the service reserves a receipt under the tenant run and
human source ID. Custom upstream memory IDs derive from workspace/member/source
identity. A completed receipt is returned on repeats, including after restart.
Concurrent reservations serialize under the workspace transaction. A started save
without a confirmed completion remains uncertain and is not sent again; inspect
Mem manually before issuing a new save request. A later model failure does not
undo a successful save. No update/delete, automatic extraction, session sync or
scheduled export is implemented by this plugin. RepoDesk's internal memory is
unchanged.

Requests have a 15-second deadline, cancellation, redirect rejection, a 512 KiB
response ceiling and schema/identity validation. Only selected memory fields reach
the model; upstream metadata and exception text do not. Failures use fixed
`nowledge_mem_*` codes through the existing tenant/run tool ledger and runtime
logging. Missing or invalid credentials do not prevent other tools or greetings.
The combined production factory fixture includes enabled/missing-key Nowledge Mem
and proves zero external startup calls in both deterministic tests and the bundled
Node runtime contract.

## UI acceptance and verification

Applicable recorded preferences: shared plugin details/title switch, modal editors,
discovered connection resources, saved values before editing, top-right Edit,
shared dropdowns, toasts, content-owned card spacing and layout-preserving loading.
Acceptance criteria: saved Connection has labeled values without form controls;
Edit opens the shared modal; Cancel discards the draft and returns focus; failures
preserve the draft; pending requests prevent duplicate submissions and dismissal;
loading keeps headings/help/summary rows visible; errors offer recovery; secrets
never appear in the saved display. Check desktop/mobile and both themes.

Deterministic coverage is in `tests/unit/nowledge-mem.test.ts`, the PostgreSQL
`tests/integration/nowledge-mem.test.ts`, the combined startup fixture, and
`tests/browser/nowledge-mem.e2e.ts`. Browser fixtures cover empty/loading/error,
discovery, editor, pending, saved and cancel states. Live server acceptance still
requires operator-provided Mem credentials and an actual private Telegram session.
No server installation, account connection, deployment or live external save is
performed by local verification.
