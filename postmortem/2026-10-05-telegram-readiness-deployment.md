# Telegram readiness check stopped a healthy release

Date: 2026-10-05. Release attempt: `37272312882-1`, commit
`890533732f5958a99caa5fbd7432290eb7e16e4e`. Times below are UTC.

## Impact and evidence

The app and worker were stopped at approximately 06:32:28, leaving PostgreSQL
healthy and Caddy running. Public requests to `/admin/plugins`, `/`, `/healthz`
and `/readyz` returned HTTP 502. Caddy reported a refused connection to its
upstream at `127.0.0.1:3000`.

[The deployment log](https://github.com/stonega/deepx-telegram-bot/actions/runs/37272312882)
shows successful migrations, app/worker startup at 06:32:21, healthy container
checks at 06:32:26–27, then deployment failure and intentional shutdown.
Database migration records confirm migrations 011–013 completed at 06:32:20.
Neither container was killed by an out-of-memory condition; both exited cleanly.

## Cause

The deployed script checks `/readyz` once immediately after Compose reports both
containers healthy. The app health check uses `/healthz`; the worker check uses
its database heartbeat. These checks can pass before Telegram polling is ready.
`TelegramPoller.pollOnce` marks the receiver ready only after its first
`getUpdates` call completes; that call requests a 25-second long poll.

During recovery, the same containers passed their health checks while `/readyz`
still returned HTTP 503 with `telegram_polling_unavailable` at roughly 25 seconds.
At roughly 45 seconds, `/readyz` returned HTTP 200 with `ready`, without any
configuration or image changes. The release's single readiness check ran about
six seconds after container startup. Its failure invoked the deployment error
handler, which stopped both writers.

## Recovery and verification

At approximately 12:34:41, restarted the existing app and worker containers under
the deployment lock, using their existing image and configuration. No migrations,
rollback, database restore, webhook registration or account connection were run.
The original backup and encryption key were preserved.

Verified all three containers healthy with zero app/worker restarts, local
`/readyz` HTTP 200, public `/admin/plugins` HTTP 200, and the authenticated Plugins
page rendered in the user's browser. The earlier `.current-release` marker was
left unchanged: this was manual recovery of the failed release's containers,
not a completed deployment-script run.

## Prevention still required

Replace the single readiness request with bounded retries that allow the first
Telegram long poll to complete. Report the readiness status on failure. Preserve
the existing shutdown behavior when the bounded readiness window actually
expires, and test both delayed readiness and persistent failure before shipping
a new release. This recovery did not modify the deployment script.

The VPS currently has only the base app/worker/PostgreSQL stack; no Podman binary
or Codex supervisor was found. Codex device-code connection remains a separate
deployment setup task.
