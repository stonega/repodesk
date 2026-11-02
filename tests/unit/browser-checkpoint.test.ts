import { expect, test } from "bun:test";
import { browserCheckpoint } from "../../src/browser/host-checkpoint.ts";
import { HeadedBrowser } from "../../src/browser/host-page.ts";

const cookie = {
  name: "synthetic_partitioned_session",
  value: "synthetic_value",
  domain: "example.com",
  path: "/",
  expires: -1 as const,
  httpOnly: true,
  secure: true,
  sameSite: "None" as const,
  partitionKey: "https://example.com",
  _crHasCrossSiteAncestor: false,
};

test("production browser checkpoints preserve Chromium partition metadata across private IPC", async () => {
  const page = new HeadedBrowser({
    home: "/unused-synthetic-home",
    executable: "/unused-synthetic-browser",
    proxy: {
      server: "http://127.0.0.1:1",
      username: "synthetic",
      password: "synthetic",
    },
    env: {},
  });
  Reflect.set(page, "context", {
    cookies: async () => [
      cookie,
      { ...cookie, name: "persistent", expires: 9999999999 },
    ],
  });
  const checkpoint = await page.checkpoint();
  expect(checkpoint.cookies).toEqual([cookie]);
  expect(
    browserCheckpoint.parse(JSON.parse(JSON.stringify(checkpoint))),
  ).toEqual(checkpoint);
});

test("private cookie checkpoints keep rejecting unknown data and invalid partition metadata", () => {
  expect(
    browserCheckpoint.safeParse({
      cookies: [{ ...cookie, _crHasCrossSiteAncestor: "false" }],
    }).success,
  ).toBe(false);
  expect(
    browserCheckpoint.safeParse({
      cookies: [{ ...cookie, unrecognizedSecret: "private" }],
    }).success,
  ).toBe(false);
});

test("invalid cookie checkpoints report a fixed code without cookie contents", async () => {
  const page = new HeadedBrowser({
    home: "/unused",
    executable: "/unused",
    proxy: {
      server: "http://127.0.0.1:1",
      username: "synthetic",
      password: "synthetic",
    },
    env: {},
  });
  Reflect.set(page, "context", {
    cookies: async () => [
      { ...cookie, unrecognizedSecret: "private-cookie-content" },
    ],
  });
  await expect(page.checkpoint()).rejects.toThrow("browser_checkpoint_invalid");
});
