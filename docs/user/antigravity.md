# Antigravity CLI coding tasks

The built-in **Antigravity CLI** plugin runs isolated coding tasks, read-only repository investigations, version releases, and ready-for-review pull requests using Google's Antigravity CLI (`agy`) on the deployment's coding runner.

Ordinary chat does not imply Antigravity CLI is ready. Operators must configure the coding runner with `agy` available, authenticate Antigravity CLI in the Admin Panel, and connect GitHub repositories; members need verified GitHub write access for implementation tasks.

## Operator: configure the runner

Antigravity CLI shares the deployment's coding runner (`Docker`, `OpenSandbox`, or `Native VPS` in **Plugins → Antigravity CLI → Runtime**).

- **Native VPS**: Install `agy` on the host and ensure it is on `PATH` (or set `CODEX_NATIVE_AGY_BIN` to the absolute executable path).
- **Docker / OpenSandbox**: Ensure the `agy` binary is present in the coding job image and supervisor image (or mount/install it on the host for native mode).

## Operator: authenticate in the Admin Panel

Open **Plugins → Antigravity CLI**, toggle the title switch to enable the plugin, then click **Edit** on the **Configuration** card to choose a sign-in method:

### Google account (OAuth)

1. Choose **Google account (OAuth)** and save configuration if switching methods.
2. Reopen **Edit** and click **Sign in with Google**.
3. Open the displayed **Google sign-in** link in your browser and complete Google authentication.
4. Copy the authorization code (or the full callback URL) shown by Google, paste it into **Authorization code or callback URL**, and click **Complete sign-in**.

Credentials are sealed and encrypted per workspace on the runner supervisor. Token refreshes are persisted automatically across runs, and paused tasks resume automatically after reconnecting an expired session. Use **Disconnect account** to revoke local workspace credentials and stop active OAuth tasks.

### Gemini API key

1. Choose **Gemini API key**.
2. Paste your Google AI Studio Gemini API key into **Gemini API key** (write-only; encrypted on the server).
3. Optionally specify a **Model** slug (for example `gemini-4-neon-high` or `gemini-3.8-flash-high`), **Reasoning effort**, or a custom HTTPS **Gemini API base URL**.
4. Click **Save configuration**.

API key requests are proxied through the runner supervisor so task containers never receive the raw Gemini API key.

## Members: run tasks from Telegram

After linking your GitHub account with `/github` in private chat, ask the bot in ordinary language to implement a change, investigate a repository, or prepare a release:

- When **Antigravity CLI** is the only enabled coding plugin, Telo routes coding tasks to it automatically.
- When both **Codex** and **Antigravity CLI** are enabled, ask explicitly to use Antigravity CLI (or `agy`) to select it.

Antigravity CLI tasks support the same workflow as [Codex coding tasks](codex.md): read-only intake, implementation, automated verification checks, repair loops, ready-for-review pull requests (`antigravity/telo-*` branches), follow-up replies, task Q&A, repository investigations/releases, Telegram task history Mini App, and Model usage analytics.
