import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHostHandler } from "../../src/browser/browser-host-server.ts";
import { BrowserHostClient } from "../../src/browser/client.ts";

describe("browser host production HTTP composition", () => {
  const key = "synthetic-browser-host-authentication-key-32";
  let server: Server | undefined, directory: string | undefined;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    if (directory) await rm(directory, { force: true, recursive: true });
    server = undefined;
  });
  const input = () => ({
    owner: { workspaceId: randomUUID(), actor: "101" },
    controller: { kind: "chat" as const, id: randomUUID(), fence: 1 },
    generation: 1,
    operation: { command: "status" as const },
  });
  async function setup(
    invoke: Parameters<typeof browserHostHandler>[1]["invoke"],
  ) {
    directory = await mkdtemp(join(tmpdir(), "repodesk-browser-host-http-"));
    const socket = join(directory, "host.sock");
    server = createServer(browserHostHandler(key, { invoke }));
    await new Promise<void>((resolve) => server?.listen(socket, resolve));
    return { socket, client: new BrowserHostClient(socket, key) };
  }
  test("verifies the signed scope before invoking the native service", async () => {
    const value = input();
    let calls = 0;
    const { client } = await setup(async (received) => {
      calls++;
      expect(received).toMatchObject(value);
      return { status: "ready", headed: true };
    });
    expect(await client.invoke(value)).toEqual({
      status: "ready",
      headed: true,
    });
    expect(calls).toBe(1);
  });
  test("a wrong host key cannot reach browser execution", async () => {
    let calls = 0;
    const { socket } = await setup(async () => {
      calls++;
      return { status: "ready" };
    });
    await expect(
      new BrowserHostClient(socket, `${key}-wrong`).invoke(input()),
    ).rejects.toThrow("browser_service_unavailable");
    expect(calls).toBe(0);
  });
  test("unexpected host exceptions do not disclose private values", async () => {
    const { client } = await setup(async () => {
      throw new Error("private credential and page contents");
    });
    await expect(client.invoke(input())).rejects.toThrow(
      "browser_service_unavailable",
    );
  });
});
