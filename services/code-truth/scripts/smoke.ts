import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { create } from "tar";
import { createLocalService } from "../src/service.ts";
import { CodeGraphRunner } from "../src/upstream/codegraph/runner.ts";
import { BunProcessRunner } from "../src/upstream/lib/process.ts";

const root = await mkdtemp(join(tmpdir(), "code-truth-smoke-"));
const binary = createRequire(import.meta.url).resolve(
  `@colbymchenry/codegraph-${process.platform}-${process.arch}/bin/codegraph`,
);
await mkdir(join(root, "repo"));
await writeFile(
  join(root, "repo", "fixture.ts"),
  "export function localCodeTruthSmoke() { return true; }\n",
);
const archive = join(root, "repo.tar");
await create({ cwd: root, file: archive }, ["repo"]);
const token = randomUUID();
const service = createLocalService({
  token,
  dataDir: join(root, "data"),
  codegraph: new CodeGraphRunner(binary, new BunProcessRunner()),
  repositorySource: {
    async resolveBranch() {
      return "b".repeat(40);
    },
    async downloadArchive() {
      return createReadStream(archive);
    },
  },
});
const server = service.app.listen(0, "127.0.0.1");
await new Promise<void>((done) => server.once("listening", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No port");
const url = `http://127.0.0.1:${address.port}`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const config = {
  workspaceId: randomUUID(),
  targets: [
    {
      id: "fixture",
      repositoryUrl: "https://github.com/example/fixture.git",
      networks: { devnet: "main" },
    },
  ],
};
const client = new Client({ name: "smoke", version: "1" });
try {
  let ready = false;
  let namespace = "";
  for (let i = 0; i < 100; i++) {
    const response = await fetch(`${url}/configure`, {
      method: "POST",
      headers,
      body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error("Configuration failed");
    const status = (await response.json()) as {
      namespace: string;
      syncing: boolean;
      targets: { networks: { status: string }[] }[];
    };
    namespace = status.namespace;
    if (!status.syncing) {
      ready = status.targets[0]?.networks[0]?.status === "ready";
      break;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready) throw new Error("Index did not become ready");
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp/${namespace}`), {
      requestInit: { headers },
    }),
  );
  const result = await client.callTool({
    name: "search_code",
    arguments: {
      target: "fixture",
      network: "devnet",
      query: "localCodeTruthSmoke",
    },
  });
  if (
    result.isError ||
    !JSON.stringify(result.structuredContent).includes("localCodeTruthSmoke") ||
    !JSON.stringify(result.structuredContent).includes("b".repeat(40))
  )
    throw new Error("Query failed");
  console.info(
    JSON.stringify({
      codeTruth: true,
      realIndex: true,
      mcp: true,
      commitProvenance: true,
    }),
  );
} finally {
  await client.close();
  await new Promise<void>((done) => server.close(() => done()));
  await service.close();
  await rm(root, { recursive: true, force: true });
}
