# Google

**Plugins → Google** combines Docs, Sheets, Drive, Gmail and Search Console in one
plugin. Administrators configure the shared **Web application** and **Enable**
switch; each member connects their own Google account in Telegram.

## Configure the application

1. Enable the Google Docs, Sheets, Drive, Gmail and Search Console APIs in the same Google Cloud project.
2. Open **Plugins → Google → Web application → Edit** and enter the client ID and secret of an existing Web application.
3. Copy the **Callback URL** into the client's authorized redirect URIs. The dialog summarizes read-only access; expand **OAuth scopes** for the exact permission identifiers and their copy buttons when configuring consent.
4. Configure Google's consent screen and test users, save the settings, then turn on **Enable**.

The callback URL is the admin site address followed by `/api/admin/google/callback`.
All members and five services share it. Update the callback in Google when the
admin domain changes. Replacing the client ID or secret clears all member
connections in the workspace; members must authorize again.

## Connect your account in Telegram

1. Select the workspace in the bot's private chat, send `/google` and choose **Connect Google account**.
2. Choose your Google account in the browser and grant the five listed read permissions.
3. Return to Telegram, verify that the displayed account is yours and choose **Connect account**. Choose **Reject** if it is the wrong account.
4. To use Search Console, send `/google properties`, select properties and choose **Save**.

Connection links and property selections expire after ten minutes. Browser sign-in
still requires confirmation in Telegram; no admin-panel login is needed. Google's
app verification, Workspace policies and test-user restrictions still apply.
When you start in a private Telegram topic, return to that topic for confirmation.
If an older installation sends the confirmation to General, open that topic and
choose **Connect account** there. If the attempt expired, send `/google connect`
and complete both browser sign-in and Telegram confirmation again.

- `/google` or `/google status`: show your account and status in the current workspace.
- `/google connect`: connect or reconnect; select Search Console properties again afterward.
- `/google properties`: select up to 20 of your Search Console properties across pages; **Save** commits the selection and **Cancel** discards the draft.
- `/google disconnect`: remove your connection in the current workspace without affecting other members or workspaces.

To revoke authorization at Google, visit [Google account connections](https://myaccount.google.com/connections).

## Access and limits

Each active member can read only their own confirmed account in private chats.
Admin roles grant no access to another member's Google account. Group chats and
scheduled workflows cannot read this personal data. Deactivating a member clears
their connection; rejoining requires authorization again.

- **Docs**: provide a document ID to read its title, tabs, paragraphs and table text.
- **Sheets**: provide a spreadsheet ID to read sheet information or cells in an explicit A1 range.
- **Drive**: find files by name and read their IDs, types and links.
- **Gmail**: search messages and read headers, snippets and plain text; attachments and HTML are not downloaded.
- **Search Console**: read your selected properties; see [Search Console](search-console.md).

Lists may be paginated. Editing, sharing, deleting files and sending mail are unavailable.

## Upgrade and recovery

Old individual plugin pages redirect to Google. Existing Web applications can be
reused; if prompted to reuse a legacy client, open **Edit** and save once. Old
workspace-shared accounts and service accounts no longer provide access; each
member must connect their own account.

If **Reconnect required** appears, send `/google connect`, authorize and confirm.
If the application is disabled or incomplete, ask an administrator to check
**Plugins → Google**.
