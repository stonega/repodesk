import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { BrowserEgress } from "../../src/browser/egress.ts";

/** Node's real HTTP upgrade/CONNECT sockets; Bun implements a different shim. */
export async function verifyBrowserNetwork() {
  const site = createServer((_req, res) => res.end("fixture page"));
  const upgraded = new Set<import("node:stream").Duplex>();
  let calls = 0;
  site.on("upgrade", (req, socket) => {
    calls++;
    assert.equal(req.headers["proxy-authorization"], undefined);
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nfixture-frame",
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const egress = new BrowserEgress({
    origins: [origin],
    previewOrigins: [origin],
    interact: false,
  });
  const proxy = await egress.start();
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: proxy.port });
      let response = "";
      socket.setTimeout(2000, () => socket.destroy(Error("fixture timeout")));
      socket.setEncoding("utf8");
      socket.on("connect", () =>
        socket.write(
          `GET ${origin}/socket HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Basic ${Buffer.from(`browser:${proxy.password}`).toString("base64")}\r\n\r\n`,
        ),
      );
      socket.on("data", (data) => {
        response += data;
      });
      socket.on("end", () => resolve(response));
      socket.on("error", reject);
    });
    assert.equal(calls, 1);
    assert.ok(raw.includes("101 Switching Protocols"));
    assert.ok(raw.includes("fixture-frame"));
  } finally {
    await egress.close();
    for (const socket of upgraded) socket.destroy();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
}
