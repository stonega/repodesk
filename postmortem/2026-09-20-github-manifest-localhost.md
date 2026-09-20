# GitHub App creation rejected a localhost webhook URL

## Impact and timeline

On 2026-09-20, the first real guided App registration from the local deployment
stopped at GitHub with “Hook url is not supported because it isn't reachable over
the public Internet (localhost)” and “Hook is invalid.” No App credentials were
created or saved by that failed attempt. Existing Code Truth access was unaffected.
The user supplied the GitHub error screenshot after the feature was deployed.

## Cause

The generated manifest used PUBLIC_ORIGIN for hook_attributes.url, even when
hook_attributes.active was false. GitHub validates the required webhook URL before
creation regardless of whether deliveries are enabled. Browser tests intercepted
GitHub's page and asserted only that the hook was inactive, so they missed GitHub's
public-address requirement.

## Resolution and prevention

Use https://example.com/github/webhook as a reserved-domain placeholder for the
inactive hook, with an empty event list. Browser OAuth and manifest return URLs
continue to use the actual deployment origin, including localhost. No tunnel or
public webhook endpoint is needed for this application.

Integration and browser regression assertions now cover the complete inactive hook
configuration, empty subscriptions and preservation of the local browser callbacks.
Tests using intercepted GitHub responses are not evidence of real GitHub acceptance;
external validation is recorded separately in implementation evidence.

References: [GitHub manifest schema](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
and [an inactive-hook manifest using the reserved example domain](https://github.com/anthropics/claude-code-action/blob/main/github-app-manifest.json).

## Verification

139 deterministic tests and 9 browser tests passed, as did lint, TypeScript, build,
Compose validation and the Node container runtime contract. The Podman API and worker
were updated. A real browser submission progressed to GitHub's Confirm access page
instead of the reported manifest errors. The user must complete GitHub authentication
and confirm creation; this check did not create an App.
