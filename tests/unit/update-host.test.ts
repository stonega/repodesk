import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const host = await import(
  new URL("../../scripts/update-host.mjs", import.meta.url).href
);
const raw = {
  id: 42,
  tag_name: "v0.1.33",
  name: "Release",
  body: "Update notes",
  published_at: "2026-10-09T00:00:00Z",
  draft: false,
  prerelease: false,
};
const commit = "a".repeat(40);
const request = {
  requestId: randomUUID(),
  repository: "stonega/repodesk",
  releaseId: 42,
  tag: raw.tag_name,
  commit,
  fingerprint: createHash("sha256")
    .update(JSON.stringify([raw, commit]))
    .digest("hex"),
};
const transport = async (input: string | URL | Request) =>
  Response.json(
    String(input).includes("/commits/")
      ? { sha: commit }
      : String(input).includes("/actions/")
        ? {
            workflow_runs: [
              { head_sha: commit, event: "push", conclusion: "success" },
            ],
          }
        : raw,
  );
test("host accepts only its configured repository and an exact reviewed stable release", async () => {
  await host.verifySelection(request, request.repository, undefined, transport);
  for (const patch of [
    { repository: "other/host" },
    { tag: "main; shutdown" },
    { commit: "--upload-pack=x" },
    { requestId: "../../escape" },
  ])
    expect(() =>
      host.validateRequest({ ...request, ...patch }, request.repository),
    ).toThrow("invalid_update_request");
  await expect(
    host.verifySelection(
      request,
      request.repository,
      undefined,
      async (input: string) =>
        String(input).includes("/commits/")
          ? Response.json({ sha: "b".repeat(40) })
          : Response.json(raw),
    ),
  ).rejects.toThrow("release_changed");
  await expect(
    host.verifySelection(request, request.repository, undefined, async () =>
      Response.json({ ...raw, body: "Changed notes" }),
    ),
  ).rejects.toThrow("release_changed");
});
test("host refuses commits without passing verification", async () => {
  await host.requireVerifiedCommit(request, undefined, transport);
  for (const patch of [
    { conclusion: "failure" },
    { head_sha: "b".repeat(40) },
    { event: "workflow_dispatch" },
    { event: "pull_request" },
  ])
    await expect(
      host.requireVerifiedCommit(request, undefined, async () =>
        Response.json({
          workflow_runs: [
            {
              head_sha: commit,
              event: "push",
              conclusion: "success",
              ...patch,
            },
          ],
        }),
      ),
    ).rejects.toThrow("verification_failed");
});
test("host daemon starts under Node and publishes heartbeat without Docker or network work", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-node-updater-"));
  await writeFile(join(root, ".env"), "fixture\n");
  const process = Bun.spawn(
    [
      "node",
      new URL("../../scripts/update-host.mjs", import.meta.url).pathname,
      root,
      "updater-fixture",
      request.repository,
      "--locked",
    ],
    {
      env: {
        ...Bun.env,
        UPDATES_GITHUB_TOKEN_FILE: "",
        UPDATES_GITHUB_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    let heartbeat: { repository: string; at: string } | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        heartbeat = JSON.parse(
          await readFile(join(root, "updates/heartbeat.json"), "utf8"),
        );
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    expect(heartbeat?.repository).toBe(request.repository);
    expect(Date.parse(heartbeat?.at ?? "")).toBeGreaterThan(Date.now() - 5000);
  } finally {
    process.kill();
    await process.exited;
    await rm(root, { recursive: true, force: true });
  }
});
test("pinned local builds and runtime smoke precede protected host cutover", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-host-build-"));
  const commands: string[][] = [];
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command === "git" && args.includes("checkout")) {
      const source = args[1] ?? "";
      for (const file of [
        "package.json",
        "compose.yaml",
        "scripts/deploy-vps.sh",
        "deploy/codex/docker-compose.yaml",
        "deploy/codex/release-config.mjs",
        "deploy/codex/wait-checkpoint.mjs",
        "scripts/update-host.mjs",
        "scripts/cleanup-host.mjs",
      ]) {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await writeFile(
          join(source, file),
          file === "package.json" ? '{"version":"0.1.33"}' : "fixture",
        );
      }
    }
    if (command === "docker" && args[0] === "image")
      return `sha256:${"c".repeat(64)}`;
    return args.includes("rev-parse") ? commit : "";
  };
  try {
    await host.installRelease(
      request,
      { root, project: "repodesk", repository: request.repository },
      run,
      transport,
    );
    const cutover = commands.findIndex(
      (args) => args[0] === "bash" && args[1]?.endsWith("deploy-vps.sh"),
    );
    expect(cutover).toBeGreaterThan(
      commands.findIndex((args) => args.includes("dist/runtime-contract.js")),
    );
    expect(
      commands.filter((args) => args[0] === "docker" && args[1] === "build"),
    ).toHaveLength(3);
    expect(
      commands.some((args) => args.includes("fetch") && args.includes(commit)),
    ).toBe(true);
    expect(commands[cutover]?.slice(-2)).toEqual([
      "repodesk",
      "--local-images",
    ]);
    expect(commands.some((args) => args.includes("archive"))).toBe(false);
    const bundle = commands[cutover]?.[1];
    expect(bundle).toBeDefined();
    expect(
      await readFile(join(dirname(bundle ?? ""), "image-id"), "utf8"),
    ).toBe(`sha256:${"c".repeat(64)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("low disk space rejects installation before builds or cutover and exposes a safe failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-host-space-"));
  const config = { root, project: "repodesk", repository: request.repository };
  const commands: string[] = [];
  try {
    for (const child of ["results", "logs"])
      await mkdir(join(root, "updates", child), { recursive: true });
    await host.processRequest(request, config, async () => {
      await host.installRelease(
        request,
        config,
        async (command: string) => {
          commands.push(command);
          return "";
        },
        transport,
        async () => ({ bavail: 64, bsize: 1024 ** 2 }),
      );
    });
    expect(commands).toEqual([]);
    expect(
      JSON.parse(
        await readFile(
          join(root, "updates", "results", `${request.requestId}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({ state: "failed", error: "insufficient_disk_space" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("missing maintenance companion aborts before image builds or cutover", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-host-companion-"));
  const commands: string[][] = [];
  const run = async (command: string, args: string[]) => {
    commands.push([command, ...args]);
    if (command === "git" && args.includes("checkout"))
      await writeFile(
        join(args[1] ?? "", "package.json"),
        '{"version":"0.1.33"}',
      );
    return args.includes("rev-parse") ? commit : "";
  };
  try {
    await expect(
      host.installRelease(
        request,
        { root, project: "repodesk", repository: request.repository },
        run,
        transport,
      ),
    ).rejects.toThrow();
    expect(
      commands.some((args) => args[0] === "docker" || args[0] === "bash"),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("build failures never reach cutover and interrupted cutovers never replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-host-job-"));
  const config = { root, project: "repodesk", repository: request.repository };
  const statusPath = join(
    root,
    "updates",
    "results",
    `${request.requestId}.json`,
  );
  let executions = 0;
  try {
    for (const child of ["results", "logs"])
      await mkdir(join(root, "updates", child), { recursive: true });
    await host.processRequest(request, config, async () => {
      executions++;
      throw Error("private build diagnostic");
    });
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
      state: "failed",
      error: "update_failed",
    });
    expect(await readFile(statusPath, "utf8")).not.toContain("private");
    await host.processRequest(request, config, async () => {
      executions++;
    });
    expect(executions).toBe(1);
    await writeFile(statusPath, JSON.stringify({ state: "running" }));
    await host.processRequest(request, config, async () => {
      executions++;
    });
    expect(executions).toBe(1);
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toMatchObject({
      state: "unknown",
      error: "update_interrupted",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
