# Google confirmation delivered outside the initiating private topic

## Incident

On 2026-10-24, an operator reported that Google remained disconnected on the VPS
after browser sign-in. The subsequent Drive and Gmail requests returned
`google_not_connected`.

Read-only inspection showed an enabled Google plugin and a pending personal flow
with a verified account candidate. Browser consent had succeeded. Telegram accepted
the confirmation delivery at 19:40:54 Asia/Taipei, but its destination was topic `0`
(General), while the consent command and subsequent requests used a nonzero private
topic. No confirmation callback had reached the server at inspection time. No
personal account connection had been committed. The attempt's original ten-minute
deadline was 19:49:52 Asia/Taipei.

## Cause

`googleControl` used the command's topic for its immediate consent-link reply, but
did not pass that topic into `GoogleService.begin`. The persisted OAuth flow had
no topic field. `GoogleService.callback` therefore queued its confirmation without
a destination topic, and `deliver` defaulted to General. A member returning to the
original topic could miss the remaining confirmation even after completing Google
consent.

The runtime correctly denied unconfirmed access. There was no observed scope,
token-exchange or provider failure, and this inspection did not read Google data.

## Correction and verification

Persist an optional topic ID from the authenticated private command in the member's
OAuth flow and pass it to the callback's confirmation delivery. Existing flows
without the field retain their prior destination; restarting consent records the
current topic. No dependency or SQL migration is required.

The deterministic ingress/browser-return/delivery/confirmation journey now covers
both topic and ordinary private chats, including the outgoing Telegram
`message_thread_id`, unconfirmed-read denial, wrong-member clicks, workspace
switching and duplicate confirmation. Before the correction, the topic case failed
with destination `0` instead of the requested topic; afterward all 18 Google
integration checks passed.

Lint, strict TypeScript, production build and the host Node runtime contract
passed. The full suite completed 1,190 cases with 1,189 passes and one unrelated
coding-reference timeout at five seconds; its focused rerun passed in 405 ms
with a 20-second timeout. See [implementation evidence](../docs/implementation/implementation-status.md).

The correction is local and has not been deployed. Production state, credentials
and deliveries were not modified. Existing consent still requires the member to
verify and confirm the displayed account in Telegram; inspection does not replace
that authorization step.
