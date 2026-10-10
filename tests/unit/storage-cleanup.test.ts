import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cleanup = await import(
  new URL("../../scripts/cleanup-host.mjs", import.meta.url).href
);
const host = await import(
  new URL("../../scripts/update-host.mjs", import.meta.url).href
);
const now = Date.parse("2026-10-10T12:00:00Z");
const repositories = [
  "repodesk",
  "repodesk-codex-job",
  "repodesk-codex-supervisor",
];
const commit = (n: number) => n.toString(16).padStart(40, "0");
const tag = (n: number, repository = "repodesk") =>
  `${repository}:release-${commit(n)}`;
type Image = { id: string; created: string; tags: string[] };
const image = (n: number, repository = "repodesk", age = n): Image => ({
  id: `sha256:${(n * 10 + repositories.indexOf(repository)).toString(16).padStart(64, "0")}`,
  created: new Date(now - age * 86400000).toISOString(),
  tags: [tag(n, repository)],
});
const releases = [1, 2, 3, 4, 5, 6].flatMap((n) =>
  repositories.map((repository) => image(n, repository)),
);
const current = repositories.map((repository) => tag(5, repository));

test("cleanup retains current release even when older, two complete sets and every container reference", () => {
  const referenced = image(6, "repodesk-codex-job");
  const plan = cleanup.planReleaseCleanup(
    releases,
    current,
    [referenced.id],
    now,
  );
  expect(plan.map((entry: { tag: string }) => entry.tag).sort()).toEqual(
    [
      ...repositories.map((repository) => tag(3, repository)),
      ...repositories.map((repository) => tag(4, repository)),
      tag(6),
      tag(6, "repodesk-codex-supervisor"),
    ].sort(),
  );
});

test("fresh and partial builds cannot evict complete rollback sets or delete an aliased retained image", () => {
  const partial = image(7, "repodesk", 0.1);
  const retainedAlias = { ...image(2), tags: [tag(2), tag(9)] };
  const unrelated = {
    ...image(10),
    tags: ["other-app:release", "repodesk:local"],
  };
  const images = [
    ...releases.filter((value) => value.id !== retainedAlias.id),
    retainedAlias,
    partial,
    unrelated,
  ];
  const plan = cleanup.planReleaseCleanup(images, current, [], now);
  expect(
    plan.some((entry: { tag: string }) =>
      [tag(7), tag(9), ...unrelated.tags].includes(entry.tag),
    ),
  ).toBe(false);
  expect(plan.some((entry: { tag: string }) => entry.tag === tag(3))).toBe(
    true,
  );
});

test("cleanup rejects missing current images and malformed metadata before proposing deletion", () => {
  expect(() =>
    cleanup.planReleaseCleanup(releases, ["repodesk:latest"], [], now),
  ).toThrow();
  expect(() =>
    cleanup.planReleaseCleanup(releases, [tag(99)], [], now),
  ).toThrow("current_release_image_missing");
  expect(() =>
    cleanup.planReleaseCleanup(
      releases,
      [tag(1), tag(2, "repodesk-codex-job")],
      [],
      now,
    ),
  ).toThrow("current_release_invalid");
  expect(() =>
    cleanup.planReleaseCleanup(
      [{ ...image(1), created: "invalid" }],
      [tag(1)],
      [],
      now,
    ),
  ).toThrow("image_metadata_invalid");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repodesk-cleanup-"));
  const directory = join(root, "releases", "123-1");
  await mkdir(directory, { recursive: true });
  await writeFile(join(root, ".current-release"), "123-1\n");
  for (const [name, repository] of [
    ["image-tag", "repodesk"],
    ["codex-job-tag", "repodesk-codex-job"],
    ["codex-supervisor-tag", "repodesk-codex-supervisor"],
  ])
    await writeFile(join(directory, name ?? ""), tag(5, repository));
  return root;
}

test("dry run never issues Docker mutations and aborts when release marker is untrusted", async () => {
  const root = await fixture();
  const commands: string[][] = [];
  const run = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "image" && args[1] === "ls")
      return releases.flatMap((value) => value.tags).join("\n");
    if (args[0] === "image" && args[1] === "inspect")
      return releases.map((value) => JSON.stringify(value)).join("\n");
    return "";
  };
  try {
    const plan = await cleanup.cleanupHost(root, false, run, () => {});
    expect(plan.length).toBeGreaterThan(0);
    expect(
      commands.some((args) => args.includes("prune") || args.includes("rm")),
    ).toBe(false);
    await writeFile(join(root, ".current-release"), "../../escape");
    const count = commands.length;
    await expect(
      cleanup.cleanupHost(root, true, run, () => {}),
    ).rejects.toThrow("current_release_invalid");
    expect(commands.length).toBe(count);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply rechecks changed tags and new container references, and only prunes host build cache", async () => {
  const root = await fixture();
  const commands: string[][] = [];
  let listed = 0;
  const run = async (args: string[]) => {
    commands.push(args);
    if (args[0] === "image" && args[1] === "ls")
      return releases.flatMap((value) => value.tags).join("\n");
    if (args[0] === "image" && args[1] === "inspect") {
      if (args[3] !== "{{.Id}}")
        return releases.map((value) => JSON.stringify(value)).join("\n");
      return args[4] === tag(3)
        ? image(99).id
        : (releases.find((value) => value.tags.includes(args[4] ?? ""))?.id ??
            "");
    }
    if (args[0] === "container" && args[1] === "ls")
      return ++listed === 1 ? "" : "new-container";
    if (args[0] === "container" && args[1] === "inspect") return image(4).id;
    return "";
  };
  try {
    await cleanup.cleanupHost(root, true, run, () => {});
    const removed = commands.filter((args) => args[1] === "rm");
    expect(removed.length).toBeGreaterThan(0);
    expect(
      removed.every(
        (args) =>
          args[0] === "image" &&
          args[2] === "--no-prune" &&
          !args.includes("--force"),
      ),
    ).toBe(true);
    expect(
      removed.some((args) => args.includes(tag(3)) || args.includes(tag(4))),
    ).toBe(false);
    expect(commands.filter((args) => args.includes("prune"))).toEqual([
      ["builder", "prune", "--all", "--force", "--keep-storage", "4GB"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage lock excludes overlapping maintenance, releases on errors, and fences updater execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-cleanup-lock-"));
  try {
    await cleanup.withStorageLock(root, async () => {
      expect(
        await cleanup.withStorageLock(root, () => {
          throw Error("must not execute");
        }),
      ).toBe(false);
    });
    await expect(
      cleanup.withStorageLock(root, () => {
        throw Error("fixture");
      }),
    ).rejects.toThrow("fixture");
    expect(await cleanup.withStorageLock(root, () => {})).toBe(true);
    for (const child of ["results", "logs"])
      await mkdir(join(root, "updates", child), { recursive: true });
    let ran = false;
    await host.processRequest(
      {
        requestId: crypto.randomUUID(),
        repository: "stonega/repodesk",
        releaseId: 42,
        tag: "v0.1.34",
        commit: commit(5),
        fingerprint: "a".repeat(64),
      },
      { root, project: "repodesk", repository: "stonega/repodesk" },
      async () => {
        ran = true;
        expect(
          await cleanup.withStorageLock(root, () => {
            throw Error("must not execute");
          }),
        ).toBe(false);
      },
    );
    expect(ran).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an updater waiting for cleanup enters only after maintenance releases its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "repodesk-cleanup-wait-"));
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((accept) => {
    release = accept;
  });
  const ready = new Promise<void>((accept) => {
    entered = accept;
  });
  let updated = false;
  const maintenance = cleanup.withStorageLock(root, async () => {
    entered();
    await gate;
  });
  try {
    await ready;
    const update = cleanup.withStorageLock(
      root,
      () => {
        updated = true;
      },
      true,
    );
    await Bun.sleep(30);
    expect(updated).toBe(false);
    release();
    expect(await maintenance).toBe(true);
    expect(await update).toBe(true);
    expect(updated).toBe(true);
  } finally {
    release();
    await maintenance;
    await rm(root, { recursive: true, force: true });
  }
});

async function ciFixture(labels: string, failPrune = false) {
  const root = await mkdtemp(join(tmpdir(), "repodesk-ci-cleanup-"));
  await writeFile(
    join(root, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$CLEANUP_COMMAND_LOG"\nif [[ "$*" == *' info '* ]]; then\n  printf '%s\\n' '${labels}'\nelse\n  exit ${failPrune ? 1 : 0}\nfi\n`,
    { mode: 0o700 },
  );
  const process = Bun.spawn(
    [
      "bash",
      new URL("../../deploy/actions-runner/cleanup.sh", import.meta.url)
        .pathname,
    ],
    {
      env: {
        ...Bun.env,
        PATH: `${root}:${Bun.env.PATH}`,
        CLEANUP_COMMAND_LOG: join(root, "commands"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await process.exited;
  const output = await new Response(process.stderr).text();
  const commands = await readFile(join(root, "commands"), "utf8");
  await rm(root, { recursive: true, force: true });
  return { code, output, commands };
}

test("CI hook refuses production daemon; isolated cleanup uses only its own socket", async () => {
  const rejected = await ciFixture("[]");
  expect(rejected.code).toBe(1);
  expect(rejected.commands).not.toContain("prune");
  const accepted = await ciFixture('["repodesk.ci=true"]');
  expect(accepted.code).toBe(0);
  expect(accepted.commands.trim().split("\n")).toEqual([
    "--host unix:///var/run/docker.sock info --format {{json .Labels}}",
    "--host unix:///var/run/docker.sock image prune --all --force --filter until=24h",
    "--host unix:///var/run/docker.sock builder prune --all --force --keep-storage 2GB",
    "--host unix:///var/run/docker.sock volume prune --all --force",
  ]);
});

test("CI prune failures are visible, retryable, and do not turn completed jobs into failures", async () => {
  const result = await ciFixture('["repodesk.ci=true"]', true);
  expect(result.code).toBe(0);
  expect(result.output).toContain("failed or timed out");
  expect(result.commands).toContain("volume prune");
});
