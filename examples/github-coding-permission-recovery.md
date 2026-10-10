# Coding task permission recovery

Manual staging journey; deterministic tests cover the transitions locally.
Use an authorized maintainer and an already configured repository. This example
does not authorize connecting accounts, starting a paid task or publishing a PR.

1. Start an explicitly authorized coding request using the repository's normal
   Reviewed or Direct workflow. Record its task and runner attempt IDs.
2. Simulate a temporary failure of the member's GitHub permission-sync API in a
   controlled staging fixture. The saved task shows **Waiting for GitHub access
   verification**, with automatic retry guidance. The attempt ID stays unchanged.
   New runner starts and publication must remain blocked; existing isolated work
   may finish under its original grant.
3. Restore a successful snapshot with unchanged permissions. The same task resumes
   progression and publishes only after its normal verification and authorization
   checks. Duplicate polls must not create a second runner attempt or PR.
4. Repeat with an expired snapshot or a rate limit. Expiry must not grant access;
   rate-limited sync waits for the retained cooldown, including manual `/github
   sync`, and increases its backoff after repeated failures.
5. During the wait, use Stop. Cancellation must still reach the runner. Separately
   verify that a successful permission downgrade or confirmed authentication
   rejection fences pending work, including after a later successful sync.
6. After confirmed publication, make access unavailable. The saved task keeps
   **PR ready for review** and its PR link. A follow-up must reauthorize current
   access and cannot execute while verification is unavailable.

Inspect the tenant-scoped `github_user_sync_failed` runtime event for its safe code:
`github_unavailable`, `github_rate_limited` or `github_access_denied`. Never include
tokens, raw upstream bodies or private conversation text in the evidence.
