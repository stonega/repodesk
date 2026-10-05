# Codex account authentication lifecycle

Approved direction: 2026-10-05. Scope: local runner account auth and recovery for
continuous and reviewed coding tasks. No account connection or deployment is part
of this change.

## Delivered and checked locally

The following plan is implemented. Workspace caches carry encrypted credential
generations and a durable sign-in-required marker. Both reviewed and continuous
tasks pause and use the authenticated, idempotent resume path on their original
work volume. Panel and Telegram status explain the next step. No live account
was connected and no publication or deployment was performed.

Validation: `bun run check`, `bun run typecheck`, `bun run build`, 366 deterministic
Bun tests with isolated PostgreSQL, five device-auth browser tests, the pinned
real CLI protocol fixture (including denied authentication), Docker-format job
and supervisor image builds, Compose validation and the real rootless Podman
smoke covering auth expiry, supervisor restart, re-login, preserved checkout and
duplicate resume. Local fake services use no paid model requests or GitHub writes.

The protocol fixture also sends the turn-start reply, usage and completion in one
stdout chunk. The client binds the turn ID before processing those notifications,
so authentication failures retain reported usage and enforce the token limit
regardless of how the operating system batches output.

## Plan

1. Keep workspace credentials encrypted in the persistent supervisor state. Let
   Codex refresh them naturally and retain the updated cache. Persist a credential
   generation with the encrypted cache; old task copies must not replace a newer
   login or restore credentials after disconnect.
2. Recognize authentication failures only at the Codex protocol boundary. A
   failed turn with an explicit auth error marks the connection as requiring
   sign-in. Network, quota, repository-script and GitHub failures do not do this.
3. Pause the task, preserve its isolated checkout and verification plan, remove
   its temporary auth volume, and release the runner slot. The app notifies the
   existing authorized audience once per pause. No raw auth errors are published.
4. After device login succeeds, the worker rechecks current task authorization,
   private repository visibility and budget, then requests an idempotent resume.
   Resume reuses the existing work volume with a fresh temporary auth volume.
   Exclude sign-in waiting from execution time; preserve cumulative usage and
   repair limits. Publication reservations are never resumed or replayed by auth.
5. Show a clear sign-in-required status and automatic-resume explanation in the
   panel. Disconnect and Stop cancel paused work. Retention still expires local
   checkpoints; expired work must not silently restart.
6. Add deterministic coverage for auth classification, refresh persistence,
   generation fencing, restart, repeated polls/resume, cancellation, retention
   and tenant/permission boundaries. Run repository checks and a local container
   smoke without paid model requests or live account credentials.

## Upstream behavior

[OpenAI account auth guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
describes refresh during normal use, preservation of the refreshed auth cache,
and a serialized stream per cache. About eight days is a current refresh
threshold, not a guaranteed session expiry. A revoked/expired refresh token may
require sign-in. API keys remain the upstream recommendation for automation;
account mode is limited here to trusted private repositories.

No scheduled model call is needed to keep a persistent container alive. Normal
runs perform refresh. This change does not implement concurrent runners sharing
an account credential or server-side account-wide revocation.
