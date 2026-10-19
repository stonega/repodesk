# Cloudflare plugin

Implemented locally, 2026-10-17. Live Cloudflare/Telegram acceptance and deployment
remain release gates. No extra package, migration or environment variable is needed;
the API and worker use the existing deployment encryption key.
Account/domain discovery and the simplified connection flow were added 2026-10-18.
Account API token guidance and the account token dashboard link were updated
2026-10-19; scoped user API tokens remain supported.

Open **Plugins → Cloudflare → API token → Edit**. Save a scoped token directly;
no OAuth client registration, callback URL or client secret is needed. Tokens are
write-only and encrypted with workspace-specific authenticated data.

## Token setup and resource selection

1. Follow **Create an account API token** in the token editor to open the
   [account token dashboard](https://dash.cloudflare.com/?to=/:account/api-tokens).
   Prefer an account API token for credentials independent of a user; scoped user
   API tokens also work. Restrict its resources to the accounts and domains this
   workspace should use. For account verification grant **Account Settings Read**;
   user API tokens also need **User Memberships Read** for named account discovery.
   Add **Zone Read**, **DNS Read** and **Cloudflare Pages Read**
   for the queries needed, plus **DNS Edit** for DNS changes and **Cache Purge**
   for purges. [Token creation](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
   and [permission names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
   describe the Cloudflare controls.
   Cloudflare's [account API token guide](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
   explains account token creation and service compatibility.
2. Paste and save the token. Saving a new/replacement token disables the plugin
   and opens **Configuration**. Saving alone does not verify provider permissions.
3. Choose the named account, or accept the sole account selected in the draft.
   Optionally search and select up to 20 domains for DNS/cache access. No domains
   are selected automatically; none means Pages-only access. Accounts/domains are
   fetched in pages of 50, with More controls for subsequent pages.
4. Save the selection. Named selections verify the account and every domain's
   account association before saving their names. First account selection enables
   the plugin; a replacement token for an already configured account remains
   disabled until the operator enables it after checking the selection.

Inventory reads are operator/session/workspace/revision-bound and recheck access
before and after each provider request. They remain available while the plugin is
disabled and never grant tools access to discovered resources. Failed requests and
saves preserve the saved settings and open draft. A changed account clears the
domain draft. Tokens and provider-only fields are excluded from responses.

For tokens that cannot list accounts, including account tokens without discovery
access, select **Enter IDs manually** in Configuration.
Supply the account and up to 20 zone IDs from Cloudflare. Manual saves do not verify
remote permissions; DNS access still checks the zone's account before using it.
Pages-only tokens can leave domains empty, including when Zone Read is unavailable.

Use **API token → Edit** to replace or remove credentials. A blank replacement keeps
the current token. Replacement clears cached resource names and pauses the plugin;
removal disables it. Removing a token from RepoDesk does not revoke it at Cloudflare.
Revoke unused tokens in the Cloudflare dashboard.

## Existing OAuth connections

The backend retains existing OAuth connection, refresh and disconnect APIs for
compatibility. New settings default to API tokens and the panel no longer offers
OAuth client registration, consent or credential editing. An existing connection
is labeled in the panel and can be replaced through **API token → Edit**. Saving
an explicit token clears local OAuth credentials and pending consent, fences late
OAuth results, and disables the plugin before resource selection. Revoke the old
authorization in Cloudflare afterward. No automatic migration or account connection
runs at startup.

## Queries and actions

The built-in Pi factory exposes two tools and a companion instruction skill:

| Tool | Supported operations | Access |
| --- | --- | --- |
| `query_cloudflare` | `zones`, `dns_records`, `pages_projects`, `pages_deployments` | Active workspace member, private interactive conversation |
| `propose_cloudflare_action` | `create_dns_record`, `update_dns_record`, `delete_dns_record`, `purge_cache` | Workspace owner/admin, private interactive conversation, followed by exact actor approval |

DNS create/update supports A, AAAA, CNAME, TXT and MX records, fully qualified
names within the selected zone, content, TTL, optional proxy flag and MX priority.
TTL is automatic (`1`) or 60–86,400 seconds. Update uses PATCH and preserves fields
outside the supplied supported record. Delete/update previews include the current
record and abort if it changes before execution. Cloudflare offers no atomic
compare-and-swap for these calls; another remote edit after the final read is a
remaining concurrency limitation. Purges take up to 20 explicit HTTP(S) URLs within
the zone or an explicit whole-zone purge. Oversized previews are rejected rather
than truncated.

Queries return only configured zones, or one page of up to 20 DNS records, Pages
projects or deployments. Page metadata and partial-inventory guidance accompany
lists. Pages responses allowlist display fields and exclude environment variables,
build configuration and source credentials. Queries and actions do not expose
arbitrary methods, URLs or API paths. Workers, creating deployments, uploads,
secrets and other Cloudflare products are outside this implementation.
Scheduled workflows and group requests cannot use these tools.

## Permissions, durability and recovery

Only the deployment operator can read/change configuration for their workspace.
The workspace API requires the existing authenticated session, Origin and CSRF
checks. Configurations share the workspace plugin revision; stale writes fail.
Saving preserves other plugins and any legacy-manifest fallback entries.
Enabled file plugins cannot collide with the Cloudflare tool names. Catalog changes
apply without restart and stop older in-flight work at its next guard.

Read access is checked before and after each request. Current actor, run,
deployment, account and selected-zone authority are rechecked for proposals,
approval and execution. The request actor alone can approve the exact hashed
payload within 15 minutes through existing Telegram controls or the panel's
approval view. API responses and ordinary messages never authorize writes.
Configuration revocation also blocks pending delivery and reuse of retained or
derived Cloudflare evidence. Workspace deletion removes the encrypted token with
other plugin settings.

The application service, rather than Pi, executes approved writes. It commits a
durable `sending` reservation before the API mutation. Concurrent workers and
repeated completed calls cannot send twice. Definitive API refusals become
`failed`; transport/server ambiguity or a reservation interrupted for over 60
seconds becomes `unknown` and is never retried automatically. Check Cloudflare
before making a new proposal after an unknown outcome. Result notifications use
the originating private topic and current delivery authorization.

The client fixes requests to `https://api.cloudflare.com/client/v4`, rejects
redirects, makes no automatic retries, uses a 15-second request timeout and limits
response bodies to 1 MiB and projected list output to 24 KiB. Upstream error text,
headers and tokens are excluded from model results and routine logs.

## API and examples

`GET /api/admin/workspaces/:id/plugins/cloudflare` returns `{ revision, settings,
tokenConfigured, resources?, oauth }`. PUT accepts `{ revision, settings, apiToken?,
removeToken?, verifyResources? }`. Settings contain `{ enabled, accountId, zoneIds,
authMethod? }`; new configurations use `api_token` and an omitted method retains
legacy token interpretation. `apiToken` and `removeToken` are mutually exclusive.
Secrets/ciphertext are never returned. `verifyResources: true` verifies a named
selection using the existing saved token; combine token replacement with a separate
selection save. Manual IDs omit this flag. Configuration writes make no provider
mutations.

POST `/api/admin/workspaces/:id/plugins/cloudflare/resources` accepts
`{ revision, resource: "accounts", page?: 1 }` or
`{ revision, resource: "zones", accountId, page?: 1 }`, returning
`{ items: [{ id, name }], page, hasMore }`. It requires a saved API token and the
current authenticated operator session, Origin and CSRF. Saved verified display
names appear in `resources: { account?: { id, name }, zones: [{ id, name }] }`.
IDs remain in API payloads and permission checks.

The legacy `/oauth/connect`, `/oauth/resources`, `/oauth/disconnect` and
`/api/admin/cloudflare/callback` endpoints retain their previous contracts; they
are not used by the token panel.

See [runnable requests and Telegram journey](../../examples/cloudflare.http).
Cloudflare's [DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
[Pages deployments](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/)
and [cache purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
define the upstream contracts; token permissions and the saved workspace scope
both apply.
