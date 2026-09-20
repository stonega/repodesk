import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MANIFESTS = new Map([
  ["package.json", "javascript"],
  ["Cargo.toml", "rust"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["Pipfile", "python"],
  ["setup.py", "python"],
  ["setup.cfg", "python"],
  ["go.mod", "go"],
  ["go.work", "go"],
  ["pom.xml", "java"],
  ["build.gradle", "jvm"],
  ["build.gradle.kts", "jvm"],
  ["settings.gradle", "jvm"],
  ["settings.gradle.kts", "jvm"],
  ["libs.versions.toml", "jvm"],
  ["Directory.Packages.props", "dotnet"],
  ["packages.config", "dotnet"],
  ["composer.json", "php"],
  ["Gemfile", "ruby"],
  ["Package.swift", "swift"],
  ["pubspec.yaml", "dart"],
  ["mix.exs", "elixir"],
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".codegraph",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".gradle",
  ".dart_tool",
  "Pods",
  ".swiftpm",
  ".build",
  ".bundle",
]);
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_DEPTH = 20;

export type DependencyManifest = {
  file: string;
  ecosystem: string;
  content: string;
  startLine: number;
  endLine: number;
  originalBytes: number;
  truncated: boolean;
};

export type ManifestOptions = {
  directory?: string;
  maxFiles: number;
  maxBytes: number;
};

/** Read data only: manifests are never parsed as executable build scripts. */
export async function readDependencyManifests(
  snapshotPath: string,
  options: ManifestOptions,
) {
  if (
    !Number.isInteger(options.maxFiles) ||
    options.maxFiles < 1 ||
    options.maxFiles > 100 ||
    !Number.isInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 80_000
  ) {
    throw new Error("Invalid manifest limits");
  }
  const root = await realpath(snapshotPath);
  const directory = options.directory ?? ".";
  if (
    isAbsolute(directory) ||
    /^[A-Za-z]:/.test(directory) ||
    hasUnsupportedCharacters(directory) ||
    directory.split("/").includes("..")
  ) {
    throw new Error("Invalid manifest directory");
  }
  let start = root;
  for (const segment of directory
    .split("/")
    .filter((part) => part !== "" && part !== ".")) {
    if (EXCLUDED_DIRECTORIES.has(segment))
      throw new Error("Excluded manifest directory");
    start = join(start, segment);
    if (!(await lstat(start)).isDirectory())
      throw new Error("Invalid manifest directory");
  }

  const pending = [{ path: start, depth: 0 }];
  const matches: Array<{ file: string; ecosystem: string }> = [];
  let scanned = 0;
  let truncated = false;
  scan: for (let index = 0; index < pending.length; index++) {
    const current = pending[index];
    if (!current) break;
    const entries = [];
    for await (const entry of await opendir(current.path)) {
      if (scanned >= MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      scanned++;
      entries.push(entry);
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      // Keep paths compatible with the server's relative file identifiers.
      if (hasUnsupportedCharacters(entry.name)) {
        truncated = true;
        continue;
      }
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        if (current.depth >= MAX_SCAN_DEPTH) truncated = true;
        else pending.push({ path, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const ecosystem = manifestEcosystem(entry.name);
        if (ecosystem) {
          matches.push({
            file: relative(root, path).split(sep).join("/"),
            ecosystem,
          });
          if (matches.length > options.maxFiles) {
            truncated = true;
            break scan;
          }
        }
      }
    }
    if (scanned >= MAX_SCAN_ENTRIES && index + 1 < pending.length) {
      truncated = true;
      break;
    }
  }

  const manifests: DependencyManifest[] = [];
  let remainingBytes = options.maxBytes;
  for (const match of matches.slice(0, options.maxFiles)) {
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }
    const manifest = await readManifest(root, match.file, remainingBytes);
    manifests.push({ ...match, ...manifest });
    remainingBytes -= Buffer.byteLength(manifest.content);
    truncated ||= manifest.truncated;
  }
  return { manifests, truncated };
}

function manifestEcosystem(name: string): string | undefined {
  return (
    MANIFESTS.get(name) ??
    (/\.(csproj|fsproj|vbproj)$/.test(name) ? "dotnet" : undefined) ??
    (/\.gemspec$/.test(name) ? "ruby" : undefined) ??
    (/^requirements[-.][A-Za-z0-9_.-]+\.txt$/.test(name) ? "python" : undefined)
  );
}

function hasUnsupportedCharacters(value: string): boolean {
  return (
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

async function readManifest(root: string, file: string, maxBytes: number) {
  const path = resolve(root, file);
  const resolved = await realpath(path);
  const withinRoot = relative(root, resolved);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinRoot)
  ) {
    throw new Error("Manifest is outside the snapshot");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Manifest is not a regular file");
    const buffer = Buffer.alloc(Math.min(metadata.size, maxBytes));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const decoder = new StringDecoder("utf8");
    const content =
      decoder.write(buffer.subarray(0, bytesRead)) +
      (bytesRead === metadata.size ? decoder.end() : "");
    // Reject invalid UTF-8; the decoder may hold a partial trailing character at the byte cap.
    if (
      !Buffer.from(content).equals(
        buffer.subarray(0, Buffer.byteLength(content)),
      )
    ) {
      throw new Error("Manifest is not UTF-8 text");
    }
    return {
      content,
      startLine: 1,
      endLine:
        content === ""
          ? 0
          : content.split("\n").length - Number(content.endsWith("\n")),
      originalBytes: metadata.size,
      truncated: Buffer.byteLength(content) < metadata.size,
    };
  } finally {
    await handle.close();
  }
}
