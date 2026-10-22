# Search Console in the Google plugin

`query_search_console` uses the requesting member's personal Google connection and
selected properties. The operator configures the common OAuth client and Enable
switch in [Google setup](google-workspace.md); no shared account or service-account
credential authorizes personal reads.

## Personal property selection

Send `/google` in private Telegram, complete Google consent and confirm the account
there. Then send `/google properties`. Discovery calls `sites.list`, filters unverified
properties and shows ten choices per page. Select up to 20, then Save. Saves verify
every selected property with `sites.get`. Cancel discards the draft; expired menus
require `/google properties` again. Failure preserves the draft for recovery.
Reconnecting clears that member's selection. Disconnect, credential replacement,
member revocation and workspace deletion revoke the relevant personal grants.

Groups and scheduled workflows cannot read personal Search Console data. Active
members can query only their own confirmed account in private interactive runs.
Retained/derived evidence and delivery require the same member, connection, plugin
revision and personal selection revision. Changing a selection revokes older retained
answers without changing the plugin revision or affecting another member.

## Tool operations

| Resource | Behavior |
| --- | --- |
| `properties` | Lists the member's saved selection without a provider request |
| `analytics` | Finalized date/query/page/country/device/searchAppearance data; inclusive Pacific dates, up to 366 days; 25 rows by default, at most 100; explicit startRow pagination |
| `sitemaps` | Submitted sitemap metadata; at most 100 returned with a truncation flag |
| `inspect_url` | Google's indexed status; selected domain/subdomain or URL-prefix containment; no live test or indexing write |

Google returns top rows and omits anonymized queries. Empty results do not establish
zero traffic or complete coverage. API calls use fixed origins, no redirects/retries,
15-second timeouts and 1 MiB response limits. No site verification, sitemap changes
or indexing writes are implemented. Upstream diagnostics and tokens remain private.

## Migration and verification

`020_google_personal_accounts.sql` removes the legacy service-account credentials and
workspace selections. Old browser page links lead to Google application setup; admin
Search Console configuration/discovery APIs are retired. Members must connect and
select properties themselves. See [Telegram examples](../../examples/search-console.http)
and [user guide](../user/search-console.md).

Deterministic tests cover personal selection, pagination, failed saves, tenant/member
isolation, revocation and provider response validation. Real Google permissions,
quotas and native Telegram rendering require staging acceptance.

Provider references: [OAuth](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing),
[sites](https://developers.google.com/webmaster-tools/v1/sites/list),
[analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query),
[sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps/list),
[URL inspection](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect).
