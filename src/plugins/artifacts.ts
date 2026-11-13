import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { limits, PluginError } from "./contract.ts";
import { type PackageFiles, validatePackageFiles } from "./local-package.ts";
import { safeResourcePath } from "./manifest.ts";

/** Private per-workspace cache. No cache path is served as a public URL. */
export class PluginArtifacts {
  constructor(private directory: string) {}
  private path(workspaceId: string, digest: string) {
    if (
      !z.string().uuid().safeParse(workspaceId).success ||
      !/^[a-f0-9]{64}$/.test(digest)
    )
      throw new PluginError("plugin_package_invalid");
    return join(this.directory, workspaceId, digest);
  }
  async put(workspaceId: string, files: PackageFiles) {
    const pkg = validatePackageFiles(files);
    const destination = this.path(workspaceId, pkg.digest);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(destination), ".staging-"));
    try {
      for (const [path, value] of Object.entries(files)) {
        const target = join(staging, "files", path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, value, { mode: 0o400, flag: "wx" });
      }
      await writeFile(
        join(staging, "inventory.json"),
        JSON.stringify(Object.keys(files).sort()),
        { mode: 0o400, flag: "wx" },
      );
      try {
        await rename(staging, destination);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        await this.get(workspaceId, pkg.digest);
      }
      return pkg;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  /** Caller holds the tenant state lock. Newly staged/downloaded bytes get a full day. */
  async collect(
    workspaceId: string,
    retained: ReadonlySet<string>,
    now = Date.now(),
  ) {
    const directory = dirname(this.path(workspaceId, "0".repeat(64)));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      if (
        !/^(?:[a-f0-9]{64}|\.staging-[A-Za-z0-9]+)$/.test(name) ||
        retained.has(name)
      )
        continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        now - info.mtimeMs < 86400000
      )
        continue;
      await rm(path, { recursive: true });
      removed++;
    }
    return removed;
  }
  async get(workspaceId: string, digest: string) {
    try {
      const directory = this.path(workspaceId, digest);
      const index = join(directory, "inventory.json");
      const info = await lstat(index);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > limits.manifest
      )
        throw new Error();
      const paths = z
        .array(z.string().max(512))
        .max(limits.files)
        .parse(JSON.parse(await readFile(index, "utf8")));
      if (new Set(paths).size !== paths.length) throw new Error();
      const files: PackageFiles = Object.create(null);
      let total = 0;
      for (const path of paths) {
        if (!safeResourcePath(path)) throw new Error();
        let target = join(directory, "files");
        for (const component of path.split("/")) {
          target = join(target, component);
          if ((await lstat(target)).isSymbolicLink()) throw new Error();
        }
        const stat = await lstat(target);
        total += stat.size;
        if (!stat.isFile() || total > limits.package) throw new Error();
        files[path] = await readFile(target);
      }
      const pkg = validatePackageFiles(files);
      if (pkg.digest !== digest) throw new Error();
      return { ...pkg, files };
    } catch {
      throw new PluginError("plugin_package_invalid");
    }
  }
}
