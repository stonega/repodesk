import { startBrowserHost } from "./browser-host-server.ts";

startBrowserHost().catch(() => {
  process.stderr.write("browser_host_start_failed\n");
  process.exitCode = 1;
});
