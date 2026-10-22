# Google plugin

One built-in `google` plugin combines Docs, Sheets, Drive, Gmail and Search Console.
The deployment operator configures one Web application OAuth client, callback URL
and Enable switch per workspace. Each active Telegram member owns their account
connection and Search Console property selection in that workspace. No new dependency
or independently deployed service is required.

## Operator setup

Open **Plugins → Google → Web application → Edit**. Reuse an existing Google
**Web application** OAuth client. Enable the Docs, Sheets, Drive, Gmail and Search
Console APIs, configure consent and test users, and register the exact callback
shown in the dialog: `https://YOUR_ADMIN_HOST/api/admin/google/callback`.
The callback URL stays visible and copyable. A short read-only access summary
replaces the expanded scope list; open **OAuth scopes** for the exact permission
identifiers and their individual copy controls when configuring consent.
Save the client ID and secret, then enable Google. The application can be enabled
before any member connects. The panel shows saved application settings; personal
accounts and property selection are managed in Telegram.

Saving a blank secret preserves the existing secret for the same client ID.
Changing the client ID or supplying a replacement secret clears all personal account
connections and pending authorization flows in that workspace. Disabling the plugin
blocks reads and new connections; it does not disconnect members from other workspaces.

## Member connection in Telegram

In the bot's private chat, select the workspace when needed and send:

- `/google`: show your connected account/status, or offer **Connect Google account**.
- `/google connect` (also `/google reconnect`): start fresh Google consent.
- `/google status`: show connection status without starting sign-in.
- `/google properties`: discover and select your Search Console properties.
- `/google disconnect`: remove only your local connection and pending flows.

The consent link expires after ten minutes. Follow it in a browser, choose the
Google account and grant all five read scopes. The callback requires no admin-panel
login. Return to Telegram and press **Connect account** only if the displayed account
is yours, or **Reject**. Browser consent alone grants no runtime access. Confirmation
binds the encrypted tokens to the initiating Telegram member, workspace and bot.
Reconnect replaces only that member's connection and clears their Search Console
selection. Disconnect does not disable the shared plugin or other members' accounts.
Revoke provider authorization separately from Google's account connections page.

Property discovery filters unverified properties. The Telegram menu shows ten choices
per page and supports up to 20 selected properties, explicit Save and Cancel. Save
rechecks upstream access to every selected property. Drafts expire after ten minutes;
failed saves preserve them. Without a selection the other four services remain usable.
Property saves change only that member's selection revision, not the workspace plugin
revision or another member's account. See [Search Console](search-console.md).

## Migration

Apply `020_google_personal_accounts.sql` with the normal application migrations.
It removes old shared account tokens, pending admin consent and Search Console
service-account credentials/selections. Registered OAuth clients remain available.
The unified client can be used immediately; older separate clients can be reused by
opening the Google editor and saving once. Old product page links still lead to Google.
Every member must authorize and confirm their own account. Old shared tokens are
never promoted or assigned to a member, and old admin connection/property APIs are retired.

## Tools and limits

Only active workspace members in **private interactive conversations** can read their
own confirmed account. Workspace roles grant no access to another member's Google
data. Groups and scheduled workflows are denied before provider calls. Tokens and
refresh state are encrypted with workspace/member-specific associated data. Revoking
membership erases that member's connection and pending flows; workspace purge erases all.

| Tool | API / read scope | Arguments and result |
| --- | --- | --- |
| `query_google_docs` | Google Docs / `documents.readonly` | `{documentId}`; title and text from document tabs, paragraphs and tables |
| `query_google_sheets` | Google Sheets / `spreadsheets.readonly` | `{resource:"spreadsheet",spreadsheetId}` for metadata; `{resource:"values",spreadsheetId,range}` for explicit A1 formatted values |
| `query_google_drive` | Google Drive / `drive.readonly` | `{resource:"files",query?,pageToken?}` for literal filename search; `{resource:"file",fileId}` for metadata |
| `query_gmail` | Gmail / `gmail.readonly` | `{resource:"messages",query?,pageToken?}` for IDs; `{resource:"message",messageId}` for headers, snippets and plain text |
| `query_search_console` | Search Console / `webmasters.readonly` | Personal selected properties, finalized analytics, sitemaps and indexed URL inspection |

Scopes use `https://www.googleapis.com/auth/`; sign-in additionally requests `openid email`.
Google consent verification, Workspace policies, test-mode users and refresh-token
lifetimes still apply. HTTPS is required except loopback development. All members
and services share the exact callback URI from the saved admin site address.

Drive/Gmail lists return up to 20 items per page and preserve pagination/coverage
indicators. Gmail HTML and attachments are not downloaded; HTML-only messages retain
the provider snippet with `plainTextAvailable:false`. Responses are bounded to 1 MiB;
projected account-tool output to 32,000 bytes. Editing documents/cells, uploading,
sharing/deleting files and drafting/sending mail are unavailable.

## Authorization and durability

Admin application configuration retains session, exact Origin, CSRF, operator and
workspace checks plus optimistic plugin revisions. One-use consent state and S256
PKCE bind workspace, initiating member, bot, configuration revision and exact redirect
URI. The exchange is claimed durably before contacting Google. A verified account,
all five scopes and offline refresh token are required; confirmation happens in Telegram.
Duplicate/late callbacks cannot replace a disconnected or changed connection.
Telegram updates are deduplicated in the existing inbox transaction; confirmation and
property callbacks find their original workspace even if the user changes workspaces.

Refresh claims serialize reads per member without changing plugin revisions. Failed
or abandoned refresh requires reconnecting. Tool reads and retained/derived answers,
handoffs and delivery recheck the same member, private destination, connection identity
and current plugin revision. Search Console also checks the personal selection revision.
Queued consent/property controls also recheck their flow and bot before delivery.
Existing authorized admin history inspection rules still apply to retained runs.
Provider calls reject redirects and automatic retries, time out after 15 seconds,
and exclude upstream details/tokens from routine errors and audit records.

- `GET/PUT /api/admin/workspaces/:id/plugins/google`: redacted application settings.
- `GET /api/admin/google/callback`: public one-use consent return; grants nothing until Telegram confirmation.

See [application requests and Telegram examples](../../examples/google-workspace.http).
OAuth behavior was checked with Context7 against [Google's web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).
Live Google consent, actual permissions/quotas and native Telegram presentation remain
staging checks. Local verification uses deterministic provider and browser fixtures.
