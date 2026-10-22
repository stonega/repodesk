# Search Console in the Google plugin

Implemented as a built-in Pi extension with one tool, `query_search_console`,
and a companion skill in `skills/repodesk-search-console/SKILL.md`.

## Setup and scope

The deployment operator connects **Plugins → Google** with the existing registered
Web application; see [shared Google setup](google-workspace.md). Search Console
uses that same account, OAuth token, refresh claim and Enable switch. No separate
service account is needed. The panel discovers properties using `sites.list` and
explicitly selects up to 20. Saves verify current access with `sites.get`.
Discovery works while Google is disabled. Unverified properties are excluded;
only selected properties reach model tools. Without a selection the other four
Google tools remain available.

Queries require an active workspace owner/admin, active deployment/workspace and
a noncancelled private interactive run. Groups and scheduled workflows are denied.
Runs bind `searchConsoleRead` to the current shared connection and plugin revision;
retained answers, derived runs, handoffs and delivery recheck that scope. Disconnect,
credential replacement and account reconnection revoke previous access. Replacement
and reconnection clear the property selection.

Provider calls use fixed Google origins, no redirects/retries, 15-second timeouts
and 1 MiB response limits. Results are validated and projected; upstream error
bodies and tokens are never surfaced. Search Console read-only authorization uses
`https://www.googleapis.com/auth/webmasters.readonly` alongside the other Google
scopes, under the same Web application registration.

Legacy service-account configurations remain supported in the backend until the
operator saves the shared Google connection. That explicit upgrade clears their
credentials and allowlists; old page links lead to Google. Legacy membership
permissions remain in effect only before the upgrade.

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
- `PUT`: `{revision, settings: {enabled, siteUrls}}`; under the shared connection,
  `enabled` does not change the Google switch. Credentials and enablement live in
  `/plugins/google`; service-account changes are rejected after upgrading.
- `POST /properties`: `{revision}`, returning `{items: [{siteUrl, permissionLevel}]}`.

Mutations/discovery retain the admin Origin, CSRF and session guards. The plugin
registry revision is shared with other plugins in the same workspace; stale edits
return `version_conflict`. The Google page uses saved summary cards and shared modal,
toggle, action, skeleton and toast components. Failed saves retain drafts and
pending saves block dismissal and repeat submission.

See [runnable requests](../../examples/search-console.http) and
[the user guide](../user/search-console.md). Deterministic unit/integration and
browser tests cover credentials, permissions, API boundaries and modal behavior.
Live Google permissions/quotas and a live Telegram/model round trip remain manual
staging checks; no account is connected or deployment performed by this change.

## Provider references

- [OAuth authorization and scopes](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)
- [Sites list](https://developers.google.com/webmaster-tools/v1/sites/list)
- [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [Sitemaps list](https://developers.google.com/webmaster-tools/v1/sitemaps/list)
- [URL inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)

Checked 2026-10-21 against official Google documentation and Context7.
