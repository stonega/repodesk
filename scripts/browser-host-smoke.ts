import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { browserHostHandler } from "../src/browser/browser-host-server.ts";
import { BrowserHostClient } from "../src/browser/client.ts";
import type {
  BrowserAction,
  BrowserController,
  BrowserOwner,
} from "../src/browser/config.ts";
import { NativeBrowserHost } from "../src/browser/host-runtime.ts";
import { browserHostSettings } from "../src/browser/host-settings.ts";
import { hostCommand } from "../src/browser/host-system.ts";
import { profileKey } from "../src/browser/state.ts";
import { Fault } from "../src/domain.ts";

// Synthetic accounts and a loopback-only fixture. No live sites, models or logins.
assert.equal(process.getuid?.(), 0);
const settings = browserHostSettings.parse({
  ...process.env,
  BROWSER_HOST_MAX_PROCESSES: 2,
});
let largeSent = 0;
const largeSize = 30 * 1024 * 1024;
const site = createServer(async (req, res) => {
  if (req.url === "/worker.js") {
    res.setHeader("content-type", "application/javascript");
    res.end(
      "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));",
    );
    return;
  }
  if (req.url === "/download-small") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="fixture.txt"',
    });
    res.end("private-download-fixture");
    return;
  }
  if (req.url === "/download-large") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="large-fixture.bin"',
      "content-length": largeSize,
    });
    const chunk = Buffer.alloc(32768);
    while (!res.destroyed && largeSent < largeSize) {
      res.write(chunk);
      largeSent += chunk.length;
      await delay(2);
    }
    res.end();
    return;
  }
  if (req.url === "/logout") {
    res.writeHead(303, {
      "set-cookie": "account=; Max-Age=0; Path=/",
      location: "/private",
    });
    res.end();
    return;
  }
  if (req.url === "/login" && req.method === "POST") {
    const chunks = [];
    for await (const data of req) chunks.push(data);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(body.get("password"), "synthetic-password");
    res.writeHead(303, {
      "set-cookie": `account=${body.get("name")}; HttpOnly; SameSite=Lax; Path=/`,
      location: "/private",
    });
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(
    `<html><head><title>Private browser fixture</title></head><body><h1>${req.headers.cookie ?? "not signed in"}</h1><form action="/login" method="POST"><input name="name" id="name"><input type="password" name="password" id="password"><button id="submit" type="submit">Sign in</button></form><a id="next" href="/next">Next</a><a id="download-small" href="/download-small">Small download</a><a id="download-large" href="/download-large">Large download</a><button id="replace-field" type="button" onclick="setTimeout(()=>{const f=document.getElementById('password');f.replaceWith(f.cloneNode(true));},2000)">Replace field</button><p id="socket">connecting</p><p id="worker">initializing</p><script>const ws=new WebSocket('ws://'+location.host+'/socket');ws.onmessage=()=>document.getElementById('socket').textContent='websocket-connected';navigator.serviceWorker.register('/worker.js').then(()=>navigator.serviceWorker.ready).then(()=>document.getElementById('worker').textContent='service-worker-ready');</script></body></html>`,
  );
});
site.on("upgrade", (req, socket) => {
  const accept = createHash("sha1")
    .update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  const message = Buffer.from("fixture-frame");
  socket.end(
    Buffer.concat([
      Buffer.from(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      ),
      Buffer.from([0x81, message.length]),
      message,
    ]),
  );
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const address = site.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const key = "synthetic-browser-smoke-service-key-32-characters";
const socket = "/run/repodesk-browser-smoke/control.sock";
await mkdir("/run/repodesk-browser-smoke", { recursive: true });
let host = new NativeBrowserHost(settings, undefined, key);
await host.initialize();
const server = createServer(
  browserHostHandler(key, {
    invoke: async (input) => {
      try {
        return await host.invoke(input);
      } catch (error) {
        const diagnostic = {
          command: input.operation.command,
          action:
            input.operation.command === "action"
              ? input.operation.input.action
              : undefined,
          generation: input.generation,
          code:
            error instanceof Fault ? error.code : "browser_execution_failed",
          errorKind: error instanceof Fault ? "fault" : "unexpected",
        };
        process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
        throw error;
      }
    },
  }),
);
await new Promise<void>((resolve) => server.listen(socket, resolve));
const client = new BrowserHostClient(socket, key);
const ownerA = { workspaceId: randomUUID(), actor: "101" },
  ownerB = { workspaceId: ownerA.workspaceId, actor: "202" };
const chat = { kind: "chat" as const, id: randomUUID(), fence: 1 };
const codex = { kind: "codex" as const, id: randomUUID(), fence: 1 };
const policy = { origins: [origin], previewOrigins: [origin], interact: true };
function call(
  owner: BrowserOwner,
  generation: number,
  operation: Parameters<BrowserHostClient["invoke"]>[0]["operation"],
  controller: BrowserController = chat,
) {
  return client.invoke({ owner, generation, operation, controller, policy });
}
function action(owner: BrowserOwner, generation: number, input: BrowserAction) {
  return call(owner, generation, { command: "action", input });
}
try {
  assert.equal((await call(ownerA, 1, { command: "acquire" })).headed, true);
  await action(ownerA, 1, { action: "navigate", url: `${origin}/` });
  let pageReady = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const text = (await action(ownerA, 1, { action: "read" })).text ?? "";
    if (
      text.includes("websocket-connected") &&
      text.includes("service-worker-ready")
    ) {
      pageReady = true;
      break;
    }
    await delay(50);
  }
  assert.ok(pageReady);
  await action(ownerA, 1, { action: "fill", selector: "#name", text: "Alice" });
  const fields = (await action(ownerA, 1, { action: "read" })).controls;
  assert.ok(
    fields?.some(
      (field) => field.selector === "#password" && field.type === "password",
    ),
  );
  assert.doesNotMatch(JSON.stringify(fields), /Alice|synthetic-password/);
  await assert.rejects(
    action(ownerA, 1, {
      action: "fill",
      selector: "#password",
      text: "synthetic-password",
    }),
    /browser_sensitive_field/,
  );
  const request = await action(ownerA, 1, {
    action: "request_input",
    selector: "#password",
    label: "Password",
    kind: "password",
  });
  assert.ok(request.page);
  // Owner viewing is read-only: it must not take over or invalidate pending input.
  const observation = await client.invoke({
    owner: ownerA,
    controller: { kind: "human", id: randomUUID(), fence: 0 },
    generation: 1,
    operation: { command: "observe", view: "screenshot" },
    policy,
  });
  assert.ok(observation.reference);
  assert.equal(
    (await call(ownerA, 1, { command: "artifact", id: observation.reference }))
      .artifact?.mimeType,
    "image/jpeg",
  );
  await call(ownerA, 1, {
    command: "input",
    requestId: randomUUID(),
    pageId: request.page.id,
    pageRevision: request.page.revision,
    origin,
    selector: "#password",
    value: "synthetic-password",
  });
  await action(ownerA, 1, { action: "click", selector: "#submit" });
  assert.match(
    (await action(ownerA, 1, { action: "read" })).text ?? "",
    /account=Alice/,
  );
  await action(ownerA, 1, { action: "click", selector: "#download-small" });
  let downloads: { id: string; name: string; size: number }[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    downloads = (await call(ownerA, 1, { command: "status" })).downloads ?? [];
    if (downloads.length) break;
    await delay(25);
  }
  assert.equal(downloads.length, 1);
  assert.ok(downloads[0]);
  const downloaded = await call(ownerA, 1, {
    command: "artifact",
    id: downloads[0].id,
  });
  assert.equal(
    Buffer.from(downloaded.artifact?.data ?? "", "base64").toString(),
    "private-download-fixture",
  );
  await action(ownerA, 1, { action: "click", selector: "#download-large" });
  await delay(1000);
  assert.equal(
    (await call(ownerA, 1, { command: "status" })).downloads?.length,
    1,
  );
  assert.ok(largeSent > 0 && largeSent < largeSize);
  assert.equal((await call(ownerB, 1, { command: "acquire" })).headed, true);
  await action(ownerB, 1, { action: "navigate", url: `${origin}/private` });
  assert.match(
    (await action(ownerB, 1, { action: "read" })).text ?? "",
    /not signed in/,
  );
  await action(ownerB, 1, { action: "fill", selector: "#name", text: "Bob" });
  const requestB = await action(ownerB, 1, {
    action: "request_input",
    selector: "#password",
    label: "Password",
    kind: "password",
  });
  assert.ok(requestB.page);
  await call(ownerB, 1, {
    command: "input",
    requestId: randomUUID(),
    pageId: requestB.page.id,
    pageRevision: requestB.page.revision,
    origin,
    selector: "#password",
    value: "synthetic-password",
  });
  await action(ownerB, 1, { action: "click", selector: "#submit" });
  assert.match(
    (await action(ownerB, 1, { action: "read" })).text ?? "",
    /account=Bob/,
  );
  assert.match(
    (await action(ownerA, 1, { action: "read" })).text ?? "",
    /account=Alice/,
  );
  const a = (
    await hostCommand("getent", [
      "passwd",
      `rdb_${profileKey(ownerA).slice(0, 20)}`,
    ])
  ).split(":");
  const b = (
    await hostCommand("getent", [
      "passwd",
      `rdb_${profileKey(ownerB).slice(0, 20)}`,
    ])
  ).split(":");
  assert.notEqual(a[2], b[2]);
  assert.ok(a[0] && a[2] && b[0] && b[2]);
  const ownHome = `${settings.BROWSER_HOST_ROOT}/profiles/${profileKey(ownerA)}/home`;
  const otherHome = `${settings.BROWSER_HOST_ROOT}/profiles/${profileKey(ownerB)}/home`;
  await hostCommand("runuser", [
    "-u",
    a[0],
    "--",
    process.execPath,
    "-e",
    `require('net').connect(${address.port},'127.0.0.1').on('connect',()=>process.exit(2)).on('error',()=>console.log('blocked')).setTimeout(1000,()=>process.exit(3))`,
  ]);
  await assert.rejects(
    hostCommand("runuser", [
      "-u",
      a[0],
      "--",
      process.execPath,
      "-e",
      `require('fs').readdirSync(${JSON.stringify(otherHome)})`,
    ]),
  );
  const displayTest =
    "process.exit(require('child_process').spawnSync('/usr/bin/xdpyinfo',[],{stdio:'ignore'}).status===0?0:1)";
  await hostCommand("runuser", [
    "-u",
    a[0],
    "--",
    "env",
    `DISPLAY=:${10000 + Number(a[2])}`,
    `XAUTHORITY=${ownHome}/display.auth`,
    process.execPath,
    "-e",
    displayTest,
  ]);
  await assert.rejects(
    hostCommand("runuser", [
      "-u",
      a[0],
      "--",
      "env",
      `DISPLAY=:${10000 + Number(b[2])}`,
      `XAUTHORITY=${ownHome}/display.auth`,
      process.execPath,
      "-e",
      displayTest,
    ]),
  );
  let headedProcess = false;
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if ((await stat(`/proc/${pid}`)).uid !== Number(a[2])) continue;
      const args = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (
        args.includes("--remote-debugging-pipe") &&
        !args.includes("--type=")
      ) {
        assert.ok(
          !args.includes("--headless") &&
            !args.includes("--no-sandbox") &&
            !args.includes("--remote-debugging-port"),
        );
        headedProcess = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  assert.ok(headedProcess);
  assert.equal(
    (
      await stat(
        `${settings.BROWSER_HOST_ROOT}/profiles/${profileKey(ownerA)}/home`,
      )
    ).mode & 0o777,
    0o700,
  );
  await call(ownerA, 2, { command: "release" });
  await call(ownerA, 3, { command: "acquire" }, codex);
  assert.match(
    (
      await call(
        ownerA,
        3,
        { command: "action", input: { action: "read" } },
        codex,
      )
    ).text ?? "",
    /account=Alice/,
  );
  await assert.rejects(
    action(ownerA, 1, { action: "read" }),
    /browser_control_expired/,
  );
  await host.close();
  host = new NativeBrowserHost(settings, undefined, key);
  await host.initialize();
  await call(ownerA, 4, { command: "acquire" });
  await action(ownerA, 4, { action: "navigate", url: `${origin}/private` });
  assert.match(
    (await action(ownerA, 4, { action: "read" })).text ?? "",
    /account=Alice/,
  );
  const screenshot = await action(ownerA, 4, { action: "screenshot" });
  assert.ok(screenshot.reference);
  const image = await call(ownerA, 4, {
    command: "artifact",
    id: screenshot.reference,
  });
  assert.equal(image.artifact?.mimeType, "image/jpeg");
  assert.ok((image.artifact?.data.length ?? 0) > 100);
  await assert.rejects(
    call(ownerB, 1, { command: "artifact", id: screenshot.reference }),
    /browser_artifact_unavailable/,
  );
  const state = await readFile(
    `${settings.BROWSER_HOST_ROOT}/profiles/${profileKey(ownerA)}/control.json`,
    "utf8",
  );
  assert.ok(!state.includes("synthetic-password"));
  const session = JSON.parse(
    await readFile(
      `${settings.BROWSER_HOST_ROOT}/profiles/${profileKey(ownerA)}/session.json`,
      "utf8",
    ),
  );
  assert.ok(
    session.sealed.startsWith("v2.") && !session.sealed.includes("Alice"),
  );
  await call(ownerA, 5, { command: "close" });
  const persistedImage = await call(ownerA, 5, {
    command: "artifact",
    id: screenshot.reference,
  });
  assert.equal(persistedImage.artifact?.mimeType, "image/jpeg");
  await call(ownerA, 6, { command: "acquire" });
  await action(ownerA, 6, { action: "navigate", url: `${origin}/logout` });
  await call(ownerA, 7, { command: "close" });
  await call(ownerA, 8, { command: "acquire" });
  await action(ownerA, 8, { action: "navigate", url: `${origin}/private` });
  assert.match(
    (await action(ownerA, 8, { action: "read" })).text ?? "",
    /not signed in/,
  );
  // A DOM replacement must not redirect credentials to a different input node.
  await action(ownerA, 8, { action: "click", selector: "#replace-field" });
  const replaced = await action(ownerA, 8, {
    action: "request_input",
    selector: "#password",
    label: "Password",
    kind: "password",
  });
  assert.ok(replaced.page);
  await delay(2200);
  await assert.rejects(
    call(ownerA, 8, {
      command: "input",
      requestId: randomUUID(),
      pageId: replaced.page.id,
      pageRevision: replaced.page.revision,
      origin: replaced.page.origin,
      selector: "#password",
      value: "synthetic-replaced-input",
    }),
    /browser_page_changed/,
  );
  const filePlugin = {
    kind: "plugin" as const,
    id: randomUUID(),
    fence: 1,
    pluginId: "smoke-plugin",
    pluginRevision: 7,
  };
  await call(ownerA, 9, { command: "acquire" }, filePlugin);
  assert.equal(
    (
      await call(
        ownerA,
        9,
        { command: "action", input: { action: "read" } },
        filePlugin,
      )
    ).status,
    "completed",
  );
  await assert.rejects(
    call(
      ownerA,
      9,
      { command: "action", input: { action: "read" } },
      { ...filePlugin, pluginRevision: 6 },
    ),
    /browser_control_expired/,
  );
  await host.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const token = "/run/repodesk-browser-smoke/token";
  await writeFile(token, key, { mode: 0o600 });
  const cli = spawn(
    process.execPath,
    [fileURLToPath(new URL("./browser-host.js", import.meta.url))],
    {
      env: {
        ...process.env,
        BROWSER_HOST_TOKEN_FILE: token,
        BROWSER_HOST_SOCKET: socket,
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const exited = new Promise<number | null>((resolve) =>
    cli.once("exit", resolve),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("CLI startup timeout")),
        15000,
      );
      cli.once("error", reject);
      cli.once("exit", () => reject(Error("CLI exited before readiness")));
      cli.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("RepoDesk browser host ready.")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    assert.equal((await stat(socket)).mode & 0o777, 0o660);
    assert.equal(
      (await call(ownerA, 9, { command: "status" }, filePlugin)).status,
      "closed",
    );
    cli.kill("SIGTERM");
    assert.equal(await exited, 0);
  } finally {
    if (cli.exitCode === null) cli.kill("SIGKILL");
  }
  process.stdout.write(
    `${JSON.stringify({
      headed: true,
      separateUsers: true,
      privateCookies: true,
      secureInput: true,
      controllerHandoff: true,
      restartPersistence: true,
      privateScreenshot: true,
      privateDisplay: true,
      noProxyBypass: true,
      logoutPersistence: true,
      webSockets: true,
      serviceWorkers: true,
      packagedEntryPoint: true,
      privateDownload: true,
      boundedDownload: true,
      replacedFieldDenied: true,
      observingPreservesInput: true,
      pluginRevisionFenced: true,
    })}\n`,
  );
} finally {
  await host.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  site.closeAllConnections();
  await new Promise<void>((resolve) => site.close(() => resolve()));
}
