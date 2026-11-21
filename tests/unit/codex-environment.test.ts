import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectTools,
  ensurePersistentEnvDirs,
  environmentVolumeKey,
  envVolumePattern,
  parseEnvironmentVolume,
  persistentEnv,
  preparePersistentEnvironment,
  workspaceEnvPrefix,
} from "../../src/coding/local/environment.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test("environment volume keys are tenant-scoped, deterministic and parseable", () => {
  const wsA = randomUUID();
  const wsB = randomUUID();
  const volA1 = environmentVolumeKey(wsA, 42);
  const volA2 = environmentVolumeKey(wsA, 99);
  const volB1 = environmentVolumeKey(wsB, 42);

  expect(volA1).toMatch(envVolumePattern);
  expect(volA1).not.toBe(volA2);
  expect(volA1).not.toBe(volB1);
  expect(volA1.startsWith(workspaceEnvPrefix(wsA))).toBe(true);
  expect(volB1.startsWith(workspaceEnvPrefix(wsA))).toBe(false);

  expect(parseEnvironmentVolume(wsA, volA1)).toBe(42);
  expect(parseEnvironmentVolume(wsA, volA2)).toBe(99);
  expect(parseEnvironmentVolume(wsA, volB1)).toBeUndefined();
  expect(
    parseEnvironmentVolume(wsA, `${workspaceEnvPrefix(wsA)}0`),
  ).toBeUndefined();
  expect(
    parseEnvironmentVolume(wsA, `${workspaceEnvPrefix(wsA)}../1`),
  ).toBeUndefined();
});

test("persistentEnv configures standard cache and toolchain paths without touching HOME", async () => {
  const envRoot = await tempDir("repodesk-env-root-");
  await ensurePersistentEnvDirs(envRoot);

  const env = persistentEnv(envRoot, {
    PATH: "/usr/bin:/bin",
    HOME: "/task/home",
  });

  expect(env.HOME).toBe("/task/home");
  expect(env.PATH?.startsWith(`${join(envRoot, "mise", "shims")}:`)).toBe(true);
  expect(env.MISE_DATA_DIR).toBe(join(envRoot, "mise"));
  expect(env.MISE_CONFIG_DIR).toBe(join(envRoot, "mise-config"));
  expect(env.MISE_TRUSTED_CONFIG_PATHS).toBe(envRoot);
  expect(env.BUN_INSTALL_CACHE_DIR).toBe(join(envRoot, "cache", "bun"));
  expect(env.PNPM_STORE_DIR).toBe(join(envRoot, "cache", "pnpm"));
  expect(env.NPM_CONFIG_CACHE).toBe(join(envRoot, "cache", "npm"));
  expect(env.UV_CACHE_DIR).toBe(join(envRoot, "cache", "uv"));
  expect(env.UV_PYTHON_INSTALL_DIR).toBe(join(envRoot, "uv-python"));
  expect(env.CARGO_HOME).toBe(join(envRoot, "cargo"));
  expect(env.GOMODCACHE).toBe(join(envRoot, "cache", "gomod"));
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(envRoot, "playwright"));
});

test("detectProjectTools extracts allowlisted versions and ignores hooks or unsafe specs", async () => {
  const repo = await tempDir("repodesk-detect-repo-");
  await writeFile(
    join(repo, ".tool-versions"),
    "# comment\nnodejs 22.14.0\nunknown-tool 1.0.0\n",
  );
  await writeFile(
    join(repo, ".mise.toml"),
    [
      "[hooks]",
      'enter = "echo pwned"',
      "[tools]",
      'python = "3.12.7"',
      'node = "20.0.0"', // Ignored because .tool-versions already set node.
      'go = "$(whoami)"', // Unsafe characters rejected.
      'ruby = "3.3.5"',
    ].join("\n"),
  );
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ packageManager: "pnpm@9.15.0+sha512.abc123" }),
  );
  await writeFile(
    join(repo, "go.mod"),
    "module example.com/app\n\ngo 1.23.4\n",
  );
  await writeFile(
    join(repo, "rust-toolchain.toml"),
    '[toolchain]\nchannel = "1.84.0"\n',
  );
  await writeFile(join(repo, "pyproject.toml"), "[project]\nname = 'app'\n");

  const tools = await detectProjectTools(repo);
  expect(tools).toEqual([
    "node@22.14.0",
    "python@3.12.7",
    "ruby@3.3.5",
    "rust@1.84.0",
    "pnpm@9.15.0",
    "go@1.23.4",
  ]);
});

test("detectProjectTools falls back to lockfile heuristics when explicit versions are absent", async () => {
  const repo = await tempDir("repodesk-detect-fallback-");
  await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(repo, "requirements.txt"), "pytest\n");
  await writeFile(join(repo, "Cargo.toml"), '[package]\nname = "demo"\n');
  await writeFile(join(repo, ".nvmrc"), "v22.12.0\n");

  expect(await detectProjectTools(repo)).toEqual([
    "node@22.12.0",
    "pnpm",
    "python@3.12",
    "rust@stable",
  ]);
});

test("preparePersistentEnvironment installs detected tools under a lock and tolerates partial failures", async () => {
  const repo = await tempDir("repodesk-prep-repo-");
  const envRoot = await tempDir("repodesk-prep-env-");
  const binDir = await tempDir("repodesk-prep-bin-");
  const logFile = join(envRoot, "mise.log");

  await writeFile(join(repo, ".python-version"), "3.12.5\n");
  await writeFile(
    join(repo, "go.mod"),
    "module example.com/app\n\ngo 1.23.1\n",
  );

  const fakeMise = join(binDir, "mise");
  await writeFile(
    fakeMise,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2026.10.4"
  exit 0
fi
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
if [ "$3" = "go@1.23.1" ]; then
  exit 1
fi
exit 0
`,
  );
  await chmod(fakeMise, 0o755);

  const env = persistentEnv(envRoot, {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: "/task/home",
  });
  const report = await preparePersistentEnvironment(repo, envRoot, env);
  expect(report).toEqual({
    tools: ["python@3.12.5", "go@1.23.1"],
    installed: ["python@3.12.5"],
    failed: ["go@1.23.1"],
    miseAvailable: true,
  });
  expect((await readFile(logFile, "utf8")).trim().split("\n")).toEqual([
    "use --global python@3.12.5",
    "use --global go@1.23.1",
  ]);
});

test("preparePersistentEnvironment succeeds gracefully when mise is unavailable", async () => {
  const repo = await tempDir("repodesk-nomise-repo-");
  const envRoot = await tempDir("repodesk-nomise-env-");
  await writeFile(join(repo, ".python-version"), "3.12.5\n");

  const env = persistentEnv(envRoot, {
    PATH: "/nonexistent",
    HOME: "/task/home",
  });
  const report = await preparePersistentEnvironment(repo, envRoot, env);
  expect(report).toEqual({
    tools: ["python@3.12.5"],
    installed: [],
    failed: [],
    miseAvailable: false,
  });
});
