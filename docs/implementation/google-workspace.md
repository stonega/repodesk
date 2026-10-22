# Google plugin

One built-in plugin, `google`, combines Docs, Sheets, Drive, Gmail and Search
Console. It has one catalog card, detail page, OAuth Web application client,
account connection, Enable switch and runtime registration. No dependency,
database migration, separate service or environment variable is required.
Credentials use the existing deployment key and workspace-bound encryption.

## Setup

Open **Plugins → Google → Connection → Edit**. Reuse an existing Google **Web
application** OAuth client. Enable all five APIs listed below, configure consent
and test users, and add the exact callback URL shown in the dialog:
`https://YOUR_ADMIN_HOST/api/admin/google/callback`.
Copy buttons beside **Callback URL** and each **Read scope** copy their exact
values, briefly show a checkmark, and offer manual-copy guidance on failure.
Save the client ID and secret, reopen Edit and connect an account. After Google
returns, review the account and explicitly enable Google. Saving credentials or
connecting alone never enables runtime access. All five scopes must be granted.

Under **Search Console properties → Edit**, discover and select up to 20 properties
available to the same Google account. Discovery excludes unverified properties;
saving verifies current access. Without a selection, the other four tools remain
available and Search Console is excluded from the runtime registration.

Disconnect clears the shared local access/refresh tokens and pending sign-in,
and disables all five services. Client settings remain for reconnecting. Revoke
provider access separately in Google's account connections page. Replacing client
credentials clears the connection and Search Console selection and disables Google.
Blank secret edits preserve the saved secret only for the same client ID.
Reconnecting also clears the property selection to avoid transferring another
account's saved access.

## Existing installations

Old Docs, Sheets, Drive, Gmail and Search Console page links lead to Google.
The shared editor prefills the first existing OAuth client (Docs, Sheets, Drive,
then Gmail); save to reuse its encrypted secret without re-entering it. Operators
with several clients can instead enter their chosen client ID and secret. Saving
replaces all legacy Google connections, pending sign-ins and Search Console service
account credentials, without changing file registrations or unrelated plugins.
Existing product tokens are never promoted to shared access: reconnect for the
combined scopes and select Search Console properties again. Legacy backend
records continue their previous scope until this explicit upgrade.

| Plugin | Google API to enable | Read scope | Pi tool |
| --- | --- | --- | --- |
| Google Docs | Google Docs API | `documents.readonly` | `query_google_docs` |
| Google Sheets | Google Sheets API | `spreadsheets.readonly` | `query_google_sheets` |
| Google Drive | Google Drive API | `drive.readonly` | `query_google_drive` |
| Gmail | Gmail API | `gmail.readonly` | `query_gmail` |
| Search Console | Google Search Console API | `webmasters.readonly` | `query_search_console` |

Scopes use the prefix `https://www.googleapis.com/auth/`. Sign-in additionally
requests `openid email` to identify the Google account. Google consent, verification,
Workspace administrator policies and refresh-token lifetime rules still apply.
HTTPS is required except loopback development. Callback URLs follow the saved
admin site address; a site address change invalidates an outstanding return.

## Tools and limits

Only active workspace owners/admins in **private interactive conversations** can
read the connected account. Regular members, groups and scheduled workflows are
denied before provider requests. These are workspace-owned connections, not
personal Google sign-ins for every Telegram user. Enabling grants authorized
owners/admins access to the connected account within the listed product scope.
Docs/Sheets require a known resource ID; use the shared Drive tool for discovery.

| Tool | Arguments / result |
| --- | --- |
| `query_google_docs` | `{documentId}`; title and text from all document tabs, nested tabs, paragraphs and tables |
| `query_google_sheets` | `{resource:"spreadsheet",spreadsheetId}` for sheet metadata; `{resource:"values",spreadsheetId,range}` for an explicit A1 range of formatted cell values |
| `query_google_drive` | `{resource:"files",query?,pageToken?}` for a literal filename search; `{resource:"file",fileId}` for metadata; preserves `nextPageToken` and `incompleteSearch` |
| `query_gmail` | `{resource:"messages",query?,pageToken?}` for Gmail search syntax and message IDs; `{resource:"message",messageId}` for selected headers, snippets and plain-text MIME parts |

Search Console supports saved properties, finalized analytics, sitemaps and indexed
URL inspection. Its property allowlist and data limits are documented in
[Search Console](search-console.md).

Lists fetch up to 20 items per page. Follow `nextPageToken`; these are not complete
account inventories. Drive returns metadata only. Gmail HTML and attachments are
not downloaded; HTML-only messages retain the provider snippet with
`plainTextAvailable:false`. Docs return text rather than exact visual formatting.
Responses are bounded to 1 MiB, projected tool output to 32,000 bytes. Oversized
results fail explicitly; narrow the requested range/query. No arbitrary URL,
mailbox identity, HTTP method or raw API request is exposed. Editing documents,
changing cells, uploading/sharing/deleting files and drafting/sending mail are
not implemented. No action approvals are created by these read tools.

## Authorization, durability and API

Operator configuration requires the existing session, exact Origin and CSRF
checks. Only the owning deployment operator can view/edit it. Configurations
share the workspace's optimistic plugin revision and preserve other built-ins,
file registrations and legacy manifest fallbacks. Enabled tools cannot collide
with registered file tools. Worker catalog pinning revokes older executions after
settings change. Each read also binds its connection identity/revision to the run;
retained answers, derived sources, handoff and delivery recheck that private/admin
scope. Workspace deletion purges credentials with the plugin registry.

OAuth uses offline consent, S256 PKCE, random one-use ten-minute state tied to the
operator, session, workspace, registration, revision and exact callback URI. Granted
combined scopes, refresh token and verified Google account identity are required.
Callback exchange is claimed durably before contacting Google; duplicate/late
returns cannot replace a disconnected or changed connection. Refresh claims
serialize concurrent workers without changing the plugin revision. Failed or
abandoned refresh requires reconnection. Requests have a 15-second timeout,
reject redirects and do not automatically retry. Upstream error text and secrets
are excluded from tool errors, audit and configuration responses.

- `GET/PUT /api/admin/workspaces/:id/plugins/google`: redacted page / versioned settings.
- `POST .../connect` with `{revision}`: Google consent URL; no provider write.
- `POST .../disconnect` with `{revision}`: local connection removal.
- `GET /api/admin/google/callback`: session-bound provider return.

See [runnable setup requests and tool inputs](../../examples/google-workspace.http).
Protocol references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[Docs get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get),
[Sheets values](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get),
[Drive files](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list),
[Gmail messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[Search Console OAuth](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing).

## Verification

Deterministic provider fixtures cover all five services, authorization, OAuth
replays/denial, token encryption and refresh, races with disconnect, retained
evidence and tenant isolation. Browser fixtures cover the merged catalog card, saved
summaries, modal editing, pending/error/retry and desktop/mobile layouts.
Live Google consent, API quotas and actual account data remain staging acceptance
steps. No account connection or deployment is part of local verification.
