# Telegram widget scenarios

Use a local/test deployment with a configured bot and model. Enable the Telegram
widgets preset in Skills. These are manual Telegram scenarios; tests use fake
transports and never send live messages.

1. In a private Topic, send: “Make an interactive estimate for 3 seats at USD 10
   each. Add +/- buttons; this is a preview, not a purchase.” Expect one compact
   widget plus a useful text reply. Taps change the estimate without bot requests.
2. Ask: “Compare these figures with an interactive chart: API 12, web 8, worker 4.
   Let me switch between counts and percentages.” Check the figures and labels.
3. In a linked group, ask the same thing. Expect text, with no widget send.
4. Disable the preset, then start a fresh private request. The tool must refuse
   use without a granted skill; re-enabling affects future requests.
5. Check desktop and mobile Telegram clients in light/dark themes, at narrow
   width, with larger text and reduced motion. Controls must fit without scrolling;
   essential meaning must remain in the caption/text on older clients. Check that
   switching Topics and returning does not imply local preview changes were saved.

Deterministic checks:

```sh
bun test tests/unit/telegram-widgets.test.ts
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/postgres bun test tests/integration/telegram-widgets.test.ts
bun run test:browser tests/browser/telegram-widgets.e2e.ts tests/browser/preset-skills.e2e.ts
```
