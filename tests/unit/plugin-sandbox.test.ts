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
check(
  "Docker enforces resource limits and cancellation leaves no descendants",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execute = promisify(execFile);
    const before = (
      await execute("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=repodesk.plugin-sandbox=true",
      ])
    ).stdout
      .trim()
      .split(/\s+/);
    const controller = new AbortController();
    const bundle = Buffer.from(
      "export default {tools:{async count_words(){await new Promise(()=>{});}}};",
    );
    const pending = new DockerPluginSandbox(image as string).invoke(
      await input({
        bundle,
        bundleHash: sha256(bundle),
        signal: controller.signal,
      }),
    );
    let id = "";
    try {
      const deadline = Date.now() + 5000;
      while (!id && Date.now() < deadline) {
        const ids = (
          await execute("docker", [
            "ps",
            "-q",
            "--filter",
            "label=repodesk.plugin-sandbox=true",
          ])
        ).stdout
          .trim()
          .split(/\s+/);
        id = ids.find((value) => value && !before.includes(value)) ?? "";
        if (!id) await Bun.sleep(50);
      }
      expect(id).not.toBe("");
      const info = JSON.parse(
        (await execute("docker", ["inspect", id])).stdout,
      )[0];
      expect(info.HostConfig).toMatchObject({
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Memory: 268435456,
        MemorySwap: 268435456,
        NanoCpus: 1000000000,
        PidsLimit: 32,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
      });
      expect(info.Config.User).toBe("1000:1000");
    } finally {
      controller.abort();
      await expect(pending).rejects.toThrow("plugin_cancelled");
    }
    const after = (
      await execute("docker", [
        "ps",
        "-aq",
        "--filter",
        "label=repodesk.plugin-sandbox=true",
      ])
    ).stdout;
    expect(after).not.toContain(id);
  },
  15000,
);
check(
  "expiry sweep removes an interrupted task and preserves a current task",
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { reapPluginSandboxes } = await import(
      "../../src/plugins/docker-sandbox.ts"
    );
    const execute = promisify(execFile);
    const ids: string[] = [];
    try {
      for (const deadline of [Date.now() - 1000, Date.now() + 60000]) {
        const started = await execute("docker", [
          "run",
          "-d",
          "--network",
          "none",
          "--read-only",
          "--memory",
          "64m",
          "--pids-limit",
          "8",
          "--cap-drop",
          "ALL",
          "--label",
          "repodesk.plugin-sandbox=true",
          "--label",
          `repodesk.plugin-deadline=${deadline}`,
          "--entrypoint",
          "node",
          image as string,
          "-e",
          "setInterval(()=>{},1000)",
        ]);
        ids.push(started.stdout.trim());
      }
      expect(await reapPluginSandboxes()).toBeGreaterThanOrEqual(1);
      const remaining = (
        await execute("docker", [
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          "label=repodesk.plugin-sandbox=true",
        ])
      ).stdout;
      expect(remaining).not.toContain(ids[0] ?? "missing");
      expect(remaining).toContain(ids[1] ?? "missing");
    } finally {
      for (const id of ids)
        await execute("docker", ["rm", "-f", id]).catch(() => {});
    }
  },
  15000,
);
