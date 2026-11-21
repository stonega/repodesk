import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const tsc = resolve(root, "node_modules/typescript/bin/tsc");

const slices: Array<{ name: string; include: string[] }> = [
  {
    name: "src",
    include: [
      resolve(root, "src/**/*.ts"),
      resolve(root, "scripts/**/*.ts"),
      resolve(root, "deploy/browser/**/*.ts"),
    ],
  },
  {
    name: "web",
    include: [resolve(root, "web/**/*.ts"), resolve(root, "web/**/*.tsx")],
  },
  {
    name: "tests-unit",
    include: [
      resolve(root, "tests/*.ts"),
      resolve(root, "tests/fixtures/**/*.ts"),
      resolve(root, "tests/unit/**/*.ts"),
    ],
  },
  {
    name: "tests-integration",
    include: [resolve(root, "tests/integration/**/*.ts")],
  },
  {
    name: "tests-browser",
    include: [resolve(root, "tests/browser/**/*.ts")],
  },
];

const knownTestDirs = new Set(["fixtures", "unit", "integration", "browser"]);
const extraTestDirs = readdirSync(resolve(root, "tests"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory() && !knownTestDirs.has(entry.name))
  .map((entry) => resolve(root, "tests", entry.name, "**/*.ts"));
if (extraTestDirs.length > 0) {
  slices.push({ name: "tests-extra", include: extraTestDirs });
}

const tempDir = mkdtempSync(join(tmpdir(), "telo-typecheck-"));
let failed = false;

try {
  for (const slice of slices) {
    const configPath = join(tempDir, `tsconfig.${slice.name}.json`);
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          extends: resolve(root, "tsconfig.json"),
          compilerOptions: {
            typeRoots: [resolve(root, "node_modules/@types")],
            paths: {
              "@telo/plugin-sdk": [resolve(root, "sdk/plugin/index.ts")],
            },
          },
          include: slice.include,
        },
        null,
        2,
      ),
    );
    const result = spawnSync("node", [tsc, "--noEmit", "-p", configPath], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      failed = true;
      break;
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) process.exit(1);
