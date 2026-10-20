# Read public pages

In Telegram, ask:

> Read https://example.com and summarize the page, citing its URL.

The worker supplies this preset independently of Search providers:

```json
{"name":"read_web","arguments":{"url":"https://example.com"}}
```

The result contains `url` (the final destination after redirects), `title`,
`description`, `author`, `published`, `markdown` and `truncated`. Missing metadata
uses empty strings. A failed read returns a fixed error such as:

```json
{"error":"web_read_unsupported_content"}
```

To search and then read, first select a search provider in Model settings, ask
for current sources, and have the assistant read the relevant result URLs.
Direct page reading works with search disabled. It also works in an authorized
daily/weekly workflow whose task names the public page; stopping the workflow or
revoking its owner/destination blocks further reads.

Use public HTML pages without login or access tokens. JavaScript-only content,
PDFs and private-network URLs are unsupported. Long pages return at most 24,000
Markdown characters with `truncated: true`; the answer should disclose a material
coverage limit. Page instructions never authorize application actions.
