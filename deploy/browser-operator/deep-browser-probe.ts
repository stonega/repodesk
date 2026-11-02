import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NativeBrowserHost } from "../../src/browser/host-runtime.ts";
import { browserHostSettings } from "../../src/browser/host-settings.ts";
import type { HostCommand } from "../../src/browser/protocol.ts";
import { Fault } from "../../src/domain.ts";

// Separate native supervisor, profile root, Unix identity and control journal.
// It reuses production classes, never a real member's browser or authorization.
const root = `/var/lib/repodesk-browser-incident-${randomUUID()}`;
const host = new NativeBrowserHost(
  browserHostSettings.parse({
    BROWSER_HOST_ROOT: root,
    BROWSER_EXECUTABLE: "/usr/bin/google-chrome",
  }),
  fileURLToPath(new URL("./deep-browser-worker.mjs", import.meta.url)),
  "synthetic-incident-isolated-host-key-32-characters",
);
const owner = { workspaceId: randomUUID(), actor: "900000000000004" };
const controller = {
  kind: "plugin" as const,
  id: randomUUID(),
  fence: 1,
  pluginId: "isolated-incident",
  pluginRevision: 1,
};
const policy = {
  origins: ["https://www.youtube.com"],
  previewOrigins: [],
  interact: false,
};
const call = (operation: HostCommand) =>
  host.invoke({
    id: randomUUID(),
    owner,
    controller,
    generation: 1,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    operation,
    policy,
  });
await host.initialize();
try {
  for (const operation of [
    { command: "acquire" },
    {
      command: "action",
      input: {
        action: "navigate",
        url: "https://www.youtube.com/@mdddj/videos",
      },
    },
    { command: "action", input: { action: "read" } },
  ] as HostCommand[]) {
    const start = Date.now();
    try {
      const result = await call(operation);
      console.log(
        JSON.stringify({
          deepBrowserProbe: operation.command,
          action:
            operation.command === "action" ? operation.input.action : undefined,
          status: result.status,
          elapsedMs: Date.now() - start,
          blockedOrigins: result.blockedOrigins,
          textLength: result.text?.length,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          deepBrowserProbe: operation.command,
          action:
            operation.command === "action" ? operation.input.action : undefined,
          code:
            error instanceof Fault
              ? error.code
              : error instanceof Error
                ? error.name
                : "unknown",
          elapsedMs: Date.now() - start,
        }),
      );
    }
  }
} finally {
  await call({ command: "delete" });
  await host.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ isolatedProbeCleaned: true }));
}
