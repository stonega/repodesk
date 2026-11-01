import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { Fault, requireThat } from "../domain.ts";
import { readBrowserArtifact } from "./host-artifacts.ts";
import { browserCheckpoint } from "./host-checkpoint.ts";
import { HeadedBrowser } from "./host-page.ts";
import { browserHostPolicy, hostCommand } from "./protocol.ts";

const init = z
  .object({
    command: z.literal("initialize"),
    home: z.string().startsWith("/"),
    executable: z.string().startsWith("/"),
    checkpoint: browserCheckpoint.optional(),
    proxy: z
      .object({
        server: z.string().url(),
        username: z.string(),
        password: z.string(),
      })
      .strict(),
  })
  .strict();
const work = z
  .object({
    command: z.literal("execute"),
    operation: hostCommand,
    policy: browserHostPolicy,
  })
  .strict();
const artifact = z
  .object({
    command: z.literal("artifact"),
    home: z.string().startsWith("/"),
    id: z.uuid(),
    policy: browserHostPolicy,
  })
  .strict();
const envelope = z
  .object({
    id: z.uuid(),
    input: z.union([
      init,
      work,
      artifact,
      z.object({ command: z.literal("checkpoint") }).strict(),
      z.object({ command: z.literal("shutdown") }).strict(),
    ]),
  })
  .strict();
let display: ChildProcess | undefined, browser: HeadedBrowser | undefined;
function authority(displayNumber: number) {
  const field = (data: Buffer) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(data.length);
    return Buffer.concat([size, data]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(65535);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.from(String(displayNumber))),
    field(Buffer.from("MIT-MAGIC-COOKIE-1")),
    field(randomBytes(16)),
  ]);
}
async function initialize(value: z.infer<typeof init>) {
  const uid = process.getuid?.();
  requireThat(
    uid && uid !== 0 && process.getgid?.(),
    "browser_host_privileges_required",
    503,
  );
  const number = 10000 + uid;
  const auth = join(value.home, "display.auth");
  await writeFile(auth, authority(number), { mode: 0o600 });
  const runtime = join(value.home, "runtime");
  await mkdir(runtime, { mode: 0o700, recursive: true });
  display = spawn(
    "Xvfb",
    [
      `:${number}`,
      "-screen",
      "0",
      "1280x800x24",
      "-nolisten",
      "tcp",
      "-auth",
      auth,
      "-noreset",
    ],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: value.home } },
  );
  let failed = false;
  display.once("error", () => {
    failed = true;
  });
  display.once("exit", () => {
    failed = true;
  });
  let ready = false;
  for (let i = 0; i < 100 && !failed; i++) {
    try {
      await access(`/tmp/.X11-unix/X${number}`);
      ready = true;
      break;
    } catch {
      await delay(25);
    }
  }
  requireThat(ready && !failed, "browser_display_unavailable", 503);
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: value.home,
    LANG: "C.UTF-8",
    DISPLAY: `:${number}`,
    XAUTHORITY: auth,
    XDG_RUNTIME_DIR: runtime,
  };
  if (process.env.DBUS_SESSION_BUS_ADDRESS)
    env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  browser = new HeadedBrowser({ ...value, env });
  await browser.start();
  return { status: "ready", headed: true };
}
async function shutdown() {
  await browser?.close().catch(() => {});
  display?.kill("SIGTERM");
}
let queue = Promise.resolve();
process.on("message", (message) => {
  queue = queue
    .then(async () => {
      const parsed = envelope.safeParse(message);
      if (!parsed.success) return;
      const { id, input } = parsed.data;
      try {
        let result: unknown;
        if (input.command === "initialize") result = await initialize(input);
        else if (input.command === "shutdown") {
          await shutdown();
          result = { status: "closed" };
        } else if (input.command === "checkpoint") {
          requireThat(browser, "browser_service_unavailable", 503);
          result = await browser.checkpoint();
        } else if (input.command === "artifact") {
          result = await readBrowserArtifact(
            input.home,
            input.id,
            input.policy,
          );
        } else {
          requireThat(browser, "browser_service_unavailable", 503);
          if (
            !["artifact", "status", "observe"].includes(input.operation.command)
          )
            browser.setPolicy(input.policy);
          result = await browser.execute(input.operation, input.policy);
        }
        process.send?.({ id, result });
      } catch (error) {
        process.send?.({
          id,
          error:
            error instanceof Fault ? error.code : "browser_execution_failed",
        });
      }
    })
    .catch(() => {});
});
process.once("disconnect", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
