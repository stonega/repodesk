import { expect, test } from "bun:test";
import { GoogleClient } from "../../src/google/client.ts";

test("Google HTTP client suppresses provider errors, redirects and oversized bodies without retries", async () => {
  for (const [response, code] of [
    [
      () =>
        Response.json(
          { error: { message: "private upstream message" } },
          { status: 403 },
        ),
      "google_access_denied",
    ],
    [
      () =>
        Response.json(
          { error: "invalid_grant", error_description: "secret" },
          { status: 400 },
        ),
      "google_reconnect_required",
    ],
    [() => Response.json({}, { status: 429 }), "google_rate_limited"],
    [
      () => new Response("x".repeat(1024 * 1024 + 1)),
      "google_response_too_large",
    ],
    [() => new Response("invalid JSON"), "google_unavailable"],
    [() => Response.redirect("https://other.test"), "google_unavailable"],
  ] as const) {
    let count = 0;
    const client = new GoogleClient(async () => {
      count++;
      return response();
    });
    await expect(
      client.get(
        new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"),
        "fixture",
        async () => {},
      ),
    ).rejects.toThrow(code);
    expect(count).toBe(1);
  }
});
test("Google HTTP reads check authority before and after the request and reject foreign origins", async () => {
  let reads = 0;
  let checks = 0;
  const client = new GoogleClient(async () => {
    reads++;
    return Response.json({ messages: [] });
  });
  await client.get(
    new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages"),
    "fixture",
    async () => {
      checks++;
    },
  );
  expect(reads).toBe(1);
  expect(checks).toBe(2);
  await expect(
    client.get(new URL("https://other.test/token"), "fixture", async () => {}),
  ).rejects.toThrow("google_invalid_request");
  expect(reads).toBe(1);
});
