import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";

const key = (await readFile("/run/secrets/browser_token", "utf8")).trim();
const policy = {
  origins: [
    "http://example.com",
    "https://example.com",
    "https://www.youtube.com",
  ],
  previewOrigins: [],
  interact: false,
};
async function call(owner, controller, generation, operation) {
  const now = Date.now(),
    body = JSON.stringify({
      id: randomUUID(),
      owner,
      controller,
      generation,
      issuedAt: now,
      expiresAt: now + 30000,
      operation,
      policy,
    });
  const signature = createHmac("sha256", key)
    .update(`repodesk:browser:v1\n${body}`)
    .digest("hex");
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/run/repodesk-browser/control.sock",
        path: "/v1/browser",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-repodesk-browser-signature": signature,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(raw);
            if (res.statusCode !== 200)
              reject(Error(result.error ?? "browser_probe_failed"));
            else resolve(result);
          } catch {
            reject(Error("browser_probe_failed"));
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy());
    req.on("error", () => reject(Error("browser_probe_unavailable")));
    req.end(body);
  });
}
const owner = { workspaceId: randomUUID(), actor: "900000000000003" };
const controller = {
  kind: "plugin",
  id: randomUUID(),
  fence: 1,
  pluginId: "incident-probe",
  pluginRevision: 1,
};
try {
  for (const url of [
    "http://example.com",
    "https://example.com",
    "https://www.youtube.com/@mdddj/videos",
  ]) {
    try {
      await call(owner, controller, 1, { command: "acquire" });
      const start = Date.now();
      const result = await call(owner, controller, 1, {
        command: "action",
        input: { action: "navigate", url },
      });
      console.log(
        JSON.stringify({
          navigation: url,
          status: result.status,
          elapsedMs: Date.now() - start,
          blockedOrigins: result.blockedOrigins,
        }),
      );
      const page = await call(owner, controller, 1, {
        command: "action",
        input: { action: "read" },
      });
      console.log(
        JSON.stringify({
          nativePublicProbe: url,
          status: result.status,
          elapsedMs: Date.now() - start,
          textLength: page.text?.length,
          blockedOrigins: page.blockedOrigins,
        }),
      );
    } catch (e) {
      console.log(
        JSON.stringify({
          nativePublicProbe: url,
          error: /^browser_[a-z_]+$/.test(e.message)
            ? e.message
            : "probe_failed",
        }),
      );
    }
  }
} finally {
  await call(owner, controller, 2, { command: "delete" });
  console.log(JSON.stringify({ syntheticProfileCleaned: true }));
}
