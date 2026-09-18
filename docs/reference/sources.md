# Source register

All pages below were reviewed on **2026-09-18**. Site content and beta pricing may
change. Links use canonical URLs without the supplied tracking parameter.

| ID | Source | What it supports / how reviewed |
| --- | --- | --- |
| E1 | [Every Agent homepage](https://agent.every.to/) | Positioning, audience, weekly recaps, follow-ups, Figma example. Read public HTML; web fetch tool initially failed, direct HTTPS succeeded. |
| E2 | [Interactive tour](https://agent.every.to/learn) | Three feature slides and final FAQ. Opened in Chrome, advanced through all four slides, expanded all eight FAQ questions. |
| E3 | [Slack installation and FAQ](https://agent.every.to/install/slack) | Full public FAQ, scope modes, access rules, memory, dashboard, retention, and membership pricing. Read public HTML; corroborates tour FAQ. |
| E4 | [Pricing](https://agent.every.to/pricing) | Usage billing, prepaid balance, auto-refill and caps. Conflicts with E2/E3 membership language. |
| E5 | [Support](https://agent.every.to/support) | Mentions and DMs, support channel, diagnostic information. |
| E6 | [Privacy policy](https://agent.every.to/legal/privacy-policy) | Effective 2026-08-17; Google data, subprocessors, classifier, files, browsing, retention and deletion. Read public HTML, with focused extraction of retention/subprocessor sections. |
| E7 | [Terms](https://agent.every.to/legal/terms-of-service) | Google operation categories, accounts, team members and payment terms. Reviewed for product scope, not legal advice. |
| E8 | [Every Help Center](https://help.every.to/en/) | Linked help destination inspected; no additional agent-specific feature article verified. |
| T1 | [Telegram Bot API](https://core.telegram.org/bots/api) | Current API reference. Queried via Context7 and official web documentation. |
| T2 | [Telegram bot features](https://core.telegram.org/bots/features) | Commands, privacy mode, Mini Apps, topics, newer bot-to-bot and guest features. |
| T3 | [Telegram bot FAQ](https://core.telegram.org/bots/faq) | Delivery modes, rate limiting, general update behavior. Older bot-to-bot wording conflicts with T2; use the more specific current feature documentation. |
| D1 | [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers) | Historical bootstrap source; superseded for runtime by the Node/Docker decision. |
| D2 | [Hono testing](https://hono.dev/docs/guides/testing) | In-process request testing, retrieved with Context7. |
| D3 | [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) | Historical Cloudflare bootstrap reference; no longer our deployment target. |
| D4 | [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/) | Historical bootstrap CLI reference; Wrangler has since been removed. |
| D5 | [Harness AGENTS template](https://raw.githubusercontent.com/stonega/harness/refs/heads/main/_AGENTS.md) | Repository instructions adapted for this standalone backend. |

## Boundaries

No Every account was created, app installed, payment made, or authenticated dashboard
inspected. The research verifies public statements, not actual execution quality,
connector completeness, or internal implementation. Illustrative Slack conversations
are marketing examples. The dashboard inventory is described by the FAQ; its controls
were not tested. Privacy disclosures suggest technical capabilities but do not establish
availability, performance, or a supported connector catalog.

The site's `robots.txt` and `sitemap.xml` returned 404 during discovery. Navigation
links and the interactive tour were used to find relevant public pages. General Every
editorial articles and its other products were excluded from the core feature inventory.

This repository stores original research notes and product requirements rather than
copies of the site's HTML, marketing assets, or source code.

## Implementation-plan sources (2026-09-18)

- [Pi upstream](https://github.com/earendil-works/pi) and its agent/AI package README
  and manifests: verified current naming and embedded runtime APIs using Context7
  and direct official documents. Older examples use a different package scope.
- [pg-boss](https://github.com/timgit/pg-boss#readme): PostgreSQL jobs, transactions
  and retries. Context7 did not resolve the upstream package; official docs used.
- [Hono Node adapter](https://hono.dev/docs/getting-started/nodejs): server and shutdown.
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/):
  image layout; official Docker documentation retrieved with Context7.
- [React Router SPA mode](https://reactrouter.com/how-to/spa): static admin UI and
  client data-loading design, retrieved with Context7.
- [Telegram web login](https://core.telegram.org/bots/features#web-login): admin identity.

Pi, PostgreSQL, pg-boss and the web panel remain planned. The Node/Docker scaffold
was built and smoke-tested locally; no production deployment occurred.
