import { afterEach, describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { create } from "tar";
import type {
  ArchiveStream,
  GitHubRepositorySource,
} from "../src/upstream/codegraph/github-repository-source.ts";
import { RepositoryManager } from "../src/upstream/codegraph/repository-manager.ts";
import { CodeGraphRunner } from "../src/upstream/codegraph/runner.ts";
import {
  type GitHubRepository,
  loadConfig,
} from "../src/upstream/config/schema.ts";
import { BunProcessRunner } from "../src/upstream/lib/process.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("RepositoryManager", () => {
  test("publishes and reuses one immutable archive snapshot across networks", async () => {
    const directory = await temporaryDirectory("deepx-repositories-");
    const archivePath = await createRepositoryArchive(directory, {
      ".codegraph/untrusted": "not an index\n",
      ".snapshot.json": "not metadata\n",
      "README.md": "immutable archive fixture\n",
    });
    const commit = "a".repeat(40);
    const repositorySource = recordingRepositorySource(commit, archivePath);
    const codegraph = {
      async initialize(path: string) {
        await mkdir(join(path, ".codegraph"), { recursive: true });
      },
      async closeProject() {},
    } as unknown as CodeGraphRunner;
    const repositories = new RepositoryManager({
      dataDir: directory,
      targets: [
        {
          id: "deepx",
          repositoryUrl: "https://github.com/deepx/example.git",
          networks: { devnet: "devnet", testnet: "testnet" },
        },
      ],
      snapshotRetention: 2,
      repositorySource,
      codegraph,
      clock: () => new Date("2026-08-26T00:00:00.000Z"),
    });

    expect((await repositories.syncAll()).errors).toEqual([]);
    expect((await repositories.syncAll()).errors).toEqual([]);
    expect(repositories.isReady()).toBeTrue();
    expect(repositorySource.resolveCalls).toHaveLength(4);
    expect(repositorySource.downloadCalls).toEqual([
      { repository: { owner: "deepx", repo: "example" }, commit },
    ]);

    const statuses = repositories.statuses()[0]?.networks;
    expect(statuses?.map((status) => status.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(
      statuses?.map((status) =>
        status.status === "ready" ? status.commit : null,
      ),
    ).toEqual([commit, commit]);

    const selected = await repositories.withSnapshot(
      "deepx",
      "devnet",
      async (snapshot) => ({
        commit: snapshot.commit,
        path: snapshot.path,
        readme: await readFile(join(snapshot.path, "README.md"), "utf8"),
      }),
    );
    expect(selected.commit).toBe(commit);
    expect(selected.path).toEndWith(commit);
    expect(selected.readme).toBe("immutable archive fixture\n");
    expect(
      await pathExists(join(selected.path, ".codegraph", "untrusted")),
    ).toBeFalse();
    await expect(
      repositories.withSnapshot("deepx", "mainnet", async () => undefined),
    ).rejects.toThrow("Unknown code target");
  });

  test("reports a denied branch without publishing it", async () => {
    const directory = await temporaryDirectory("deepx-repositories-denied-");
    const repositorySource: GitHubRepositorySource = {
      async resolveBranch() {
        throw new Error("GitHub API request failed with status 404");
      },
      async downloadArchive() {
        throw new Error("archive download should not run");
      },
    };
    const repositories = new RepositoryManager({
      dataDir: directory,
      targets: [
        {
          id: "private",
          repositoryUrl: "https://github.com/deepx/private.git",
          networks: { devnet: "devnet" },
        },
      ],
      snapshotRetention: 2,
      repositorySource,
      codegraph: {} as CodeGraphRunner,
    });

    const report = await repositories.syncAll();
    expect(report.errors).toEqual([
      {
        target: "private",
        network: "devnet",
        message: "GitHub API request failed with status 404",
      },
    ]);
    expect(repositories.isReady()).toBeFalse();
  });

  test("rejects archive path traversal without writing outside the snapshot", async () => {
    const directory = await temporaryDirectory("deepx-repositories-traversal-");
    const archivePath = await createTraversalArchive(directory);
    const commit = "d".repeat(40);
    const repositories = new RepositoryManager({
      dataDir: directory,
      targets: [
        {
          id: "deepx",
          repositoryUrl: "https://github.com/deepx/private.git",
          networks: { devnet: "devnet" },
        },
      ],
      snapshotRetention: 2,
      repositorySource: recordingRepositorySource(commit, archivePath),
      codegraph: {} as CodeGraphRunner,
    });

    const report = await repositories.syncAll();
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.message).toContain("path contains '..'");
    expect(
      await pathExists(join(directory, "snapshots", "payload")),
    ).toBeFalse();
  });

  test("extracts and indexes a GitHub archive with the real CodeGraph runner", async () => {
    const directory = await temporaryDirectory(
      "deepx-repositories-integration-",
    );
    const archivePath = await createRepositoryArchive(directory, {
      "src/network.ts":
        "export function currentNetwork(): string { return 'devnet'; }\n",
    });
    const commit = "b".repeat(40);
    const repositorySource = recordingRepositorySource(commit, archivePath);
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      GITHUB_CLIENT_ID: "client",
      GITHUB_CLIENT_SECRET: "secret",
      GITHUB_ALLOWED_ORG: "deepx",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      CODE_TARGETS_JSON:
        '[{"id":"deepx","repositoryUrl":"https://github.com/deepx/repo.git","networks":{"devnet":"devnet"}}]',
    });
    const processRunner = new BunProcessRunner();
    const codegraph = new CodeGraphRunner(
      config.codegraphBinary,
      processRunner,
    );
    const repositories = new RepositoryManager({
      dataDir: join(directory, "data"),
      targets: [
        {
          id: "deepx",
          repositoryUrl: "https://github.com/deepx/repo.git",
          networks: { devnet: "devnet", testnet: "testnet" },
        },
      ],
      snapshotRetention: 2,
      repositorySource,
      codegraph,
    });

    const report = await repositories.syncAll();
    expect(report.errors).toEqual([]);
    const result = await repositories.withSnapshot(
      "deepx",
      "testnet",
      (snapshot) =>
        codegraph.search(snapshot.path, "currentNetwork", { limit: 10 }),
    );
    expect(JSON.stringify(result)).toContain("currentNetwork");
  }, 30_000);
});

type RecordingRepositorySource = GitHubRepositorySource & {
  resolveCalls: Array<{ repository: GitHubRepository; branch: string }>;
  downloadCalls: Array<{ repository: GitHubRepository; commit: string }>;
};

function recordingRepositorySource(
  commit: string,
  archivePath: string,
): RecordingRepositorySource {
  const resolveCalls: RecordingRepositorySource["resolveCalls"] = [];
  const downloadCalls: RecordingRepositorySource["downloadCalls"] = [];
  return {
    resolveCalls,
    downloadCalls,
    async resolveBranch(repository, branch) {
      resolveCalls.push({ repository, branch });
      return commit;
    },
    async downloadArchive(repository, resolvedCommit) {
      downloadCalls.push({ repository, commit: resolvedCommit });
      return createReadStream(archivePath) as ArchiveStream;
    },
  };
}

async function createRepositoryArchive(
  directory: string,
  files: Record<string, string>,
): Promise<string> {
  const rootName = "deepx-example-archive";
  const root = join(directory, rootName);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  const archivePath = join(directory, `${crypto.randomUUID()}.tar.gz`);
  await create(
    { cwd: directory, file: archivePath, gzip: true, portable: true },
    [rootName],
  );
  return archivePath;
}

async function createTraversalArchive(directory: string): Promise<string> {
  await writeFile(join(directory, "payload"), "must not escape\n");
  const archivePath = join(directory, `${crypto.randomUUID()}.tar.gz`);
  await create(
    {
      cwd: directory,
      file: archivePath,
      gzip: true,
      portable: true,
      preservePaths: true,
      prefix: "root/../..",
    },
    ["payload"],
  );
  return archivePath;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
