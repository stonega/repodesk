import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar";
import {
  type CodeTargetConfig,
  type GitHubRepository,
  parseGitHubRepositoryUrl,
} from "../config/schema.ts";
import type {
  ArchiveStream,
  GitHubRepositorySource,
} from "./github-repository-source.ts";
import type { CodeGraphRunner } from "./runner.ts";

const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export type Snapshot = {
  target: string;
  network: string;
  branch: string;
  commit: string;
  indexedAt: string;
  path: string;
};

export type PublicSnapshot = Omit<Snapshot, "path">;

export type TargetStatus = {
  target: string;
  networks: Array<
    | (PublicSnapshot & { status: "ready" })
    | {
        target: string;
        network: string;
        branch: string;
        status: "unavailable";
        error?: string;
      }
  >;
};

export type SyncReport = {
  updated: PublicSnapshot[];
  errors: Array<{ target: string; network?: string; message: string }>;
};

type RepositoryManagerOptions = {
  dataDir: string;
  targets: CodeTargetConfig[];
  snapshotRetention: number;
  codegraph: CodeGraphRunner;
  repositorySource: GitHubRepositorySource;
  clock?: () => Date;
};

export class RepositoryManager {
  readonly #snapshotRoot: string;
  readonly #targets: Map<string, CodeTargetConfig>;
  readonly #snapshotRetention: number;
  readonly #codegraph: CodeGraphRunner;
  readonly #repositorySource: GitHubRepositorySource;
  readonly #clock: () => Date;
  readonly #active = new Map<string, Snapshot>();
  readonly #leases = new Map<string, number>();
  readonly #errors = new Map<string, string>();
  #syncPromise: Promise<SyncReport> | undefined;

  constructor(options: RepositoryManagerOptions) {
    this.#snapshotRoot = resolve(options.dataDir, "snapshots");
    this.#targets = new Map(
      options.targets.map((target) => [target.id, target]),
    );
    this.#snapshotRetention = options.snapshotRetention;
    this.#codegraph = options.codegraph;
    this.#repositorySource = options.repositorySource;
    this.#clock = options.clock ?? (() => new Date());
  }

  isReady(): boolean {
    for (const target of this.#targets.values()) {
      for (const network of Object.keys(target.networks)) {
        if (!this.#active.has(snapshotKey(target.id, network))) return false;
      }
    }
    return true;
  }

  statuses(): TargetStatus[] {
    return [...this.#targets.values()].map((target) => ({
      target: target.id,
      networks: Object.entries(target.networks).map(([network, branch]) => {
        const key = snapshotKey(target.id, network);
        const snapshot = this.#active.get(key);
        if (snapshot)
          return { ...toPublicSnapshot(snapshot), status: "ready" as const };
        const error = this.#errors.get(key);
        return {
          target: target.id,
          network,
          branch,
          status: "unavailable" as const,
          ...(error ? { error } : {}),
        };
      }),
    }));
  }

  syncAll(): Promise<SyncReport> {
    if (this.#syncPromise) return this.#syncPromise;
    const operation = this.#syncAllInternal();
    this.#syncPromise = operation;
    const clear = () => {
      if (this.#syncPromise === operation) this.#syncPromise = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  async withSnapshot<T>(
    targetId: string,
    network: string,
    operation: (snapshot: Snapshot) => Promise<T>,
  ): Promise<T> {
    const target = this.#targets.get(targetId);
    if (!target || !(network in target.networks)) {
      throw new Error("Unknown code target or network");
    }
    const snapshot = this.#active.get(snapshotKey(targetId, network));
    if (!snapshot)
      throw new Error("The requested code target is not indexed yet");
    this.#leases.set(snapshot.path, (this.#leases.get(snapshot.path) ?? 0) + 1);
    try {
      return await operation(snapshot);
    } finally {
      const remaining = (this.#leases.get(snapshot.path) ?? 1) - 1;
      if (remaining <= 0) this.#leases.delete(snapshot.path);
      else this.#leases.set(snapshot.path, remaining);
    }
  }

  async #syncAllInternal(): Promise<SyncReport> {
    await mkdir(this.#snapshotRoot, { recursive: true });
    const report: SyncReport = { updated: [], errors: [] };
    for (const target of this.#targets.values()) {
      try {
        await this.#syncTarget(target, report);
      } catch (error) {
        const message = publicSyncError(error);
        report.errors.push({ target: target.id, message });
        for (const network of Object.keys(target.networks)) {
          this.#errors.set(snapshotKey(target.id, network), message);
        }
      }
    }
    await this.#cleanupSnapshots();
    return report;
  }

  async #syncTarget(
    target: CodeTargetConfig,
    report: SyncReport,
  ): Promise<void> {
    const repository = parseGitHubRepositoryUrl(target.repositoryUrl);
    if (!repository) throw new Error("Configured repository URL is invalid");

    for (const [network, branch] of Object.entries(target.networks)) {
      const key = snapshotKey(target.id, network);
      try {
        const commit = await this.#repositorySource.resolveBranch(
          repository,
          branch,
        );
        const snapshotPath = await this.#ensureSnapshot(
          target.id,
          repository,
          commit,
        );
        const metadata = await readSnapshotMetadata(snapshotPath);
        const snapshot: Snapshot = {
          target: target.id,
          network,
          branch,
          commit,
          indexedAt: metadata.indexedAt,
          path: snapshotPath,
        };
        this.#active.set(key, snapshot);
        this.#errors.delete(key);
        report.updated.push(toPublicSnapshot(snapshot));
      } catch (error) {
        const message = publicSyncError(error);
        this.#errors.set(key, message);
        report.errors.push({ target: target.id, network, message });
      }
    }
  }

  async #ensureSnapshot(
    targetId: string,
    repository: GitHubRepository,
    commit: string,
  ): Promise<string> {
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Invalid commit identifier");
    const targetRoot = join(this.#snapshotRoot, targetId);
    const snapshotPath = join(targetRoot, commit);
    if (
      (await exists(join(snapshotPath, ".codegraph"))) &&
      (await exists(join(snapshotPath, ".snapshot.json")))
    ) {
      return snapshotPath;
    }
    await mkdir(targetRoot, { recursive: true });
    if (await exists(snapshotPath)) await this.#safeRemove(snapshotPath);
    const temporaryPath = join(
      targetRoot,
      `${commit}.building-${randomSuffix()}`,
    );
    try {
      await mkdir(temporaryPath, { recursive: true, mode: 0o700 });
      const archive = await this.#repositorySource.downloadArchive(
        repository,
        commit,
      );
      await extractRepositoryArchive(archive, temporaryPath);
      await Promise.all([
        rm(join(temporaryPath, ".codegraph"), { recursive: true, force: true }),
        rm(join(temporaryPath, ".snapshot.json"), { force: true }),
      ]);
      if ((await readdir(temporaryPath)).length === 0) {
        throw new Error("GitHub returned an empty repository archive");
      }
      await this.#codegraph.initialize(temporaryPath);
      await writeFile(
        join(temporaryPath, ".snapshot.json"),
        `${JSON.stringify({ commit, indexedAt: this.#clock().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(temporaryPath, snapshotPath);
      return snapshotPath;
    } catch (error) {
      await this.#safeRemove(temporaryPath);
      throw error;
    }
  }

  async #cleanupSnapshots(): Promise<void> {
    const activePaths = new Set(
      [...this.#active.values()].map((snapshot) => snapshot.path),
    );
    for (const target of this.#targets.values()) {
      const targetRoot = join(this.#snapshotRoot, target.id);
      if (!(await exists(targetRoot))) continue;
      const entries = await readdir(targetRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.includes(".building-")) {
          await this.#safeRemove(join(targetRoot, entry.name));
        }
      }
      const commits = await Promise.all(
        entries
          .filter(
            (entry) => entry.isDirectory() && COMMIT_PATTERN.test(entry.name),
          )
          .map(async (entry) => {
            const path = join(targetRoot, entry.name);
            return { path, modifiedAt: (await stat(path)).mtimeMs };
          }),
      );
      commits.sort((left, right) => right.modifiedAt - left.modifiedAt);
      const retained = new Set(
        commits.slice(0, this.#snapshotRetention).map((entry) => entry.path),
      );
      for (const entry of commits) {
        if (
          activePaths.has(entry.path) ||
          retained.has(entry.path) ||
          this.#leases.has(entry.path)
        ) {
          continue;
        }
        await this.#codegraph.closeProject(entry.path);
        await this.#safeRemove(entry.path);
      }
    }
  }

  async #safeRemove(path: string): Promise<void> {
    const absolute = resolve(path);
    const pathWithinSnapshotRoot = relative(this.#snapshotRoot, absolute);
    if (
      pathWithinSnapshotRoot.startsWith("..") ||
      pathWithinSnapshotRoot === "" ||
      dirname(absolute) === this.#snapshotRoot ||
      basename(absolute) === ""
    ) {
      throw new Error(
        "Refusing to remove a path outside a managed target snapshot directory",
      );
    }
    await rm(absolute, { recursive: true, force: true });
  }
}

function snapshotKey(target: string, network: string): string {
  return `${target}:${network}`;
}

function toPublicSnapshot(snapshot: Snapshot): PublicSnapshot {
  const { path: _path, ...publicSnapshot } = snapshot;
  return publicSnapshot;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readSnapshotMetadata(
  path: string,
): Promise<{ indexedAt: string }> {
  const raw = await readFile(join(path, ".snapshot.json"), "utf8");
  const value = JSON.parse(raw) as { indexedAt?: unknown };
  if (typeof value.indexedAt !== "string")
    throw new Error("Snapshot metadata is invalid");
  return { indexedAt: value.indexedAt };
}

function publicSyncError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replaceAll(resolve(process.cwd()), "[workspace]")
      .slice(0, 500);
  }
  return "Repository synchronization failed";
}

function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function extractRepositoryArchive(
  archive: ArchiveStream,
  destination: string,
): Promise<void> {
  await pipeline(
    Readable.from(limitArchiveSize(archive)),
    extract({
      cwd: destination,
      strip: 1,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      unlink: true,
      maxDepth: 256,
      maxDecompressionRatio: 1000,
    }),
  );
}

async function* limitArchiveSize(
  archive: ArchiveStream,
): AsyncGenerator<Uint8Array> {
  let receivedBytes = 0;
  for await (const chunk of archive) {
    if (!(chunk instanceof Uint8Array))
      throw new Error("GitHub archive stream is invalid");
    receivedBytes += chunk.byteLength;
    if (receivedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("GitHub repository archive exceeds the 512 MiB limit");
    }
    yield chunk;
  }
}
