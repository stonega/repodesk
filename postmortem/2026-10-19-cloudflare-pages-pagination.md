# Cloudflare Pages queries rejected pagination (2026-10-19)

A private conversation repeatedly returned `cloudflare_request_failed` for Pages
project queries while zone and DNS reads succeeded. The assistant suggested
reconnecting, which did not address the failed request.

RepoDesk appended `per_page=20` to every Cloudflare list endpoint. A read-only VPS
check using the saved token reproduced HTTP 400 with provider code 8000024 for
Pages projects at twenty results. The same token returned HTTP 200 and eight
projects with `per_page=10` or default pagination. The connection was valid.

The resource catalog now gives Pages projects and deployments a ten-result page,
uses endpoint-specific numeric/cursor pagination and locally paginates APIs that
return a single inventory. Regression coverage checks Pages' request parameters,
R2 cursors, unpaged Worker lists and sanitized pagination metadata. Companion
instructions distinguish request validation from expired authorization and explain
that the API-token panel has no Reconnect control.

The original traffic request also exposed a separate implementation gap: the
plugin had no Analytics query. Fixed, scoped GraphQL traffic queries now cover
requests, bandwidth, cache, threats and daily uniques with optional breakdowns.
A read-only provider smoke check accepted the overview query for an explicitly
selected zone using the existing token. No credentials, settings, DNS or routes
were changed. Deployment and live Telegram acceptance of the expanded plugin
remain outstanding; other products still need their own provider permissions and
plan entitlements.
