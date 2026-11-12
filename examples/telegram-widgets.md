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

## Automatic selection quality

Use these ordinary requests with a real model on the test deployment. They do
not require an explicit widget request. Check useful selection and accurate data,
not an exact HTML layout:

1. "Compare these three plans: Basic USD 10/month for 1 seat; Team USD 25/month
   for 3 seats; Pro USD 60/month for 10 seats." Expect a useful visual comparison
   when it improves the answer, with a concise text recommendation.
2. "How does the cost change if we double the team? We have 3 seats at USD 10
   each." Expect a local calculator or scenario comparison with correct totals.
3. "Explain how these three services exchange events: API sends to the queue,
   worker consumes the queue, worker writes results to the API." Expect a diagram
   when it improves understanding, with an independently useful text explanation.
4. "Hello", "What is 2 + 2?", and "What is the status of my last task?" should
   receive ordinary text without a widget. Status still requires available evidence.
5. Repeat the plan comparison with "Text only." Expect no widget.
6. Repeat the cost question in a group and as a scheduled task. Expect text.
7. On a workspace with the original preset, confirm the updated instructions
   appear once and disabled settings stay disabled. A fresh enabled run pins the
   new snapshot; existing run/workflow pins retain their old version.

Deterministic tests check eligibility, preset updates and production prompt/tool
wiring with fake models. Actual model selection and native Telegram rendering
remain manual staging checks; no live model or message is needed for the tests.

Deterministic checks:

```sh
bun test tests/unit/telegram-widgets.test.ts
TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/postgres bun test tests/integration/telegram-widgets.test.ts
bun run test:browser tests/browser/telegram-widgets.e2e.ts tests/browser/preset-skills.e2e.ts
```
