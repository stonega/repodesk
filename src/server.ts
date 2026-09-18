import { serve } from "@hono/node-server";
import app from "./index.ts";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port });

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  server.close((error) => {
    clearTimeout(deadline);
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
