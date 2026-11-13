import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, posix, relative, resolve } from "node:path";
import { skillResourcePaths } from "../skills/resources.ts";
import { limits, PluginError } from "./contract.ts";
import { sha256 } from "./digest.ts";
import {
  type PluginManifest,
  parseManifest,
  safeResourcePath,
} from "./manifest.ts";
import { packageGuides } from "./package-skills.ts";

export { sha256 } from "./digest.ts";
export type PackageFiles = Record<string, Buffer>;
export function packageDigest(files: PackageFiles): string {
  return sha256(
    JSON.stringify(
      Object.keys(files)
        .sort()
        .map((path) => [path, sha256(files[path] as Buffer)]),
    ),
  );
}
export function validatePackageFiles(files: PackageFiles) {
  try {
    const paths = Object.keys(files);
    if (
      paths.length > limits.files ||
      paths.some((p) => !safeResourcePath(p)) ||
      paths.reduce((sum, p) => sum + (files[p]?.byteLength ?? 0), 0) >
        limits.package
    )
      throw new PluginError("plugin_package_invalid");
    const raw = files["repodesk.plugin.json"];
    if (!raw || raw.length > limits.manifest)
      throw new PluginError("plugin_manifest_invalid");
    const manifest = parseManifest(JSON.parse(raw.toString("utf8")));
    const entry = files[manifest.runtime.entry];
    if (!entry?.length || entry.length > limits.bundle)
      throw new PluginError("plugin_package_invalid");
    const pkg = files["package.json"];
    if (
      !pkg ||
      pkg.length > limits.manifest ||
      JSON.parse(pkg.toString("utf8")).version !== manifest.version
    )
      throw new PluginError("plugin_package_invalid");
    for (const skill of manifest.skills) {
      const content = files[skill.path];
      if (!content || content.length > 16384 || content.includes(0))
        throw new PluginError("plugin_package_invalid");
    }
    for (const required of ["README.md", "LICENSE"])
      if (!files[required]?.length || (files[required]?.length ?? 0) > 131072)
        throw new PluginError("plugin_package_invalid");
    packageGuides(manifest, files);
    return {
      manifest,
      digest: packageDigest(files),
      bundleHash: sha256(entry),
      manifestHash: sha256(raw),
    };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("plugin_package_invalid");
  }
}

async function regularFile(root: string, path: string, cap: number) {
  if (!safeResourcePath(path)) throw new PluginError("plugin_package_invalid");
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new PluginError("plugin_package_invalid");
  }
  const info = await lstat(current);
  if (!info.isFile() || info.size > cap)
    throw new PluginError("plugin_package_invalid");
  const bytes = await readFile(current);
  if (bytes.length > cap) throw new PluginError("plugin_package_invalid");
  return bytes;
}

export async function readLocalManifest(
  directory: string,
): Promise<PluginManifest> {
  try {
    return parseManifest(
      JSON.parse(
        (
          await regularFile(
            await realpath(resolve(directory)),
            "repodesk.plugin.json",
            limits.manifest,
          )
        ).toString("utf8"),
      ),
    );
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("plugin_manifest_invalid");
  }
}
export async function loadLocalPackage(directory: string) {
  const root = await realpath(resolve(directory));
  const manifest = await readLocalManifest(root);
  const files: PackageFiles = {};
  for (const path of [
    "repodesk.plugin.json",
    "package.json",
    "README.md",
    "LICENSE",
    manifest.runtime.entry,
    ...manifest.skills.map((s) => s.path),
  ])
    files[path] = await regularFile(
      root,
      path,
      path === manifest.runtime.entry ? limits.bundle : limits.manifest,
    );
  for (const skill of manifest.skills) {
    const directory = posix.dirname(skill.path);
    const queue = [skill.path];
    const visited = new Set<string>();
    let total = 0;
    while (queue.length) {
      const path = queue.shift();
      if (!path || visited.has(path)) continue;
      visited.add(path);
      if (visited.size > 33) throw new PluginError("plugin_package_invalid");
      files[path] ??= await regularFile(
        root,
        path,
        path === skill.path ? 16384 : 65536,
      );
      total += files[path].length;
      if (total > 262144) throw new PluginError("plugin_package_invalid");
      for (const linked of skillResourcePaths(
        files[path].toString("utf8"),
        posix.relative(directory, path),
      ))
        queue.push(posix.join(directory, linked));
    }
  }
  return { root, files, ...validatePackageFiles(files) };
}
export function generatedContractPath(directory: string) {
  return join(resolve(directory), "src", "generated", "contract.ts");
}
export function relativeImport(from: string, to: string) {
  const path = relative(dirname(from), to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}
