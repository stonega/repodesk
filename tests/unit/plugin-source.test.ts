import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { unpackGitHubZip } from "../../src/plugins/archive.ts";
import {
  GitHubPluginSource,
  parseRepositoryUrl,
} from "../../src/plugins/github-source.ts";
import { pluginRepository } from "../fixtures/plugin-packages.ts";

test("GitHub root URLs are canonicalized without accepting nested or credentialed input", () => {
  expect(parseRepositoryUrl("https://github.com/example/plugin.git")).toBe(
    "example/plugin",
  );
  for (const url of [
    "http://github.com/example/plugin",
    "https://github.com@evil.test/example/plugin",
    "https://github.com/example/plugin/tree/main",
    "https://github.com/example/plugin?token=x",
    "https://github.com/example/plugin/../other",
    "git@github.com:example/plugin",
  ])
    expect(() => parseRepositoryUrl(url)).toThrow("plugin_package_invalid");
});
test("highest compatible stable tag resolves to immutable bytes and identity", async () => {
  const repo = await pluginRepository();
  const latest = repo.add("0.2.0");
  repo.add("0.3.0-preview.1");
  const result = await new GitHubPluginSource(repo.transport).inspect(
    repo.manifest.repository,
    undefined,
    undefined,
    new AbortController().signal,
  );
  expect(result.source.commit).toBe(latest);
  expect(result.source.ref).toBe("v0.2.0");
  expect(result.source.repositoryId).toBe(777);
  expect(result.manifest.version).toBe("0.2.0");
});
test("source token stays on the fixed GitHub API and never follows redirects", async () => {
  const repo = await pluginRepository();
  repo.state.private = true;
  await new GitHubPluginSource(repo.transport).inspect(
    repo.manifest.repository,
    repo.commit,
    "fixture-private-token",
    new AbortController().signal,
  );
  expect(
    repo.calls
      .filter((c) => c.url.startsWith("https://api.github.com/"))
      .every((c) => c.authorization === "Bearer fixture-private-token"),
  ).toBe(true);
  expect(
    repo.calls.find((c) => c.url.startsWith("https://codeload.github.com/"))
      ?.authorization,
  ).toBeNull();
  repo.state.redirectOrigin = "https://private.internal";
  await expect(
    new GitHubPluginSource(repo.transport).inspect(
      repo.manifest.repository,
      repo.commit,
      "fixture-private-token",
      new AbortController().signal,
    ),
  ).rejects.toThrow("plugin_package_invalid");
});
test("moved tags, ownership changes and repository recreation invalidate a reviewed source", async () => {
  const repo = await pluginRepository();
  const reader = new GitHubPluginSource(repo.transport);
  const result = await reader.inspect(
    repo.manifest.repository,
    "v0.1.0",
    undefined,
    new AbortController().signal,
  );
  const next = repo.add("0.2.0");
  repo.tags.set("v0.1.0", next);
  await expect(
    reader.recheck(result.source, undefined, new AbortController().signal),
  ).rejects.toThrow("plugin_package_invalid");
  repo.tags.set("v0.1.0", repo.commit);
  repo.state.ownerId++;
  await expect(
    reader.recheck(result.source, undefined, new AbortController().signal),
  ).rejects.toThrow("plugin_package_invalid");
  repo.state.ownerId--;
  repo.state.id++;
  await expect(
    reader.recheck(result.source, undefined, new AbortController().signal),
  ).rejects.toThrow("plugin_package_invalid");
});
test("bounded ZIP extraction rejects traversal, multiple roots, links and expansion bombs", async () => {
  const repo = await pluginRepository();
  expect(unpackGitHubZip(repo.zip())["repodesk.plugin.json"]).toBeDefined();
  for (const files of [
    { "root/../outside": Buffer.from("bad") },
    { "/root/file": Buffer.from("bad") },
    { "root/a": Buffer.from("a"), "other/b": Buffer.from("b") },
    { "root/.gitmodules": Buffer.from("bad") },
    { "root/.env": Buffer.from("secret") },
  ] as Record<string, Buffer>[])
    expect(() => unpackGitHubZip(Buffer.from(zipSync(files)))).toThrow(
      "plugin_package_invalid",
    );
  const symlink = Buffer.from(
    zipSync({ "root/link": Buffer.from("/etc/passwd") }),
  );
  const central = symlink.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symlink.writeUInt32LE(0xa1ff0000, central + 38);
  expect(() => unpackGitHubZip(symlink)).toThrow("plugin_package_invalid");
  const bomb = Buffer.from(repo.zip());
  const entry = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(33 * 1024 * 1024, entry + 24);
  expect(() => unpackGitHubZip(bomb)).toThrow("plugin_package_invalid");
  expect(() => unpackGitHubZip(repo.zip().subarray(0, 30))).toThrow(
    "plugin_package_invalid",
  );
});

test("actual inflation cannot exceed forged ZIP size declarations", () => {
  const archive = Buffer.from(
    zipSync({ "root/bomb.txt": new Uint8Array(4 * 1024 * 1024) }),
  );
  const end = archive.length - 22;
  const central = archive.readUInt32LE(end + 16);
  const local = archive.readUInt32LE(central + 42);
  archive.writeUInt32LE(1, central + 24);
  archive.writeUInt32LE(1, local + 22);
  expect(() => unpackGitHubZip(archive)).toThrow("plugin_package_invalid");
});
