import { describe, expect, test } from "bun:test";
import app from "../src/index";

describe("backend scaffold", () => {
  test("exposes a health check without credentials or external calls", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  test("clearly identifies the service as a scaffold", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "deepx-code-telegram-bot",
      stage: "scaffold",
    });
  });

  test("does not silently accept Telegram events before processing exists", async () => {
    const response = await app.request("/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({ update_id: 1 }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"not_found"}');
  });
});
