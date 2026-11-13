import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { DockerPluginSandbox, reapPluginSandboxes } from "./docker-sandbox.ts";
import { pluginRunnerApp } from "./runner-service.ts";

const token = process.env.PLUGIN_RUNNER_TOKEN_FILE
  ? readFileSync(process.env.PLUGIN_RUNNER_TOKEN_FILE, "utf8").trim()
  : (process.env.PLUGIN_RUNNER_TOKEN ?? "");
const image = process.env.PLUGIN_RUNNER_IMAGE ?? "";
const app = pluginRunnerApp(new DockerPluginSandbox(image), token);
const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3030),
  hostname: "0.0.0.0",
});
let reaping = false;
const reap = async () => {
  if (reaping) return;
  reaping = true;
  try {
    await reapPluginSandboxes();
  } catch {
    console.error(JSON.stringify({ code: "plugin_cleanup_unavailable" }));
  } finally {
    reaping = false;
  }
};
void reap();
const cleanup = setInterval(() => void reap(), 5000);
cleanup.unref();
const stop = () => {
  clearInterval(cleanup);
  server.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
