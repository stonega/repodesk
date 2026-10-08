# GitHub App connections

Implemented: guided GitHub App creation, workspace-scoped web authorization,
installation/repository selection, disconnect, and short-lived read-only installation
tokens for Code Truth, preconfigured authenticated Review Bot webhook intake on
public HTTPS deployments, plus Telegram issue drafts with explicit approval and
repository-scoped issue submission. No personal token is accepted by the web panel.

## Create the App from the panel

1. During first-run setup, click **Connect GitHub**. Setup creates a private,
   personally owned App automatically when needed. To choose an organization
   owner, select a workspace and use **Plugins → GitHub → Create GitHub App**.
2. Setup suggests `repodesk` as the App name and uses personal ownership. In
   Plugins, the editable App name also defaults to `repodesk`. GitHub lets you
   change the suggested name if it is already taken. **Personal account** is
   selected initially; choose
   **Organization** and enter its login when the organization should own the App.
   Leave **Allow installation on other GitHub accounts** unchecked for an App used
   only by its owner. Enable it when a personally owned App needs installation on an
   organization, or when supporting other accounts.
3. Setup sends the manifest when you click **Connect GitHub**. In Plugins, click
   **Continue to GitHub**. Confirm creation on GitHub. The manifest preconfigures
   Contents, Issues and Pull requests read/write access, Metadata read access,
   organization Members read access,
   `pull_request`, `issue_comment` and `pull_request_review_comment` webhook
   subscriptions, and the deployment's callbacks. These permissions support
   Codex checkout and PR publication; coding policies and task authorization
   still control each operation. The callback accepts exactly this permission set
   and rejects missing grants or additional permissions.
   With a public HTTPS domain, webhook delivery is enabled at
   `PUBLIC_ORIGIN/github/webhook/<operator-id>` (using the saved admin site domain
   when configured). Localhost, IP-address and non-HTTPS origins retain an inactive
   `https://example.com/github/webhook` placeholder because GitHub rejects local
   webhook URLs. Their event subscriptions are still preselected; configure a
   public HTTPS receiver before enabling delivery. Browser callback URLs retain
   the deployment's origin.
4. GitHub returns to the setup step or original workspace. The server exchanges its one-use code
   for App credentials, including GitHub's generated webhook secret, and encrypts
   them in PostgreSQL. Review Bot uses that secret automatically; nothing needs
   copying into `.env`, no extra Compose override is needed, and API/worker restarts
   are unnecessary.
5. In setup, authorize the account, then use the same **Connect GitHub** button
   to open GitHub installation. Choose repositories on GitHub and return to the
   setup tab. It detects the installation, connects the granted repositories and
   shows a RepoDesk welcome dialog. Click **Get started** to enter the workspace.
   In Plugins, installation and repository selection remain
   separate controls.

GitHub lists user authorization under **Authorized GitHub Apps**. That confirms
identity only. Repository access appears under **Installed GitHub Apps** after
installation. Setup does not mark the workspace connected until it verifies an
installation and saves the repositories chosen on GitHub. It connects all granted
repositories when exactly one installation is accessible. The workspace records
the repositories accessible at connection time; a new authorization and selection
flow is required to include repositories granted later. Multiple installations
require an explicit choice in Plugins.

App credentials are scoped to the local operator account and can be reused by that
operator's workspaces. Creating an App does not connect any workspace or grant it
repository access. Workspace connections and disconnects remain independent.
Review Bot remains disabled until a workspace operator configures its repositories
and enables it. Tagged requests still require verified member GitHub identities.
Existing GitHub Apps keep their names, webhook secrets and event subscriptions;
update their webhook settings manually using the [Review Bot guide](review-bot.md).

The button is hidden when an App is already available. Existing environment/file
credentials take precedence and remain supported.

Creation must finish within 10 minutes, in the same signed-in browser session.
Cancelled, expired, repeated or mismatched callbacks cannot save credentials.
Both App registration and user authorization use the exact configured callback
URL. The server keeps the setup return destination in its session-bound `state`
value, not in extra `redirect_uri` query parameters. If GitHub shows a
`redirect_uri` warning from an earlier attempt, start **Connect GitHub** again
to generate a new authorization URL.
If GitHub creates an App but the return/exchange fails, check whether the panel
already has an App; otherwise delete the unused App in GitHub before retrying, or
use the manual configuration below. There is no automatic deletion of GitHub Apps.
Keep the browser on the configured `PUBLIC_ORIGIN`; `localhost` and `127.0.0.1`
are different origins and sessions.

Migration `008_github_app_registration.sql` adds the encrypted operator App registry
and temporary registration state. Back up PostgreSQL and the application encryption
key through the existing protected backup process. Workspace deletion removes
its pending registration flows but retains the operator's shared App credentials.

## Register the App manually (alternative)

1. Create a GitHub App under your organization or personal GitHub developer settings.
   Choose which accounts may install it. Record its App ID, Client ID and URL slug.
2. Use the deployment's `PUBLIC_ORIGIN` as its homepage. Set the **Callback URL** to
   `PUBLIC_ORIGIN/api/admin/github/callback`, for example
   `http://localhost:3000/api/admin/github/callback` for this local deployment.
   A production origin uses HTTPS. The URL must match exactly; no extra query parameters.
3. For the full coding workflow, grant **Repository permissions → Contents: Read
   and write**, **Issues: Read and write** and **Pull requests: Read and write**.
   Metadata read access is included by GitHub. Code Truth alone uses Contents-read
   tokens; issue submission uses Issues-write tokens. Organization and Actions
   permissions are unnecessary for these coding workflows. To fetch organization
   members in member forms, also grant **Organization permissions → Members: Read-only**.
4. A setup URL is unnecessary: the panel authorizes the user first, then lists their
   App installations. Leave webhooks disabled unless using [Review Bot](review-bot.md). Its
   optional receiver requires the displayed operator-specific URL, a saved secret
   and explicit event subscriptions in the GitHub App settings. Installation suspension/removal is checked when minting tokens.
5. Generate a client secret and a private key. Save them under `secrets/` with private
   file permissions. Never commit them or paste them into the panel.

## Configure Docker or Podman

Add the non-secret App identifiers and secret file paths to the local `.env`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv1.replace
GITHUB_APP_SLUG=your-app-slug
GITHUB_APP_PRIVATE_KEY_FILE=./secrets/github-app-private-key.pem
GITHUB_APP_CLIENT_SECRET_FILE=./secrets/github-app-client-secret
COMPOSE_FILE=compose.yaml:examples/code-truth.compose.yaml:examples/github-app.compose.yaml
```

The private key file contains the downloaded PEM. The client-secret file contains
only the secret. The runtime container user must be able to read both files; on
rootless SELinux hosts, apply the same UID ACL and shared container label as the
existing encryption key. Keep the containing directory private.

Build the app and Code Truth images, apply migration `007_github_app.sql`, and
restart app/worker/Code Truth with all three Compose files. For an already-updated
installation that only needs the App credentials enabled:

```sh
podman compose config --quiet
podman compose up -d --no-build
```

Host processes accept `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_CLIENT_SECRET`, or
the `_FILE` forms above. All five App settings must be provided together.

## Connect a workspace

1. Select the workspace and open **Plugins → GitHub → Connect GitHub**.
2. Authorize the GitHub App in the browser. The callback returns to the same workspace.
3. If there is no installation, use **Install or update the GitHub App**. Select the
   required repositories on GitHub. Organization owners may need to approve it.
   Return to the panel and **Reload GitHub connection**.
4. Choose the installation and repositories, then **Connect selected repositories**.
5. Configure matching repository URLs and branch names in Code Truth, save, then
   **Sync & check indexes**. Connection alone does not add targets or enable Code Truth.

The user authorization/selection window expires after 10 minutes. Start Connect
GitHub again if it expires or GitHub denies access. For SAML organizations, establish
an active organization SSO session before authorizing the App.

The connected GitHub card lists repositories with links to GitHub. It has no
change-connection or disconnect button. The workspace-scoped DELETE API still
disconnects only this workspace; it does not uninstall the App from GitHub or
affect another workspace. It also explicitly disables the legacy shared GitHub
token fallback for this workspace. Public repository access remains possible.
Workspaces without a connection record retain legacy deployment access until connected
or disconnected. Once every private-repository workspace uses the App, remove the
legacy `CODE_TRUTH_GITHUB_TOKEN` from `.env` and recreate Code Truth.

### Automatic repository updates

Manage GitHub and the Codex repository lists refresh every five seconds while
visible, and immediately on focus or return to a visible tab. Pending Codex
sign-in retains its three-second interval. Refresh keeps the existing list,
expanded items and unsaved drafts visible. The repository selector retains the
selected numeric ID through renames; background refresh also preserves the
editor's settings revision so a concurrent settings edit still conflicts on save.

The server reads current repository names and visibility from
[GitHub's installation repository list](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).
It uses an in-memory, short-lived Metadata-read token; it has no source or write
permission and never leaves the backend. Responses are filtered to the
workspace's selected numeric IDs. Repositories no longer available to the App
are removed; a new repository using an old name does not gain workspace access.
Newly granted or restored repositories require a new authorization/selection flow.
Matching workspace Code Truth URLs follow renames, retaining their configured
branches. Metadata changes advance the connection revision, invalidating older
pinned approvals and runs; unchanged polls do not advance revisions. Concurrent
refreshes share one request and successful or failed checks are cached for three
seconds. Tokens are reused until near expiry and discarded after an upstream failure.

Polling stops for hidden pages and closed GitHub dialogs. GitHub outages,
denied access and invalid responses retain the last saved list and show an update
notice; normal tool permission checks still apply. Reconnect, disconnect,
ownership revocation or deletion during a request prevents that response from
replacing newer state. Updates are near realtime while the list is open; webhooks
are separate from this polling flow; there is no background repository metadata sync
while the panel is closed.
No migration, new dependency or App permission change is required. See the
[manual staging check](../../examples/github-repository-sync.md).

## Security and API

POST `/api/admin/workspaces/:id/github/register` accepts
`{owner: "organization", organization: "example", name: "repodesk", public: false}`
or `{owner: "personal", name: "repodesk", public: false}`. Omitting `name` uses
`repodesk`. It returns only the public manifest and a fixed GitHub form destination.
The browser POSTs `manifest`
as a JSON string. GET `/api/admin/github/app/callback` exchanges the temporary code
server-side, then redirects to the originating workspace without secrets or codes.
Registration requires workspace operator ownership, Origin/CSRF, rate limiting and
one-use session/admin/workspace-bound state. Returned owner, permissions and RSA key
are validated. A unique operator record prevents concurrent flows overwriting keys.
Client secret, private key and generated webhook secret are encrypted with
operator-bound AES-GCM. New manifest conversions require a nonempty webhook secret;
existing App records without one remain supported. Review Bot uses the generated
secret unless the operator explicitly configures a replacement. API/worker load
the saved App on demand; safe UI status exposes only its slug and installation link.

`/api/admin/workspaces/:id/github` supports GET (safe status), PUT (connect selected
installation/repository IDs), and DELETE (disconnect), with expected connection revisions.
POST `/connect` starts OAuth; GET `/installations/:installationId/repositories` lists
repositories accessible to the authorizing user. These endpoints require the workspace's
operator, an active session, and Origin/CSRF checks on mutations.

OAuth uses random one-use state, PKCE S256, a 10-minute deadline and exact session,
admin and workspace binding. The session cookie is HttpOnly, SameSite=Lax (Secure
on HTTPS) so the browser can return from GitHub; ordinary mutations still require
Origin and CSRF. Forged installation IDs are checked against the user token's own
installations and repository access. Only selected accessible repository IDs can be saved.

Temporary user tokens and PKCE verifiers are encrypted with workspace/session-bound
AES-GCM and never returned to the browser. The selection token is deleted on connection,
disconnect, session revocation, expiry or workspace purge. The worker cleans expired
flows periodically. Refresh tokens are discarded because ongoing work uses the App's
installation identity rather than a persistent user token.

The worker mints Contents-read installation tokens restricted to configured, connected
repository IDs. Private keys stay in the app/worker. The private Code Truth service
receives only ephemeral installation tokens and a workspace connection identity; these
are held in memory, excluded from public status, namespace paths and persisted metadata.
Token refresh reuses the same index namespace. Reconnect/disconnect changes connection
identity and invalidates pinned runs without exposing another workspace's cached source.
Existing snapshots remain subject to the separate retention policy in [Code Truth](code-truth.md).

Sources: [GitHub App web authorization and PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[installation token repository and permission restrictions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[why installation IDs alone are not proof of access](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

The guided creation flow uses [GitHub App Manifests](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
Reference inspected: Coolify commit `89e8506023af83016e3ccd64dc1327f51a7f8674`,
[manifest form](https://github.com/coollabsio/coolify/blob/89e8506023af83016e3ccd64dc1327f51a7f8674/resources/views/livewire/source/github/change.blade.php#L345)
and [server-side conversion](https://github.com/coollabsio/coolify/blob/89e8506023af83016e3ccd64dc1327f51a7f8674/app/Http/Controllers/Webhook/Github.php#L509).
RepoDesk requests Contents, Issues and Pull requests write permissions plus Metadata
and organization Members read, and keeps its own session/tenant checks. Installation tokens remain scoped to
the selected repository and operation; Code Truth receives only source-read tokens.

## Update an existing App for Codex

Changing RepoDesk's new-App manifest does not update Apps already registered on
GitHub. For an existing App, open its **Permissions & events → Repository
permissions** and set Contents and Pull requests to **Read and write**, retaining
Issues **Read and write** and mandatory Metadata **Read-only**. Save changes.
At [Installed GitHub Apps](https://github.com/settings/installations), open
**Review request** for the matching installation and choose **Accept new
permissions**. Organization owners may need to approve organization installations.
The new permissions apply only after installation approval; reconnecting RepoDesk
does not grant them. See [GitHub's permission-update guidance](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app).

Keep the existing repository selection unless intentionally changing it. An
installation configured for **All repositories** receives the accepted write
permissions for all repositories it can access; application task checks still
restrict RepoDesk's operations to selected workspace repositories.

Validate both a Contents-read/Pull-requests-read token (Direct preparation) and a
Contents-write/Pull-requests-write token (publication) scoped to the configured
repository. A Contents-read checkout alone does not prove the publication grant.
`github_app_permissions_missing` means the requested scope is still unavailable.
This check requires neither a model call nor a push, issue or PR. See the
[registration request example](../../examples/github-app-permissions.http).

## Submit an issue from Telegram

Ask the assistant, for example: “Create an issue in example/workspace titled
‘Recap omits the last message’. Include these reproduction steps: …”. The built-in
`propose_github_issue` tool is available when the workspace has a connected GitHub
installation and selected repositories; Code Truth need not be enabled.

The bot shows the repository, exact title and body with **Approve** / **Reject**.
Only the requesting actor can approve, within 15 minutes. Approval publishes the
content under the GitHub App's identity and may notify repository subscribers.
Titles are limited to 256 characters and bodies to 3,000 so the complete review fits
in one Telegram message. Labels and assignees are not part of this first version.
There is no issue-submission form in the web panel.

After approval, the worker submits the issue and sends its link to the original
chat/topic. It rechecks membership, run cancellation, deployment/workspace pause,
connection revision and repository selection immediately before reserving the send.
Disconnecting or changing repositories invalidates outstanding proposals. As with
other external operations, revocation cannot undo a POST already in flight.

**Existing Apps:** open the App's settings on GitHub, change Repository permissions
→ Issues to **Read and write**, save, and approve the permission update for the
installation (organization approval may be required). Reconnecting alone does not
grant a missing permission. Newly created Apps request it through the manifest.
Code Truth continues to use Contents-read tokens; issue submission obtains a separate
short-lived Issues-write token limited to the single approved repository. Legacy
Code Truth tokens cannot submit issues.

A committed approval record reserves each send before the POST. Duplicate approvals
are rejected; concurrent workers and restarts never replay a reserved send. A timeout,
server error or crash with an uncertain outcome is reported as **unknown**. Inspect
the repository before asking for a new draft. Known failures (missing permission,
disabled issues or rejected input) are reported without including GitHub response
bodies or credentials. No automatic retry is performed. Drafts/results follow the
existing approval retention and workspace-deletion policy.

See [the example and deterministic verification](../../examples/github-issue.md).
API reference: [Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue).

## Fetch GitHub accounts in member forms

Implemented locally, 2026-10-07. Add/Edit member dialogs fetch account choices
automatically from the workspace's connected installation. Organization installations
return organization members; personal installations return the owner and collaborators
of the workspace's selected repositories. Pages are fetched in batches of 100, with
the existing 2,000-entry limit per list. Accounts are deduplicated by numeric GitHub ID.
The directory returns only IDs/logins and connection metadata, with no credentials.
Personal repository lists run in batches of at most eight concurrent requests,
preserving selected-repository order when merging accounts. The complete directory
has a 60-second lookup budget; failed or timed-out batches cancel remaining requests
and return an error instead of partial choices. The dialog also ends a stalled
request after 65 seconds and offers **Try again**, preserving role and membership
edits. Normal membership saves remain available if GitHub lookup fails.

Existing organization installations need **Permissions & events → Organization
permissions → Members: Read-only**, followed by approval of the installation's updated
permissions. The form explains this when the grant is missing; it never substitutes a
partial public-member list. Personal installations use Metadata-read access.
See GitHub's [organization member API](https://docs.github.com/en/rest/orgs/members#list-organization-members)
and [collaborator API](https://docs.github.com/en/rest/collaborators/collaborators#list-repository-collaborators).

Selecting an account saves a workspace-scoped `member.githubAccount` association.
It does not create an OAuth token or repository permission snapshot. GitHub supplies
no Telegram identity: an administrator explicitly selects the person's account, and
the member can verify it with `/github connect`. The table shows **Verification pending**
until verified. Verified accounts use the member's connection flow to change accounts.
The same GitHub ID cannot be assigned or verified for two members in one workspace;
OAuth confirmation also checks administrator-created associations.

`GET /api/admin/workspaces/:id/members/github` returns
`{ connected, revision, account?, source?, members: [{ id, login }] }`.
`POST /api/admin/workspaces/:id/members` optionally accepts `githubId` (numeric ID,
or `null` to clear an unverified association) and `githubRevision`. The server
fetches the chosen identity, rechecks workspace authority and connection revision,
and saves the association with the versioned membership update in one transaction.
Omitting these fields preserves the association, including during GitHub outages.
No new dependency or database migration is required; profiles use workspace JSON.
See [the runnable request example](../../examples/github-members.http).

## Connect a verified Telegram member's GitHub account

Implemented locally, 2026-10-05. Apply `012_github_users.sql` through the normal
migration command before starting the updated app and worker. No new dependencies
or webhook subscriptions are required; the existing GitHub App callback URL is reused.

An active workspace member sends
`/github connect` in the bot's private chat. The bot supplies a ten-minute GitHub
App authorization link with PKCE. After GitHub returns, the member must confirm the
identified GitHub account using a button in that same Telegram account's private
chat. Browser authorization alone never links an account. Group commands cannot
produce authorization links. With multiple workspaces, select one using
`/workspace <id>` first. No panel login or extra RepoDesk account is needed.

The link records GitHub's stable numeric user ID, login and repository permission
snapshot on the workspace member. Members & access displays these details.
One GitHub identity can belong to only one Telegram member within a workspace;
links and permissions are independent between workspaces. GitHub admin/maintain
access never promotes a RepoDesk member to workspace administrator, bypasses the
membership or grants an admin role.

Permission synchronization uses GitHub's
[List repositories accessible to the user access token](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token).
Only repositories also selected in the workspace connection are imported.
Read/triage/write/maintain/admin flags are kept as upstream repository permissions.
Linked users' repository lookup, source retrieval and issue proposals require read
access; coding additionally requires GitHub write/admin access and the operator's
existing coding-maintainer grant. Existing unlinked members retain the previous
operator-managed repository policy. Linking adds the upstream restriction; subsequent
disconnect does not restore that member's previous unrestricted repository access.
This is an additive rollout, not mandatory GitHub identity enrollment for all members.

The worker refreshes each account about every five minutes, in bounded batches
independently of Telegram polling and job maintenance. `/github sync` refreshes
immediately. Snapshots older than ten minutes, workspace connection revisions that
have changed, missing permission fields and failed API calls deny linked repository
access. Downgrades cancel that actor's queued/active assistant work, pending GitHub
approvals and coding tasks. Already completed remote actions and group replies cannot
be undone. Remote permission changes have a polling delay; no real-time webhook
revocation is claimed.

`/github disconnect` deletes the encrypted user credential and pending authorization
state, clears permission grants, and cancels pending work. Member deactivation
also removes user credentials during the next worker sync; workspace deletion purges
credentials and flows through worker maintenance. Temporary states are one-use,
actor/workspace/bot/App/revision bound and expire after ten minutes. Credentials
use workspace/actor-bound AES-GCM and are never returned in member APIs, previews,
model context or routine logs.

Expiring user access tokens rotate automatically using an encrypted refresh token.
Rotation is serialized by the workspace transaction; new access/refresh credentials
replace the previous pair. Revoked tokens, expired refresh tokens or failed rotation
clear effective grants; use `/github connect` to authorize again when needed. See
GitHub's [refresh-token guidance](https://docs.github.com/en/enterprise-cloud%40latest/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
Local tests use fake GitHub responses and disposable PostgreSQL; real account linking
and permission changes remain live acceptance checks. Local implementation does not
connect accounts, send live Telegram messages or deploy this change.
