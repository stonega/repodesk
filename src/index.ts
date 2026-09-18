import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    service: "deepx-code-telegram-bot",
    stage: "scaffold",
    message: "Telegram agent implementation is planned; see docs/README.md.",
  }),
);

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
