import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { database } from "../src/db/pool.ts";
import { Store } from "../src/db/repositories.ts";
import { SetupService } from "../src/setup/service.ts";

const store = new Store(
  database("postgres://unused:unused@127.0.0.1:1/unused"),
);
const app = createApp(
  store,
  new SetupService(store, "ab".repeat(32), "http://localhost:3000"),
  "http://localhost:3000",
);
test("liveness works independently of database credentials", async () => {
  const r = await app.request("/healthz");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "ok" });
});
test("unavailable storage never acknowledges a webhook", async () => {
  const r = await app.request("/telegram/webhook", {
    method: "POST",
    body: JSON.stringify({ update_id: 1 }),
    headers: { "content-type": "application/json" },
  });
  expect(r.status).toBe(503);
});
test("webhook rejects oversized bodies before storage", async () => {
  const r = await app.request("/telegram/webhook", {
    method: "POST",
    body: "x".repeat(65537),
  });
  expect(r.status).toBe(413);
});
