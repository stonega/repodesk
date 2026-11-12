import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:http";

const key = (await readFile("/run/secrets/browser_token", "utf8")).trim();
const workspaceId = randomUUID();
const routine = process.env.BROWSER_PROBE_ROUTINE === "true";
let submissions = 0;
let partitionedCookieObserved = false;
const fixture = routine
  ? createServer((req, res) => {
      if (req.url === "/download") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="probe.txt"',
        });
        res.end("verified-private-download");
        return;
      }
      if (req.url === "/blocked-redirect") {
        res.writeHead(302, { location: "https://unapproved.example/blocked" });
        res.end();
        return;
      }
      if (req.method === "POST") submissions++;
      partitionedCookieObserved ||= (req.headers.cookie ?? "").includes(
        "partitioned=",
      );
      res.setHeader(
        "set-cookie",
        "partitioned=synthetic-probe-cookie; HttpOnly; Secure; SameSite=None; Partitioned; Path=/",
      );
      res.setHeader("content-type", "text/html");
      res.end(
        '<h1>Routine browser probe</h1><form action="/submit" method="POST"><input id="ordinary" name="query"><button id="submit" type="submit">Submit</button></form><a id="next" href="/next">Next</a><a id="download" href="/download">Download fixture</a>',
      );
    })
  : undefined;
if (fixture)
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture?.address();
const origin =
  address && typeof address === "object"
    ? `http://127.0.0.1:${address.port}`
    : undefined;
const policy = origin
  ? {
      origins: [origin],
      previewOrigins: [origin],
      routineOrigins: [origin],
      interact: false,
    }
  : { origins: [], previewOrigins: [], interact: false };
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
            if (res.statusCode !== 200) {
              if (
                ![
                  "browser_control_expired",
                  "browser_action_approval_required",
                ].includes(result.error)
              )
                console.error(
                  JSON.stringify({
                    probeCommand: operation.command,
                    probeAction: operation.input?.action,
                    probeSelector: operation.input?.selector,
                    code: result.error,
                  }),
                );
              reject(Error(result.error ?? "browser_probe_failed"));
            } else resolve(result);
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
for (const actor of ["900000000000001", "900000000000002"]) {
  const owner = { workspaceId, actor },
    controller = {
      kind: "plugin",
      id: randomUUID(),
      fence: 1,
      pluginId: "deployment-probe",
      pluginRevision: 7,
    };
  try {
    assert.equal(
      (await call(owner, controller, 1, { command: "acquire" })).headed,
      true,
    );
    assert.equal(
      (
        await call(owner, controller, 1, {
          command: "action",
          input: { action: "tabs" },
        })
      ).status,
      "completed",
    );
    await assert.rejects(
      call(owner, { ...controller, pluginRevision: 6 }, 1, {
        command: "action",
        input: { action: "tabs" },
      }),
      /browser_control_expired/,
    );
    if (origin) {
      await call(owner, controller, 1, {
        command: "action",
        input: { action: "navigate", url: origin },
      });
      const fill = {
        action: "fill",
        selector: "#ordinary",
        text: "synthetic routine value",
      };
      const inspection = await call(owner, controller, 1, {
        command: "review",
        input: fill,
      });
      assert.equal(inspection.approvalRequired, false);
      await call(owner, controller, 1, {
        command: "action",
        input: fill,
        page: inspection.page,
      });
      const submit = { action: "click", selector: "#submit" };
      assert.equal(
        (await call(owner, controller, 1, { command: "review", input: submit }))
          .approvalRequired,
        true,
      );
      await assert.rejects(
        call(owner, controller, 1, { command: "action", input: submit }),
        /browser_action_approval_required/,
      );
      const next = { action: "click", selector: "#next" };
      assert.equal(
        (await call(owner, controller, 1, { command: "review", input: next }))
          .approvalRequired,
        false,
      );
      await call(owner, controller, 1, { command: "action", input: next });
      assert.equal(submissions, 0);
      assert.equal(partitionedCookieObserved, true);
      // The synthetic download needs the same explicit interaction grant as a
      // member-approved download. The earlier submission checks run without it.
      policy.interact = true;
      await call(owner, controller, 1, {
        command: "action",
        input: { action: "click", selector: "#download" },
      });
      let downloads = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        downloads =
          (await call(owner, controller, 1, { command: "status" })).downloads ??
          [];
        if (downloads.length) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(downloads.length, 1);
      const artifact = await call(owner, controller, 1, {
        command: "artifact",
        id: downloads[0].id,
      });
      assert.equal(
        Buffer.from(artifact.artifact?.data ?? "", "base64").toString(),
        "verified-private-download",
      );
      policy.interact = false;
      const redirected = await call(owner, controller, 1, {
        command: "action",
        input: { action: "navigate", url: `${origin}/blocked-redirect` },
      });
      assert.equal(redirected.status, "unavailable");
      assert.ok(
        redirected.blockedOrigins.includes("https://unapproved.example"),
      );
      assert.equal(
        (await call(owner, controller, 1, { command: "status" })).status,
        "ready",
      );
    }
  } finally {
    await call(owner, controller, 2, { command: "close" });
    assert.equal(
      (await call(owner, controller, 3, { command: "delete" })).status,
      "deleted",
    );
  }
}
if (fixture) {
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
}
console.log(
  JSON.stringify({
    headed: true,
    applicationUid: process.getuid(),
    privateProfiles: true,
    pluginRevisionFenced: true,
    cleaned: true,
    externalWebsitesUsed: false,
    ...(routine
      ? {
          nativeRoutineActions: true,
          externalSubmissionsGated: true,
          partitionedCookieCheckpoint: true,
          httpsRedirectConsent: true,
          verifiedPrivateDownload: true,
        }
      : {}),
  }),
);
