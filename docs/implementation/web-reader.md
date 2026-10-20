# Built-in web reader

`read_web` is an application-owned preset tool, available to normal chat runs
and authorized scheduled runs without a provider, API key, file plugin or skill
grant. Search remains independently configured. The only input is a public
HTTP(S) `url`; the result contains the final URL, title, description, author,
publication date, clean Markdown and an explicit truncation flag.

The reader uses pinned dependencies `defuddle` 0.19.5 for content extraction and
`linkedom` 0.18.13 for a non-executing DOM. These are direct runtime dependencies;
there is no shell invocation, global CLI installation or hosted reader API.
Defuddle's Node API uses `markdown: true`, `useAsync: false` and a rejecting fetch
override. Extraction runs in a terminable worker with a 128 MiB V8 old-generation
limit. Parser diagnostics are discarded to avoid logging raw external content.
The build emits `web-reader-extract.js` alongside the worker/server bundles.

## Request boundaries

- Only HTTP/HTTPS on their default ports, with no URL credentials; at most 2,048
  URL characters. Fragments are removed before durable argument comparison.
- Private, loopback, link-local, multicast, reserved and special-purpose IPs are
  denied. IPv6 is restricted to public global-unicast addresses, excluding
  special-purpose, documentation and 6to4 ranges. IPv4-mapped IPv6 is denied.
- Every DNS answer must pass the public-address check. The socket connects only
  to a checked IP while retaining the original Host/SNI and TLS verification.
  Each redirect is validated and resolved independently; at most five redirects.
- Requests send no application credentials, cookies or referer, and do not use
  ambient HTTP proxy variables. Responses never establish a cookie session.
- Twenty seconds covers resolution, all requests and extraction. The caller's
  cancellation signal also stops the request and extraction worker.
- Only HTML/XHTML is accepted. Encoded and decompressed responses are each
  limited to 2 MiB; gzip, deflate and Brotli are supported. Markdown is capped
  at 24,000 characters; metadata fields have separate small limits.

No scripts, subresources or additional extractor requests run. Authenticated,
paywalled, challenged or client-rendered pages may fail or have incomplete text.
The tool does not bypass access restrictions or read PDFs.

## Authorization and recovery

The worker applies deployment guards and rechecks workspace/run identity, current
membership, destination, cancellation, status and lease fence before dispatch,
before cached reuse and before saving a result. Network work occurs outside the
workspace transaction. Started calls are durable; a duplicate completed call
reuses its result, changed arguments fail, and unknown outcomes never replay
automatically. Fixed `web_read_*` codes omit raw network/parser exceptions.

All page text and metadata are untrusted references. They cannot grant tool
authority. Answers cite the final URL separately from chat source IDs. URLs must
not include secrets, private content or signed access tokens. Retained tool
results follow existing run retention and deletion behavior.

See [example requests](../../examples/web-reader.md) and
[the upstream Node API](https://github.com/kepano/defuddle#nodejs).
