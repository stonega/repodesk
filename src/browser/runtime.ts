import { readFile } from "node:fs/promises";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { BrowserHostClient } from "./client.ts";
import { CodexBrowsers } from "./codex.ts";
import { BrowserService } from "./service.ts";

/** Construction and tool registration never read the optional host token. */
export function browserRuntime(
  store: Store,
  key: string,
  settings: {
    BROWSER_HOST_SOCKET?: string;
    BROWSER_HOST_TOKEN_FILE?: string;
    PUBLIC_ORIGIN?: string;
    BROWSER_CODEX_ORIGIN?: string;
  },
  credentials: (path: string) => Promise<string> = (path) =>
    readFile(path, "utf8"),
) {
  const service = new BrowserService(
    store,
    key,
    settings.BROWSER_HOST_SOCKET
      ? new BrowserHostClient(settings.BROWSER_HOST_SOCKET, async () => {
          const path =
            settings.BROWSER_HOST_TOKEN_FILE ?? "/run/secrets/browser_token";
          requireThat(
            path.startsWith("/"),
            "browser_credentials_unavailable",
            503,
          );
          return (await credentials(path)).trim();
        })
      : undefined,
  );
  if (settings.PUBLIC_ORIGIN)
    service.coding = new CodexBrowsers(
      store,
      service,
      key,
      settings.PUBLIC_ORIGIN,
      settings.BROWSER_CODEX_ORIGIN,
    );
  return service;
}
