# Browser workflows

These examples need the installed host service, Browser enabled, and the bot's
main Mini App URL set to the deployment's HTTPS `/mini` page. They make no live
account connections automatically.

## Private chat

Send in the bot's private conversation:

> Open my dashboard at https://example.com/account using Browser. Ask for any
> password or code through Browser, then summarize the dashboard privately.

Open **Browser** from the task's message. Review each site and interaction.
Requested input goes to the task's current field. The original conversation run
pauses and resumes; a separate chat message containing the password is unnecessary.
An additional login-provider/asset origin can be requested using
`browser_action({action:"request_site",url:"https://accounts.example.com"})`.
Approval adds that origin without navigating away. Page reads include visible
controls/selectors and observed blocked origins, without reading form values.

## Codex

> Implement the requested change in the selected repository. Use Browser to
> inspect the authenticated dashboard. Request private input through Browser.

Codex's native dynamic tools reach the same broker through its attempt's channel.
The supervisor forwards only to the application-issued task capability. Jobs do
not receive the host browser key, socket, cookies or profile directory. A browser
wait lasts at most ten minutes; cancellation and current repository, membership,
bot and Browser grants remain authoritative.

The protocol proof uses pinned Codex 0.155.1 and a local fake provider only:

```sh
CODEX_BROWSER_PROOF=1 bun scripts/codex-conversation-proof.ts
```

Set `CODEX_PROTOCOL_BINARY` to an already installed matching CLI binary to avoid
package resolution inside the temporary fixture home. The proof verifies Browser
dynamic tools, waiting without replay, and restoration on the same native thread.
It is not a live provider, Telegram or website-account demonstration.

## File plugin

`examples/browser-plugin.ts` registers `open_private_site`. Mount its reviewed
installed file at the same path in API and worker, register that tool name, and
enable **Allow this plugin to request the member's Browser** in its Edit dialog.
The default is denied. Each executing tool receives an optional `context.browser`
with `action(...)` and `session(...)`; hooks and ungranted plugins do not receive it.

Make one broker operation per tool invocation and return a waiting receipt
immediately. The application binds it to that original call, user, plugin grant,
execution fence and profile. A resumed tool result replaces the wait; plugin code
must not automatically replay an uncertain operation. Grant changes revoke stale
access. This API does not turn trusted server-side file plugins into a sandbox.
