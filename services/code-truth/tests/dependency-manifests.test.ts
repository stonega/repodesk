import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { readDependencyManifests } from "../src/upstream/codegraph/dependency-manifests.ts";

let directory: string;
let snapshot: string;
const defaults = { maxFiles: 20, maxBytes: 40_000 };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "code-truth-manifests-"));
  snapshot = join(directory, "snapshot");
  await mkdir(snapshot);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(file: string, content = "example\n") {
  const path = join(snapshot, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("dependency manifest evidence", () => {
  test("returns root and nested workspace contents with relative paths and lines", async () => {
    await fixture("package.json", '{\n  "workspaces": ["packages/*"]\n}\n');
    await fixture("Cargo.toml", '[workspace]\nmembers = ["crates/node"]\n');
    await fixture(
      "packages/web/package.json",
      '{"dependencies":{"react":"^19"}}',
    );
    await fixture("crates/node/Cargo.toml", '[dependencies]\nserde = "1"\n');
    const result = await readDependencyManifests(snapshot, defaults);
    expect(result.truncated).toBeFalse();
    expect(result.manifests.map((item) => item.file)).toEqual([
      "Cargo.toml",
      "package.json",
      "crates/node/Cargo.toml",
      "packages/web/package.json",
    ]);
    expect(result.manifests[1]).toEqual({
      file: "package.json",
      ecosystem: "javascript",
      content: '{\n  "workspaces": ["packages/*"]\n}\n',
      startLine: 1,
      endLine: 3,
      originalBytes: 35,
      truncated: false,
    });
  });

  test("recognizes common language manifests and preserves unevaluated scripts", async () => {
    const files = [
      "pyproject.toml",
      "requirements-dev.txt",
      "go.mod",
      "pom.xml",
      "build.gradle.kts",
      "Directory.Packages.props",
      "App.csproj",
      "composer.json",
      "Gemfile",
      "app.gemspec",
      "Package.swift",
      "pubspec.yaml",
      "mix.exs",
      "gradle/libs.versions.toml",
    ];
    for (const file of files) await fixture(file);
    const script = 'raise RuntimeError("must not execute")\n';
    await fixture("setup.py", script);
    const result = await readDependencyManifests(snapshot, defaults);
    expect(result.manifests.map((item) => item.file).sort()).toEqual(
      [...files, "setup.py"].sort(),
    );
    expect(
      result.manifests.find((item) => item.file === "setup.py")?.content,
    ).toBe(script);
    expect(result.truncated).toBeFalse();
  });

  test("ignores source, lockfiles, installed dependencies, and generated directories", async () => {
    for (const file of [
      "src/index.ts",
      "Cargo.lock",
      "package-lock.json",
      "bun.lock",
      "poetry.lock",
      "node_modules/example/package.json",
      "vendor/example/Cargo.toml",
      "target/package.json",
      ".git/package.json",
      ".codegraph/package.json",
      ".venv/pyproject.toml",
      "dist/package.json",
    ])
      await fixture(file);
    expect(await readDependencyManifests(snapshot, defaults)).toEqual({
      manifests: [],
      truncated: false,
    });
  });

  test("scopes discovery to a subtree while keeping paths relative to the repository", async () => {
    await fixture("package.json");
    await fixture("packages/web/package.json");
    const result = await readDependencyManifests(snapshot, {
      ...defaults,
      directory: "packages/web",
    });
    expect(result.manifests.map((item) => item.file)).toEqual([
      "packages/web/package.json",
    ]);
    expect(result.truncated).toBeFalse();
  });

  test("reports file limits only when additional manifests exist", async () => {
    await fixture("package.json");
    expect(
      (await readDependencyManifests(snapshot, { ...defaults, maxFiles: 1 }))
        .truncated,
    ).toBeFalse();
    await fixture("packages/web/package.json");
    const result = await readDependencyManifests(snapshot, {
      ...defaults,
      maxFiles: 1,
    });
    expect(result.manifests.map((item) => item.file)).toEqual(["package.json"]);
    expect(result.truncated).toBeTrue();
  });

  test("enforces a shared content byte budget and reports partial lines", async () => {
    await fixture("Cargo.toml", "123\n567890");
    await fixture("package.json", "abcdefghij");
    const result = await readDependencyManifests(snapshot, {
      ...defaults,
      maxBytes: 14,
    });
    expect(result.manifests.map((item) => item.content)).toEqual([
      "123\n567890",
      "abcd",
    ]);
    expect(result.manifests.map((item) => item.truncated)).toEqual([
      false,
      true,
    ]);
    expect(result.manifests[0]?.endLine).toBe(2);
    expect(result.manifests[1]?.originalBytes).toBe(10);
    expect(result.truncated).toBeTrue();
    const exact = await readDependencyManifests(snapshot, {
      ...defaults,
      maxBytes: 20,
    });
    expect(exact.truncated).toBeFalse();
    const omitted = await readDependencyManifests(snapshot, {
      ...defaults,
      maxBytes: 10,
    });
    expect(omitted.manifests).toHaveLength(1);
    expect(omitted.truncated).toBeTrue();
  });

  test("never splits a UTF-8 character or adds truncation markers to file content", async () => {
    await fixture("package.json", "a😀漢字");
    const result = await readDependencyManifests(snapshot, {
      ...defaults,
      maxBytes: 7,
    });
    expect(result.manifests[0]?.content).toBe("a😀");
    expect(result.manifests[0]?.originalBytes).toBe(11);
    expect(result.truncated).toBeTrue();
  });

  test("handles empty repositories and empty manifests", async () => {
    expect(await readDependencyManifests(snapshot, defaults)).toEqual({
      manifests: [],
      truncated: false,
    });
    await fixture("package.json", "");
    const result = await readDependencyManifests(snapshot, defaults);
    expect(result.manifests[0]).toMatchObject({
      content: "",
      endLine: 0,
      originalBytes: 0,
      truncated: false,
    });
    expect(result.truncated).toBeFalse();
  });

  test.skipIf(sep !== "/")(
    "reports unsupported path characters without retargeting a file",
    async () => {
      await fixture("package\\name/package.json", "actual manifest");
      await fixture("package/name/package.json", "other manifest");
      await fixture("bad\nname/package.json", "unsupported manifest");
      const result = await readDependencyManifests(snapshot, defaults);
      expect(result.manifests).toHaveLength(1);
      expect(result.manifests[0]).toMatchObject({
        file: "package/name/package.json",
        content: "other manifest",
      });
      expect(result.truncated).toBeTrue();
    },
  );

  test("skips symlinked manifests and directories and denies explicitly selecting them", async () => {
    await writeFile(join(directory, "package.json"), "outside-snapshot-secret");
    await symlink(
      join(directory, "package.json"),
      join(snapshot, "package.json"),
    );
    await symlink(directory, join(snapshot, "linked"));
    expect(await readDependencyManifests(snapshot, defaults)).toEqual({
      manifests: [],
      truncated: false,
    });
    await expect(
      readDependencyManifests(snapshot, { ...defaults, directory: "linked" }),
    ).rejects.toThrow();
    await expect(
      readDependencyManifests(snapshot, {
        ...defaults,
        directory: "linked/snapshot",
      }),
    ).rejects.toThrow();
  });

  test("rejects traversal, host paths, excluded subtrees, and invalid limits", async () => {
    for (const value of [
      "../",
      "/tmp",
      "C:/tmp",
      "..\\secret",
      "a/../../b",
      "a\0b",
      "a\nb",
      "node_modules/pkg",
    ]) {
      await expect(
        readDependencyManifests(snapshot, { ...defaults, directory: value }),
      ).rejects.toThrow();
    }
    for (const limits of [
      { maxFiles: 0 },
      { maxFiles: 101 },
      { maxFiles: 1.5 },
      { maxBytes: 0 },
      { maxBytes: 80_001 },
    ]) {
      await expect(
        readDependencyManifests(snapshot, { ...defaults, ...limits }),
      ).rejects.toThrow();
    }
  });

  test("marks discovery incomplete when the depth bound omits a nested workspace", async () => {
    await fixture(`${"nested/".repeat(22)}package.json`);
    const result = await readDependencyManifests(snapshot, defaults);
    expect(result).toEqual({ manifests: [], truncated: true });
  });

  test("bounds discovery in a wide repository and reports incomplete results", async () => {
    await Promise.all(
      Array.from({ length: 20_001 }, (_, index) =>
        mkdir(join(snapshot, `directory-${index}`)),
      ),
    );
    expect(await readDependencyManifests(snapshot, defaults)).toEqual({
      manifests: [],
      truncated: true,
    });
  });
});
