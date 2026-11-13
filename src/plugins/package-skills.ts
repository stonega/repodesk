import { posix } from "node:path";
import { readSkillMarkdown, skillTextSafe } from "../skills/markdown.ts";
import { skillResourcePaths } from "../skills/resources.ts";
import { PluginError } from "./contract.ts";
import type { PackageFiles } from "./local-package.ts";
import type { PluginManifest } from "./manifest.ts";

export interface PackageGuide {
  path: string;
  name: string;
  description: string;
  resources: string[];
}
export function packageSkillFiles(
  manifest: PluginManifest,
  files: PackageFiles,
) {
  const selected = new Set<string>();
  for (const entry of manifest.skills) {
    const directory = posix.dirname(entry.path);
    const queue = [entry.path];
    let bytes = 0;
    let count = 0;
    const visited = new Set<string>();
    while (queue.length) {
      const path = queue.shift();
      if (!path || visited.has(path)) continue;
      visited.add(path);
      if (
        ++count > 33 ||
        manifest.skills.some(
          (s) =>
            s.path !== entry.path &&
            path.startsWith(`${posix.dirname(s.path)}/`),
        )
      )
        throw new PluginError("plugin_package_invalid");
      const content = files[path];
      if (
        !content ||
        content.length > (path === entry.path ? 16384 : 65536) ||
        content.includes(0)
      )
        throw new PluginError("plugin_package_invalid");
      bytes += content.length;
      if (bytes > 262144) throw new PluginError("plugin_package_invalid");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      selected.add(path);
      for (const linked of skillResourcePaths(
        text,
        posix.relative(directory, path),
      ))
        queue.push(posix.join(directory, linked));
    }
  }
  return [...selected];
}
export function packageGuides(
  manifest: PluginManifest,
  files: PackageFiles,
): PackageGuide[] {
  try {
    const paths = packageSkillFiles(manifest, files);
    return manifest.skills.map(({ path }) => {
      const parsed = readSkillMarkdown(
        (files[path] as Buffer).toString("utf8"),
      );
      if (
        (parsed.tools ?? []).some(
          (name) =>
            !manifest.tools.some((t) => t.name === name) &&
            name !== "load_guide",
        )
      )
        throw new PluginError("plugin_package_invalid");
      const directory = posix.dirname(path);
      const resources = paths.filter(
        (resource) => resource !== path && resource.startsWith(`${directory}/`),
      );
      if (
        !/^[a-z][a-z0-9-]{1,63}$/.test(parsed.name) ||
        !parsed.description.trim() ||
        !parsed.body.trim() ||
        !skillTextSafe(
          [
            parsed.body,
            parsed.description,
            JSON.stringify(parsed.frontmatter),
            ...resources.map((r) => (files[r] as Buffer).toString("utf8")),
          ].join("\n"),
        )
      )
        throw new PluginError("plugin_package_invalid");
      return {
        path,
        name: parsed.name,
        description: parsed.description,
        resources,
      };
    });
  } catch {
    throw new PluginError("plugin_package_invalid");
  }
}
/** Canonical runtime inventory; source and build files remain pinned by the commit. */
export function selectPackageFiles(
  manifest: PluginManifest,
  files: PackageFiles,
): PackageFiles {
  const selected: PackageFiles = Object.create(null);
  for (const path of [
    "repodesk.plugin.json",
    "package.json",
    "README.md",
    "LICENSE",
    manifest.runtime.entry,
    ...packageSkillFiles(manifest, files),
  ]) {
    const value = files[path];
    if (!value) throw new PluginError("plugin_package_invalid");
    selected[path] = value;
  }
  packageGuides(manifest, selected);
  return selected;
}
export function guideText(
  manifest: PluginManifest,
  files: PackageFiles,
  repositoryId: number,
  path: string,
) {
  const guides = packageGuides(manifest, files);
  const guide = guides.find(
    (g) => g.path === path || g.resources.includes(path),
  );
  if (!guide) throw new PluginError("plugin_permission_denied");
  const raw = (files[path] as Buffer).toString("utf8");
  const text = path === guide.path ? readSkillMarkdown(raw).body : raw;
  const names = new Set([...manifest.tools.map((t) => t.name), "load_guide"]);
  return text.replace(/\b[a-z][a-z0-9_]{0,31}\b/g, (name) =>
    names.has(name) ? `rdp_${repositoryId}_${name}` : name,
  );
}
