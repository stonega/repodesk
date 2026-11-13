import { expect, test } from "bun:test";
import {
  DockerPluginSandbox,
  type SandboxInvocation,
} from "../../src/plugins/docker-sandbox.ts";
import { loadLocalPackage, sha256 } from "../../src/plugins/local-package.ts";

const image = process.env.PLUGIN_TEST_IMAGE;
const check = image ? test : test.skip;
async function input(
  patch: Partial<SandboxInvocation> = {},
): Promise<SandboxInvocation> {
  const pkg = await loadLocalPackage("examples/plugins/word-count");
  return {
    manifest: pkg.manifest,
    bundle: pkg.files[pkg.manifest.runtime.entry] as Buffer,
    bundleHash: pkg.bundleHash,
    tool: "count_words",
    arguments: { text: "one two three" },
    settings: {},
    grants: [],
    signal: new AbortController().signal,
    guard: async () => {},
    broker: async () => {
      throw new Error("not granted");
    },
    ...patch,
  };
}
check(
  "exact runner image executes the self-contained fixture",
  async () => {
    const result = await new DockerPluginSandbox(image as string).invoke(
      await input(),
    );
    expect(result.structuredContent).toEqual({ count: 3 });
  },
  15000,
);
check(
  "GitHub reads cross only the bound host broker",
  async () => {
    const pkg = await loadLocalPackage("examples/plugins/repository-insights");
    let calls = 0;
    const value = await input({
      manifest: pkg.manifest,
      bundle: pkg.files[pkg.manifest.runtime.entry] as Buffer,
      bundleHash: pkg.bundleHash,
      tool: "repository_summary",
      arguments: { repositoryId: 123 },
      grants: ["github.metadata.read"],
      broker: async (request) => {
        calls++;
        expect(request).toEqual({
          method: "github.repository.get",
          params: { repositoryId: 123 },
        });
        return {
          url: "https://github.com/example/repository",
          stars: 10,
          forks: 2,
          subscribers: 3,
          fetchedAt: "2026-11-13T00:00:00.000Z",
        };
      },
    });
    const runner = new DockerPluginSandbox(image as string);
    expect((await runner.invoke(value)).structuredContent.stars).toBe(10);
    expect(calls).toBe(1);
    await expect(runner.invoke({ ...value, grants: [] })).rejects.toThrow(
      "plugin_permission_denied",
    );
    expect(calls).toBe(1);
  },
  15000,
);
check(
  "plugin cannot see host credentials, mounts, write package/root or use network",
  async () => {
    process.env.REPODESK_PLUGIN_TEST_SECRET = "host-only-fixture";
    try {
      const bundle =
        Buffer.from(`import {readFile,writeFile} from 'node:fs/promises';
export default {tools:{async count_words(){let count=0;
if(!process.env.REPODESK_PLUGIN_TEST_SECRET&&!process.env.DATABASE_URL&&!process.env.ENCRYPTION_KEY)count++;
for(const p of ['/var/run/docker.sock','/app/package.json'])try{await readFile(p)}catch{count++}
for(const p of ['/package/plugin.mjs','/root-write'])try{await writeFile(p,'x')}catch{count++}
try{await fetch('https://example.com',{signal:AbortSignal.timeout(500)})}catch{count++}
return {content:[{type:'text',text:String(count)}],structuredContent:{count}}}}};`);
      const result = await new DockerPluginSandbox(image as string).invoke(
        await input({ bundle, bundleHash: sha256(bundle) }),
      );
      expect(result.structuredContent.count).toBe(6);
    } finally {
      delete process.env.REPODESK_PLUGIN_TEST_SECRET;
    }
  },
  15000,
);
check(
  "hung top-level import is terminated by the supervisor deadline",
  async () => {
    const bundle = Buffer.from("while(true){}; export default {tools:{}};");
    await expect(
      new DockerPluginSandbox(image as string).invoke(
        await input({ bundle, bundleHash: sha256(bundle), timeoutMs: 1200 }),
      ),
    ).rejects.toThrow("plugin_timeout");
  },
  10000,
);
check(
  "cancellation removes a sandbox and all its descendant processes",
  async () => {
    const controller = new AbortController();
    const bundle = Buffer.from(`import {spawn} from 'node:child_process';
export default {tools:{async count_words(){spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise(()=>{});}}};`);
    const pending = new DockerPluginSandbox(image as string).invoke(
      await input({
        bundle,
        bundleHash: sha256(bundle),
        signal: controller.signal,
      }),
    );
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      await expect(pending).rejects.toThrow("plugin_cancelled");
    } finally {
      clearTimeout(timer);
    }
  },
  10000,
);
check(
  "raw plugin exceptions and malformed stdout never expose author messages",
  async () => {
    const runner = new DockerPluginSandbox(image as string);
    for (const source of [
      "throw new Error('private author exception');",
      "process.stdout.write('private author output\\n'); export default {tools:{}};",
    ]) {
      const bundle = Buffer.from(source);
      await expect(
        runner.invoke(await input({ bundle, bundleHash: sha256(bundle) })),
      ).rejects.toThrow(/plugin_(execution_failed|protocol_invalid)/);
    }
  },
  15000,
);
test("runner requires an immutable image identity", () => {
  expect(() => new DockerPluginSandbox("node:latest")).toThrow(
    "plugin_unavailable",
  );
});
