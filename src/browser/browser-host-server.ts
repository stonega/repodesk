import { chmod, chown, lstat, mkdir, unlink } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import { Fault, requireThat } from "../domain.ts";
import { NativeBrowserHost } from "./host-runtime.ts";
import { browserHostSettings } from "./host-settings.ts";
import { browserServiceKey } from "./host-system.ts";
import {
  type HostRequest,
  type HostResult,
  verifyBrowserRequest,
} from "./protocol.ts";

export function browserHostHandler(
  key: string,
  host: { invoke: (input: HostRequest) => Promise<HostResult> },
  report?: (diagnostic: {
    code: string;
    workspaceId?: string;
    controllerId?: string;
    requestId?: string;
  }) => void,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    let input: HostRequest | undefined;
    try {
      requireThat(
        req.method === "POST" && req.url === "/v1/browser",
        "browser_not_found",
        404,
      );
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= 32768, "browser_payload_too_large", 413);
        chunks.push(Buffer.from(chunk));
      }
      input = verifyBrowserRequest(
        key,
        Buffer.concat(chunks).toString("utf8"),
        String(req.headers["x-repodesk-browser-signature"] ?? ""),
      );
      res.end(JSON.stringify(await host.invoke(input)));
    } catch (error) {
      const safe =
        error instanceof Fault && /^browser_[a-z_]+$/.test(error.code)
          ? error
          : new Fault("browser_execution_failed", 503);
      report?.({
        code: safe.code,
        workspaceId: input?.owner.workspaceId,
        controllerId: input?.controller.id,
        requestId: input?.id,
      });
      res.statusCode = safe.status;
      res.end(JSON.stringify({ error: safe.code }));
    }
  };
}

export async function startBrowserHost() {
  const settings = browserHostSettings.parse(process.env);
  const key = await browserServiceKey(settings.BROWSER_HOST_TOKEN_FILE);
  const host = new NativeBrowserHost(settings, undefined, key);
  const server = createServer(
    browserHostHandler(key, host, (diagnostic) => {
      process.stderr.write(
        `${JSON.stringify({ event: "browser_host_failed", ...diagnostic })}\n`,
      );
    }),
  );
  try {
    await host.initialize();
    await mkdir(dirname(settings.BROWSER_HOST_SOCKET), {
      mode: 0o750,
      recursive: true,
    });
    const directory = await lstat(dirname(settings.BROWSER_HOST_SOCKET));
    requireThat(
      directory.uid === 0 && !directory.isSymbolicLink(),
      "browser_profile_invalid",
      503,
    );
    await chown(
      dirname(settings.BROWSER_HOST_SOCKET),
      0,
      settings.BROWSER_HOST_SOCKET_GID,
    );
    await chmod(dirname(settings.BROWSER_HOST_SOCKET), 0o750);
    try {
      const old = await lstat(settings.BROWSER_HOST_SOCKET);
      requireThat(
        old.isSocket() && old.uid === 0,
        "browser_profile_invalid",
        503,
      );
      await unlink(settings.BROWSER_HOST_SOCKET);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    server.requestTimeout = 35_000;
    server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(settings.BROWSER_HOST_SOCKET, resolve);
    });
    await chown(
      settings.BROWSER_HOST_SOCKET,
      0,
      settings.BROWSER_HOST_SOCKET_GID,
    );
    await chmod(settings.BROWSER_HOST_SOCKET, 0o660);
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await host.close();
    throw error;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    await host.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => {
    void stop();
  });
  process.once("SIGINT", () => {
    void stop();
  });
  process.stdout.write("RepoDesk browser host ready.\n");
}
