# Cloudflare plugin

Implemented locally, 2026-10-17. Live Cloudflare/Telegram acceptance and deployment
remain release gates. No extra package, migration or environment variable is needed;
the API and worker use the existing deployment encryption key.
Account/domain discovery and the simplified connection flow were added 2026-10-18.

Open **Plugins → Cloudflare → Connect Cloudflare** after the operator configures
the OAuth application once in **Authorization → Edit**. New configurations default
to browser authorization. Cloudflare handles account selection and consent; no
account or zone IDs need to be entered. Existing token configurations keep their
authentication method. Credentials are write-only and encrypted with
workspace-specific authenticated data. Saving configuration does not validate
manual provider credentials; OAuth verifies account/resource access when connecting
and changing the workspace selection.

## Browser authorization

Cloudflare supports third-party Authorization Code clients. RepoDesk uses a
server-side client with `client_secret_basic`, S256 PKCE, session-bound state and
the published Cloudflare authorization/token/revocation endpoints.
See [client registration](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
and [endpoint documentation](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/).

1. In Cloudflare, create an OAuth client with Code response type,
   `authorization_code` and `refresh_token` grants, and `client_secret_basic`
   authentication. Register the callback URL displayed by RepoDesk's Authorization
   editor: `<site origin>/api/admin/cloudflare/callback`.
2. Select Account Read for account discovery/verification, Zone Read for domain
   discovery, plus the read/write permissions
   needed for the supported operations. Save the client ID, client secret and
   selected dot-delimited API scope IDs in **Authorization → Edit**. The
   [OAuth scopes API](https://developers.cloudflare.com/api/resources/iam/subresources/oauth_scopes/methods/list/)
   lists available IDs; `account.read` is the Account Read scope. RepoDesk adds
   `offline_access` to authorization requests for renewable access.
3. Select **Connect Cloudflare**, sign in and choose authorized accounts and
   permissions on Cloudflare's consent screen. Returning successfully stores
   encrypted tokens. A sole authorized account is selected automatically and the
   plugin is enabled for Pages-only access. If several accounts were authorized,
   a modal asks which named account this workspace should use; tools remain
   disabled until that choice is saved. Existing configured accounts are verified
   on reconnect and retain their domain restrictions.
4. Optionally open **Configuration → Edit**, search and select up to 20 domains
   by name for DNS/cache access, then save. Accounts and domains are fetched in
   pages of 50; More accounts/domains exposes additional choices. No domains are
   selected automatically. Leave them unchecked for Pages-only access, including
   when Zone Read was not granted. A changed account clears the domain draft.

Saving a changed OAuth account/domain selection verifies the account and each
domain's account association with Cloudflare before applying it. Inventory reads
are operator-only, workspace/revision-bound, and recheck authorization after the
provider returns. They remain available for configuration while the plugin is
disabled; they do not grant model/tool access to discovered resources. Failed
discovery and saves preserve the saved settings and modal draft. Saved summaries
show verified account/domain names; older selections without cached names retain
their IDs until verified by connection/selection. Tokens and provider configuration
are excluded from inventory responses. Manual API tokens still use explicit IDs.

The client is registered once and can be reused across workspaces with the same
callback URI. Each workspace has independent credentials, consent state and
connection. Private Cloudflare clients are limited to members of their parent
account. Connecting users outside that account requires a public client and
Cloudflare's domain-verification prerequisites; RepoDesk does not publish clients.
HTTPS is required except for local loopback development addresses.

The callback is tied to the current operator session, workspace, plugin revision,
PKCE verifier and site callback address, expires after ten minutes and is consumed
before exchange. Logout, settings changes, replay, declined consent or a wrong
account cannot establish a connection. Raw OAuth errors and credentials are never
returned to the model or panel.

Access tokens refresh server-side when close to expiry. The worker commits a
refresh reservation before contacting Cloudflare and persists returned tokens before
use, without changing the plugin revision. Concurrent workers wait for that result.
Ambiguous/failed refresh or a reservation interrupted for over 30 seconds requires
Reconnect; an uncertain refresh token is never replayed. If Cloudflare issues no
refresh token, access lasts until the recorded expiry and then requires reconnect.

**Disconnect** removes local tokens, cancels pending consent and disables the
plugin before attempting to revoke both access and refresh tokens at Cloudflare.
Unconfirmed remote revocation is reported explicitly; the operator can revoke the
authorization in their Cloudflare profile. A late refresh cannot restore a
disconnected connection. Disconnect before changing the client, scopes or
authentication method. API token fallback is always an explicit choice.

## Manual API tokens

Select **API token** in Configuration → Edit, save a scoped token and enable the
plugin. Blank replacement keeps the current token. Removing it disables a manual
connection. Token-configured status does not imply verified provider permissions.

Use a [scoped API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).
For the operations you need, grant Zone Read, DNS Read, Cloudflare Pages Read at
account scope, DNS Edit for DNS changes, and Cache Purge for purges. Restrict token
resources to the configured account and zones. Pages-only configurations may leave
zone IDs empty. The zone account is checked against the configured account before
DNS reads and actions. A zone grant never comes from model input.

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
tokenConfigured, oauth }`. PUT accepts `{ revision, settings, apiToken?, removeToken?, oauthClient? }`.
Settings contain `{ enabled, accountId, zoneIds, authMethod? }`; omitted authMethod
retains the legacy API token interpretation. `oauthClient` contains `{ clientId,
clientSecret?, scopes }`; an omitted secret preserves the same client's secret.
`apiToken` and `removeToken`
are mutually exclusive. The token/ciphertext is never returned. No external action
is executed by this configuration API.

POST `/api/admin/workspaces/:id/plugins/cloudflare/oauth/connect` with
`{ revision }` returns the Cloudflare authorization URL. GET
`/api/admin/cloudflare/callback` consumes the authenticated provider callback and
redirects to the plugin with a fixed success/failure marker. POST the corresponding
`/oauth/disconnect` with `{ revision }` returns the saved page and
`revocationConfirmed`. Configuration views expose only client IDs, scope IDs,
callback URL, connection status and expiry; client secrets, access/refresh tokens,
PKCE verifiers and pending state never appear in responses.

POST `/api/admin/workspaces/:id/plugins/cloudflare/oauth/resources` accepts
`{ revision, resource: "accounts", page?: 1 }` or
`{ revision, resource: "zones", accountId, page?: 1 }` and returns
`{ items: [{ id, name }], page, hasMore }`. Discovery requires an existing OAuth
connection, the authenticated operator session, Origin and CSRF. The settings
response additionally includes optional `resources: { account?: { id, name },
zones: [{ id, name }] }` for saved display names. IDs stay in API payloads and
authorization checks; the OAuth UI does not ask users to type them.

See [runnable requests and Telegram journey](../../examples/cloudflare.http).
Cloudflare's [DNS API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
[Pages deployments](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/)
and [cache purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
define the upstream contracts; token permissions and the saved workspace scope
both apply.
