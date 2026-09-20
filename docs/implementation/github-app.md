# GitHub App connections

Implemented: guided GitHub App creation, workspace-scoped web authorization,
installation/repository selection, disconnect, and short-lived read-only installation
tokens for Code Truth. No personal token is accepted by the web panel.

## Create the App from the panel

1. Select a workspace and open **Plugins → GitHub → Create GitHub App**.
2. Enter an App name, choose **Organization** or **Personal account**, and enter the
   organization login when applicable. Leave **Allow installation on other GitHub
   accounts** unchecked for an App used only by its owner. Enable it when a personally
   owned App needs installation on an organization, or when supporting other accounts.
3. Click **Continue to GitHub** and confirm creation on GitHub. The form preconfigures
   Contents/Metadata read access, no webhook events, and the deployment's callbacks.
   GitHub requires a publicly addressable webhook URL even when delivery is disabled.
   The inactive hook uses `https://example.com/github/webhook` as a reserved-domain
   placeholder. It receives no events; local browser callback URLs remain unchanged.
4. GitHub returns to the original workspace. The server exchanges its one-use code
   for App credentials and encrypts them in PostgreSQL; nothing needs copying into
   `.env`, no extra Compose override is needed, and API/worker restarts are unnecessary.
5. Use **Install or update the GitHub App** to select repositories on GitHub, then
   **Connect GitHub** to authorize and select repositories for this workspace.

App credentials are scoped to the local operator account and can be reused by that
operator's workspaces. Creating an App does not connect any workspace or grant it
repository access. Workspace connections and disconnects remain independent.
The button is hidden when an App is already available. Existing environment/file
credentials take precedence and remain supported.

Creation must finish within 10 minutes, in the same signed-in browser session.
Cancelled, expired, repeated or mismatched callbacks cannot save credentials.
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
3. Grant **Repository permissions → Contents: Read-only**. Metadata read access is
   included by GitHub. No write or organization permissions are required.
4. A setup URL is unnecessary: the panel authorizes the user first, then lists their
   App installations. Leave webhooks disabled for this implementation; there is no
   webhook receiver. Installation suspension/removal is checked when minting tokens.
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
4. Choose the installation and up to 12 repositories, then **Connect selected repositories**.
5. Configure matching repository URLs and branch names in Code Truth, save, then
   **Sync & check indexes**. Connection alone does not add targets or enable Code Truth.

The user authorization/selection window expires after 10 minutes. Start Connect
GitHub again if it expires or GitHub denies access. For SAML organizations, establish
an active organization SSO session before authorizing the App.

**Disconnect GitHub** disconnects only this workspace; it does not uninstall the App
from GitHub or affect another workspace. It also explicitly disables the legacy shared
GitHub token fallback for this workspace. Public repository access remains possible.
Workspaces without a connection record retain legacy deployment access until connected
or disconnected. Once every private-repository workspace uses the App, remove the
legacy `CODE_TRUTH_GITHUB_TOKEN` from `.env` and recreate Code Truth.

## Security and API

POST `/api/admin/workspaces/:id/github/register` accepts
`{owner: "organization", organization: "example", name: "DeepX Agent", public: false}`
or `{owner: "personal", name: "DeepX Agent", public: false}`. It returns only the
public manifest and a fixed GitHub form destination. The browser POSTs `manifest`
as a JSON string. GET `/api/admin/github/app/callback` exchanges the temporary code
server-side, then redirects to the originating workspace without secrets or codes.
Registration requires workspace operator ownership, Origin/CSRF, rate limiting and
one-use session/admin/workspace-bound state. Returned owner, permissions and RSA key
are validated. A unique operator record prevents concurrent flows overwriting keys.
Client secret and private key are encrypted with operator-bound AES-GCM. The webhook
secret is discarded because webhooks are disabled. API/worker load the saved App
on demand; safe UI status exposes only its slug and installation link.

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
DeepX requests only source-read permissions and keeps its own session/tenant checks.
