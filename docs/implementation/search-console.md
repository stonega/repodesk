# Google Search Console plugin

Implemented as a built-in Pi extension with one tool, `query_search_console`,
and a companion skill in `skills/repodesk-search-console/SKILL.md`.

## Setup and scope

The workspace's deployment operator saves a Google service account JSON key,
discovers properties using `sites.list`, explicitly selects up to 20 properties,
and enables the plugin. Property saves and enabling verify current Google access
with `sites.get`. Disabling an unchanged selection and removing credentials do
not require a working Google connection. Discovery is available while disabled.
Unverified properties are excluded. Only chosen properties reach model tools.

Credentials are AES-GCM encrypted with workspace-specific associated data using
the existing deployment encryption key. Responses expose email, configuration
status and selection; they never expose private keys or access tokens. Key
replacement disables the plugin and clears the selection. Removal clears the
local credential, but does not revoke Google's key. No database migration or
dependency addition is required; settings use the existing workspace JSONB record.

Service account JWTs use Node's RSA-SHA256 implementation and a fixed token
endpoint, audience and `webmasters.readonly` scope. Credential-supplied URLs and
delegated users are ignored. Access tokens are short-lived and held only for the
current operation. Provider calls use fixed Google origins, no redirects/retries,
15-second timeouts and 1 MiB response limits. Successful provider data is validated
and projected into supported fields; upstream error bodies are never surfaced.

Operator discovery and verification bind to tenant, plugin revision and current
operator session before and after requests. Model queries require an active member,
active deployment/workspace and a noncancelled private interactive run. Tool calls
use the existing durable extension ledger. Plugin revisions are pinned in the
extension hash and rechecked around every provider call. Runs record
`searchConsoleRead` before accessing data; retained answers, derived runs,
handoffs, skill proposals and delivery recheck current configuration and private
destination through the existing permission paths. Disabling invalidates pending
work. Other workspace settings remain intact.

## Tool operations

| Resource | Behavior |
| --- | --- |
| `properties` | Lists the saved allowlist without a provider request |
| `analytics` | Finalized performance by date/query/page/country/device/searchAppearance; explicit inclusive Pacific dates, at most 366 days; web/image/video/news/discover/googleNews; 25 rows by default, maximum 100; explicit startRow pagination |
| `sitemaps` | Reads submitted sitemap metadata; returns at most 100 with a truncation flag |
| `inspect_url` | Reads Google's indexed URL status; validates domain/subdomain or URL-prefix containment; no live test or indexing request |

Analytics returns metrics, dates, dimensions, type, timezone, next offset and a
coverage limitation. Google returns top rows, omits anonymized queries and may
have delayed data. A short/empty page is not evidence of zero traffic or a complete
export. No site verification, sitemap submission/deletion or indexing write is
implemented. Group queries and schedules are excluded in this version.

## Admin API

All routes are under `/api/admin/workspaces/:id/plugins/search-console`:

- `GET`: redacted configuration and workspace plugin revision.
- `PUT`: `{revision, settings: {enabled, siteUrls}, serviceAccount?, removeCredential?}`.
- `POST /properties`: `{revision}`, returning `{items: [{siteUrl, permissionLevel}]}`.

Mutations/discovery retain the admin Origin, CSRF and session guards. The plugin
registry revision is shared with other plugins in the same workspace; stale edits
return `version_conflict`. The panel uses saved summary cards and shared modal,
toggle, action, skeleton and toast components. Failed saves retain drafts and
pending saves block dismissal and repeat submission.

See [runnable requests](../../examples/search-console.http) and
[the user guide](../user/search-console.md). Deterministic unit/integration and
browser tests cover credentials, permissions, API boundaries and modal behavior.
Live Google permissions/quotas and a live Telegram/model round trip remain manual
staging checks; no account is connected or deployment performed by this change.

## Provider references

- [Service account authorization](https://developers.google.com/identity/protocols/oauth2/service-account)
- [Sites list](https://developers.google.com/webmaster-tools/v1/sites/list)
- [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Sitemaps list](https://developers.google.com/webmaster-tools/v1/sitemaps/list)
- [URL inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)

Checked 2026-10-20 against official Google documentation and Context7.
