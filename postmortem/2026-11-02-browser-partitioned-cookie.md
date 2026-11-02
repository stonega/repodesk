# YouTube redirects were reported as Browser unavailability

## Impact

On 2026-11-02, workspace `3b2dfe82-61c6-444e-8058-7a179f2bf27a`, run
`f4a1cac1-f7f6-47dd-906d-29a9b3bd5c9e` approved YouTube access and resumed the same
Pi transcript. Native navigation then failed and was reported as
`browser_service_unavailable`. The assistant fell back to static extraction and
could not obtain the requested channel video list. The website consent remained
saved; task continuity and consent persistence were working.

The same run's first Code Truth list returned unavailable while its namespace was
initializing. Both repositories finished indexing at 06:16:54 and 06:17:00 UTC,
before the final reply at 06:22:14, but that reply reused the earlier status.
Current authorization checks later confirmed both targets ready. There was no
confirmed loss of repository access or deletion of the existing snapshots.

## Confirmed redirect failure

The first cookie/readiness repair deployed in `41403209516-1` passed synthetic
checks, but the exact YouTube URL still failed. An isolated native supervisor
with its own profile root and Unix identity confirmed that the YouTube TLS tunnel
opened successfully, then Chrome requested `consent.youtube.com`, which was not
in the member's saved origins. Direct IPv4 and IPv6 HTTPS reads both succeeded.
The permission boundary was correct; the resulting failure report was not.

Playwright routing did not expose this redirect before Chrome's proxy CONNECT.
The proxy rejected it but did not retain that origin in its result. The worker's
tunnel error therefore became generic Browser unavailability instead of a request
for the necessary new website. This is the primary confirmed cause of the reported
YouTube failure. The partitioned-cookie issue below was a separate latent failure
found and repaired during the investigation.

The proxy now retains bounded denied origins, without granting them or resolving
unapproved destinations. The native supervisor returns them on failed navigation
and preserves the session for consent. A new navigation or changed controller
policy clears old denials. Pi guidance treats these results as website consent,
then continues the original run after approval. Real member grants are not expanded
automatically. Deterministic CONNECT tests and a real headed HTTP-to-HTTPS redirect
fixture cover this failure through the production boundary.

## Additional checkpoint and indexing causes

The retained run was decrypted only in memory on the VPS. Diagnostics emitted
scoped run IDs, tool names, fixed error codes and status/provenance metadata;
message bodies, credentials and cookie values were excluded. The native journal
correlated `browser_execution_failed` with the reported run. Synthetic HTTP and
HTTPS pages worked, while the same native path failed for the reported YouTube
page. Direct public HTTPS reads also succeeded, ruling out a general host outage.

The pinned Playwright 1.63 Chromium adapter returns `_crHasCrossSiteAncestor`
with partitioned cookies and uses that bit when restoring them. The strict private
checkpoint schema allowed `partitionKey` but omitted this boolean. Saving a
partitioned session cookie therefore threw a schema error after navigation.
That unexpected worker error became `browser_execution_failed`, then the older
client reduced it to service unavailable. The ordinary session-cookie fixture had
not exercised partition metadata.

Code Truth configuration starts repository synchronization asynchronously. The
first source query could immediately read a newly created/evicted manager's empty
status before initialization finished, even when reusable disk snapshots existed.
The application did not distinguish that interval from an unavailable repository.

## Corrections and regression coverage

The private checkpoint schema now preserves the bounded optional Chromium boolean,
including `false`, through worker/root IPC, encryption and restoration. It still
rejects unknown fields and invalid types. Invalid checkpoints report the fixed
`browser_checkpoint_invalid` code without upstream exception or cookie contents.
This metadata is absent from model-facing Browser results.

Three deterministic tests exercise the production checkpoint method, its IPC
schema and sanitized failure. The real headed-host fixture now sets a secure,
HttpOnly, partitioned session cookie and verifies its encrypted checkpoint while
retaining isolation, secure input, handoff, restart and download checks. The VPS
application-UID probe also requires the partitioned fixture cookie to be observed
on subsequent navigation, without exposing its value.

Code Truth source invocation now waits up to 20 seconds for an initializing
namespace. A longer initialization reports `code_truth_indexing`; completed sync
failures retain their actual unavailable state. Waiting is cancellable. The Pi
factory rechecks its guard and current repository scope immediately before the
MCP query, so revocation during the wait cannot authorize a later source read.
Guidance distinguishes preparation from lost access and does not turn it into a
separate coding task or account-reconnection request.

Production service regressions cover first-query initialization, cancellation and
bounded indexing. A Pi-factory regression covers revocation during the wait.
The complete application suite, exact-image startup contract, native package and
production cutover evidence are recorded in [VPS deployment](../docs/implementation/vps-deployment.md).

## Scope

No account was logged in, real external submission sent, Telegram message sent or
model call made during diagnosis. The historical run and its unknown navigation
receipt were not rewritten or replayed. The repair preserves current website
consent, private profiles and the existing repository authorization boundary.
