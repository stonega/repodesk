import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserHostClient,
  type BrowserInvocation,
} from "../../src/browser/client.ts";
import { verifyBrowserRequest } from "../../src/browser/protocol.ts";

describe("private browser host transport", () => {
  const key = "synthetic-browser-host-secret-32-characters";
  const servers: Server[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { force: true, recursive: true })),
    );
  });
  function input(): BrowserInvocation {
    return {
      owner: { workspaceId: randomUUID(), actor: "101" },
      controller: { kind: "chat", id: randomUUID(), fence: 1 },
      generation: 1,
      operation: { command: "status" },
    };
  }
  test("defers optional credential reads until invocation and sanitizes failures", async () => {
    let reads = 0;
    const rpc = new BrowserHostClient(
      "/tmp/unconfigured-browser.sock",
      async () => {
        reads++;
        throw new Error("private credential path");
      },
    );
    expect(reads).toBe(0);
    await expect(rpc.invoke(input())).rejects.toThrow(
      "browser_credentials_unavailable",
    );
    expect(reads).toBe(1);
  });
  async function client(
    reply: (
      raw: string,
      signature: string,
    ) => { status?: number; body: unknown },
  ) {
    const directory = await mkdtemp(join(tmpdir(), "repodesk-browser-socket-"));
    directories.push(directory);
    const socket = join(directory, "host.sock");
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const result = reply(
        Buffer.concat(chunks).toString(),
        String(req.headers["x-repodesk-browser-signature"]),
      );
      res.writeHead(result.status ?? 200, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify(result.body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return new BrowserHostClient(socket, key);
  }
  test("uses an authenticated Unix socket and binds the exact owner", async () => {
    const invocation = input();
    const rpc = await client((raw, signed) => {
      expect(verifyBrowserRequest(key, raw, signed)).toMatchObject(invocation);
      return { body: { status: "ready" } };
    });
    expect(await rpc.invoke(invocation)).toEqual({ status: "ready" });
  });
  test("unavailable services report a fixed diagnostic without socket paths", async () => {
    const rpc = new BrowserHostClient(
      `/tmp/unavailable-${randomUUID()}.sock`,
      key,
    );
    await expect(rpc.invoke(input())).rejects.toThrow(
      "browser_service_unavailable",
    );
  });
  test("raw host errors and extra credential fields never cross the client boundary", async () => {
    const rpc = await client(() => ({
      status: 500,
      body: { error: "upstream password=private" },
    }));
    await expect(rpc.invoke(input())).rejects.toThrow(
      "browser_service_unavailable",
    );
    const unexpected = await client(() => ({
      body: { status: "ready", cookie: "private" },
    }));
    await expect(unexpected.invoke(input())).rejects.toThrow(
      "browser_service_unavailable",
    );
  });
  test("known safe fault codes are retained without upstream messages", async () => {
    const rpc = await client(() => ({
      status: 409,
      body: { error: "browser_page_changed" },
    }));
    await expect(rpc.invoke(input())).rejects.toThrow("browser_page_changed");
    await expect(rpc.invoke(input())).rejects.toMatchObject({ status: 409 });
  });
  test("oversized private results are rejected rather than partially accepted", async () => {
    const rpc = await client(() => ({
      body: { status: "completed", text: "private".repeat(30000) },
    }));
    await expect(rpc.invoke(input())).rejects.toThrow(
      "browser_service_unavailable",
    );
  });
  test("already-cancelled calls do not reach the host", async () => {
    let calls = 0;
    const rpc = await client(() => {
      calls++;
      return { body: { status: "ready" } };
    });
    const controller = new AbortController();
    controller.abort();
    await expect(rpc.invoke(input(), controller.signal)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
