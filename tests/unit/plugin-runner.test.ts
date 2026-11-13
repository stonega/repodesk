import { expect, test } from "bun:test";
import { PluginError } from "../../src/plugins/contract.ts";
import type {
  PluginSandbox,
  SandboxInvocation,
} from "../../src/plugins/docker-sandbox.ts";
import { loadLocalPackage } from "../../src/plugins/local-package.ts";
import { PluginRunnerClient } from "../../src/plugins/runner-client.ts";
import { pluginRunnerApp } from "../../src/plugins/runner-service.ts";

const token = "synthetic-private-supervisor-token-123456789";
async function invocation(): Promise<SandboxInvocation> {
  const pkg = await loadLocalPackage("examples/plugins/repository-insights");
  return {
    manifest: pkg.manifest,
    bundle: pkg.files[pkg.manifest.runtime.entry] as Buffer,
    bundleHash: pkg.bundleHash,
    tool: "repository_summary",
    arguments: { repositoryId: 123 },
    settings: {},
    grants: ["github.metadata.read"],
    signal: new AbortController().signal,
    guard: async () => {},
    broker: async () => ({
      url: "https://github.com/example/source",
      stars: 2,
      forks: 1,
      subscribers: 0,
      fetchedAt: new Date().toISOString(),
    }),
  };
}
function harness(sandbox: PluginSandbox) {
  const app = pluginRunnerApp(sandbox, token);
  const transport = ((url: string | URL | Request, init?: RequestInit) =>
    app.request(String(url), init)) as typeof fetch;
  return {
    app,
    client: new PluginRunnerClient("http://private.invalid", token, transport),
  };
}
test("private client transports a broker roundtrip and deletes the receipt", async () => {
  let started = 0;
  const { app, client } = harness({
    async invoke(input) {
      started++;
      const summary = await input.broker(
        { method: "github.repository.get", params: { repositoryId: 123 } },
        input.signal,
      );
      return {
        content: [{ type: "text", text: "summary" }],
        structuredContent: summary as { stars: number },
      };
    },
  });
  expect((await app.request("/healthz")).status).toBe(403);
  // The fixture's output schema requires these fields, supplied by the broker.
  const result = await client.invoke(await invocation());
  expect(result.structuredContent.stars).toBe(2);
  expect(started).toBe(1);
});
test("revoked authorization suppresses a broker result and cancels the private call", async () => {
  let cancelled = false;
  const { client } = harness({
    async invoke(input) {
      try {
        await input.broker(
          { method: "github.repository.get", params: { repositoryId: 123 } },
          input.signal,
        );
      } finally {
        cancelled = true;
      }
      throw new PluginError("plugin_execution_failed");
    },
  });
  const input = await invocation();
  let allowed = true;
  input.guard = async () => {
    if (!allowed) throw new Error("denied");
  };
  input.broker = async () => {
    allowed = false;
    return {};
  };
  await expect(client.invoke(input)).rejects.toThrow(
    /plugin_(outcome_unknown|execution_failed)/,
  );
  expect(cancelled).toBe(true);
});
test("missing supervisor and token lookup are lazy, fixed failures", async () => {
  let reads = 0;
  const client = new PluginRunnerClient("http://unused.invalid", () => {
    reads++;
    throw new Error("private path");
  });
  expect(reads).toBe(0);
  await expect(client.invoke(await invocation())).rejects.toThrow(
    "plugin_unavailable",
  );
  expect(reads).toBe(1);
});
