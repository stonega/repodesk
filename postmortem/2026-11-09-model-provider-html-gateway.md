# Provider save displayed a JSON parser error for an HTML gateway response

Date: 2026-11-09. Reported provider base URL: `https://aiapi.steedgrace.com/v1/`.

## Evidence and limits

The provider editor displayed `Unexpected token '<'` with a DOCTYPE fragment.
A second screenshot showed a Cloudflare 502 page naming the RepoDesk admin host,
`dev.stonegate.me`, at 06:20:32 UTC. The browser response body and server logs from
that request were not available, so the exact failing request and the cause of the
host/proxy failure remain unconfirmed. Subsequent public RepoDesk health/readiness
checks returned 200. SSH inspection was unavailable; no deployment was performed.

An unauthenticated GET to the provider's `/v1/models` returned JSON with HTTP 401,
as expected without an API key. Anonymous `/api/pricing` also returned JSON 401.
These checks do not validate the saved key or authenticated model discovery.

## Confirmed error-reporting defect

The shared admin request function parsed every response as JSON before handling
its status. A proxy HTML response therefore exposed a parser exception instead
of the useful HTTP failure. Model discovery already sent `Authorization: Bearer`
to `/models`, normalized trailing slashes, bounded responses and translated
upstream failures into safe application errors. Optional New API pricing used no
inference key and did not block a successful model list. The current official
[model-list](https://docs.newapi.pro/en/docs/api/ai-model/models/list/listmodels)
and [pricing](https://docs.newapi.pro/en/docs/api/management/system/pricing-get)
documentation confirms those authentication contracts.

## Correction and regression boundary

Admin JSON-read failures retain the HTTP status and show a fixed readable error.
Provider-save gateway 502/503/504 responses identify the failed model fetch and
suggest checking the API base URL and network access from the RepoDesk server.
Other admin gateway errors identify temporary RepoDesk unavailability. Session
expiry still opens sign-in, cancellation retains its existing behavior, and no
automatic write retry is introduced. Dialog drafts remain available for recovery.

Malformed upstream model JSON now has the specific `model_discovery_invalid`
code. Runtime logs retain the allowlisted discovery codes without response bodies,
keys or private text. Provider catalog operations have no workspace/run context;
the existing operator ownership checks still apply.

Production-composition regressions exercise New and Edit with HTML upstream
responses and assert safe JSON errors, fixed log codes and unchanged saved state.
Metadata tests cover optional pricing failures and authenticated model requests.
Browser regressions cover gateway HTML, malformed success responses, pending locks,
draft retention and explicit save recovery at desktop/mobile widths. These fixes
improve reporting and recovery; they do not establish or repair the underlying
production gateway outage.

## VPS reproduction and network diagnosis

The user supplied a further failure at **06:57:16 UTC**. SSH inspection became
available during follow-up. The app's safe `request_failed` event at
**06:57:16.705 UTC** matches that report. The deployed app had been running since
2026-11-05 with zero restarts, was not OOM-killed, and its health/readiness checks
returned HTTP 200. Its older log allowlist recorded the failure as
`unexpected_error`.

A read-only test inside the running app container used the supplied inference key
and the production request options. Node **v24.21.0** failed to connect to
`https://aiapi.steedgrace.com/v1/models` after about **10.6 seconds**, with
`TypeError` / `UND_ERR_CONNECT_TIMEOUT`. The separate anonymous pricing request
failed the same way. The API key was sent only in the model request's Bearer header
and was not written to a file, deployment configuration or diagnostic output.

The VPS host also timed out connecting to the provider on ports 443 and 80.
Container, host, Google DNS and Cloudflare DNS agreed on **114.55.242.113**.
Host connections to GitHub and Cloudflare succeeded; IPv4/IPv6 OUTPUT policies
were ACCEPT with no OUTPUT rules. No common outbound proxy service/listener was
found, and the app had no proxy environment configuration. An independent public
IP check confirmed the VPS's outbound IPv4 address is **169.58.58.71**.

At the same time, the local authenticated model request through the workstation's
configured HTTP(S) proxy returned HTTP 200 and 14 models. The key therefore works
on a reachable route; authenticated HTTP was never reached from the VPS. This
identifies a provider-specific network reachability failure from the VPS, without
establishing whether provider filtering, an upstream firewall or routing caused
the dropped connections. The gateway screenshot alone did not identify that cause.

The production-composition regression now includes Node connect-timeout failures
for both New and Edit, asserting safe JSON errors, sanitized fixed log codes and
unchanged provider state. Remediation requires a working route: a provider-supplied
alternate API endpoint, an approved outbound proxy, or investigation of the route
with the provider/VPS operator. No networking, credentials or deployment settings
were changed, and no model inference or Telegram message was sent.

Follow-up validation passed all 21 focused metadata/provider tests, repository
lint, strict TypeScript and the production build. The user reported having neither
an alternate API endpoint nor an outbound proxy. Restoring the direct route remains
an external provider/VPS network investigation.
