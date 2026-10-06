# Codex device sign-in failed despite a healthy runner

Date: 2026-10-06 (Asia/Taipei). Affected release: v0.1.12.

## User impact

The Codex runner started and passed health checks, but requesting a ChatGPT device
code failed with `coding_device_login_unavailable`. The panel's generic message
suggested checking runner availability and account device-login settings without
identifying the server-side TLS failure.

## Cause and evidence

The supervisor installed Podman and the real Codex CLI on `node:24-bookworm-slim`
without `ca-certificates`. Its system CA bundle was absent. The task image installed
that package separately, which obscured the difference between the two images.

A fresh isolated login in the unchanged supervisor reproduced the error: the real
CLI exited with a request transport failure without printing a device URL or code.
A Node HTTPS probe reached the same auth endpoint (HTTP 405 for a GET). Mounting the
task image's trusted CA bundle into the unchanged supervisor made the real CLI
return device instructions in about half a second. Rebuilding the supervisor with
`ca-certificates` also returned instructions. No existing account cache was used;
pending probe logins were cancelled and device codes were not logged.

## Why verification missed it

The existing task/auth lifecycle smoke replaced Codex with a deterministic local
fixture. It verified process handling, cache persistence and task isolation but
never exercised the real CLI's TLS connection. Runner health checked its local HTTP
endpoint, engine, image and network; CLI `--version` also needed no HTTPS trust.
These checks could all pass while native authentication requests failed.

## Fix and prevention

- Explicitly install `ca-certificates` in the supervisor, require a non-empty CA
  bundle during the image build, and require bundle access in its health check.
- Distinguish login transport failures, auth-service rejection and unavailable
  device login using allowlisted fault codes, without returning raw CLI output.
- Preserve an existing sealed auth-required generation when another login fails.
- Cancel the whole isolated login process group: the npm CLI launches a native
  child, and killing just the launcher can leave authentication polling and pipes
  alive. Test native-child termination and isolation from another workspace.
- Add deterministic failure/tenant/recovery tests and a browser network-error check.
- Provide a manual, secret-safe VPS diagnostic workflow using the deployed real
  CLI, an isolated login home and only status/boolean output. Run it after the
  corrected deployment to verify device instruction generation on the actual VPS.

The operator must still complete their own ChatGPT authorization. Generating a
code verifies login startup, not account connection or live model/task quality.
