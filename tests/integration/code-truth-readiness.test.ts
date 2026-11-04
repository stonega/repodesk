import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "../../services/code-truth/node_modules/tar";
import { createLocalService } from "../../services/code-truth/src/service.ts";
import type { CodeGraphRunner } from "../../services/code-truth/src/upstream/codegraph/runner.ts";
import { CodeTruthClient } from "../../src/code-truth/client.ts";

async function fixture(indexWaitMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "repodesk-code-readiness-"));
  await mkdir(join(root, "archive"));
  await writeFile(
    join(root, "archive", "source.ts"),
    "export const ready = true;",
  );
  const archive = join(root, "source.tar");
  await create({ cwd: root, file: archive }, ["archive"]);
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const token = "synthetic-readiness-service-key-32-characters";
  const service = createLocalService({
    token,
    dataDir: join(root, "data"),
    codegraph: {
      async initialize(path: string) {
        await mkdir(join(path, ".codegraph"));
      },
      async closeProject() {},
      async closeAll() {},
    } as unknown as CodeGraphRunner,
    repositorySource: {
      async defaultBranch() {
        started.resolve();
        await gate.promise;
        return "main";
      },
      async resolveBranch() {
        return "a".repeat(40);
      },
      async downloadArchive() {
        return createReadStream(archive);
      },
    },
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("fixture_unavailable");
  const client = new CodeTruthClient(
    `http://127.0.0.1:${address.port}`,
    token,
    undefined,
    indexWaitMs,
  );
  return {
    client,
    gate,
    started,
    scope: randomUUID(),
    targets: [
      {
        id: "application",
        repositoryUrl: "https://github.com/example/application",
        networks: { default: "HEAD" },
      },
    ],
    async close() {
      gate.resolve();
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("first production Code Truth query waits for its new namespace to index", async () => {
  const f = await fixture();
  try {
    const reading = f.client.use(
      f.scope,
      f.targets,
      new AbortController().signal,
      async (mcp) => mcp.callTool({ name: "list_code_targets", arguments: {} }),
    );
    await f.started.promise;
    f.gate.resolve();
    expect((await reading).structuredContent).toMatchObject({
      targets: [
        {
          target: "application",
          networks: [
            { status: "ready", branch: "main", commit: "a".repeat(40) },
          ],
        },
      ],
    });
  } finally {
    await f.close();
  }
});

test("cancelling Code Truth warmup never dispatches a source query", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    let dispatched = false;
    const reading = f.client.use(f.scope, f.targets, abort.signal, async () => {
      dispatched = true;
      return true;
    });
    await f.started.promise;
    abort.abort();
    await expect(reading).rejects.toThrow();
    expect(dispatched).toBe(false);
  } finally {
    await f.close();
  }
});

test("a slow index reports a bounded indexing state without claiming source availability", async () => {
  const f = await fixture(50);
  try {
    let dispatched = false;
    await expect(
      f.client.use(
        f.scope,
        f.targets,
        new AbortController().signal,
        async () => {
          dispatched = true;
        },
      ),
    ).rejects.toThrow("code_truth_indexing");
    expect(dispatched).toBe(false);
  } finally {
    await f.close();
  }
});
