import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../scripts/deploy-vps.sh");
const imageId = `sha256:${"a".repeat(64)}`;
const imageTag = `repodesk:release-${"b".repeat(40)}`;
const importedImageId = `sha256:${"c".repeat(64)}`;

// No daemon, SSH connection, production database or outbound calls are involved.
const docker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
case "$*" in
  "info "*) echo "$DEPLOY_TEST_ARCH" ;;
  "image inspect "*)
    [[ "$*" = "image inspect --format {{.Id}} $DEPLOY_TEST_TAG" ]] || exit 43
    echo "$DEPLOY_TEST_IMAGE" ;;
  *"--entrypoint node "*) [[ "$DEPLOY_TEST_FAILURE" != secret ]] || exit 42 ;;
  *"pg_dump "*)
    [[ "$DEPLOY_TEST_FAILURE" != backup ]] || exit 42
    echo fake-custom-dump ;;
  *"pg_restore "*) cat > /dev/null ;;
  *"run --rm "*) [[ "$DEPLOY_TEST_FAILURE" != migration ]] || exit 42 ;;
  *"exec -T app "*)
    count=0
    [[ ! -f "$DEPLOY_TEST_READY_COUNT" ]] || count=$(cat "$DEPLOY_TEST_READY_COUNT")
    count=$((count + 1))
    printf '%s\\n' "$count" > "$DEPLOY_TEST_READY_COUNT"
    if [[ "$DEPLOY_TEST_FAILURE" = readiness ]] ||
       [[ "$DEPLOY_TEST_FAILURE" = delayed-readiness && "$count" -lt 3 ]]; then
      echo 'Readiness HTTP 503' >&2
      exit 42
    fi ;;
esac
`;

function deploy(failure = "", arch = "x86_64", duplicate = false) {
  const root = mkdtempSync(join(tmpdir(), "repodesk-deploy-test-"));
  try {
    const release = join(root, "releases/123-1");
    const bin = join(root, "bin");
    const log = join(root, "docker.log");
    mkdirSync(release, { recursive: true });
    mkdirSync(bin);
    if (failure !== "configuration")
      writeFileSync(join(root, ".env"), "POSTGRES_PASSWORD=fixture\n");
    writeFileSync(join(release, "compose.yaml"), "services: {}\n");
    writeFileSync(join(release, "image-id"), `${imageId}\n`);
    writeFileSync(join(release, "image-tag"), `${imageTag}\n`);
    writeFileSync(
      join(release, "image-sha256"),
      `${createHash("sha256").update("fixture").digest("hex")}\n`,
    );
    writeFileSync(
      join(release, "image.tar.gz"),
      failure === "archive" ? "damaged" : "fixture",
    );
    writeFileSync(join(bin, "docker"), docker, { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(log, "");
    writeFileSync(join(root, ".current-release"), "previous\n");
    if (duplicate) {
      mkdirSync(join(root, "backups"));
      writeFileSync(join(root, "backups/pre-release-123-1.dump"), "previous");
    }
    const result = Bun.spawnSync(["bash", script, root, "123-1", "fixture"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_TEST_LOG: log,
        DEPLOY_TEST_IMAGE: importedImageId,
        DEPLOY_TEST_TAG: imageTag,
        DEPLOY_TEST_FAILURE: failure,
        DEPLOY_TEST_ARCH: arch,
        DEPLOY_TEST_READY_COUNT: join(root, "readiness-count"),
      },
    });
    return {
      exitCode: result.exitCode,
      calls: readFileSync(log, "utf8"),
      current: readFileSync(join(root, ".current-release"), "utf8"),
      stderr: result.stderr.toString(),
      releaseEnvironment:
        result.exitCode === 0
          ? readFileSync(join(release, "release.env"), "utf8")
          : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("VPS release cutover", () => {
  test("pins the imported daemon's ID when the runner's ID is different", () => {
    const result = deploy();
    expect(result.exitCode).toBe(0);
    expect(result.releaseEnvironment).toBe(`APP_IMAGE=${importedImageId}\n`);
    expect(result.calls).toContain(
      `image inspect --format {{.Id}} ${imageTag}`,
    );
    expect(result.calls).not.toContain(imageId);
  });

  test("waits for delayed readiness before promoting without stopping healthy writers", () => {
    const result = deploy("delayed-readiness");
    expect(result.exitCode).toBe(0);
    expect(result.current).toBe("123-1\n");
    expect(result.calls.match(/exec -T app /g)?.length).toBe(3);
    expect(result.calls.match(/stop app worker/g)?.length).toBe(1);
    expect(result.stderr).toContain("Readiness HTTP 503");
    expect(result.stderr).toContain("Waiting for application readiness");
  });

  test("rejects a damaged archive before importing or stopping writers", () => {
    const result = deploy("archive");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Image archive checksum mismatch");
    expect(result.calls).toBe("");
    expect(result.current).toBe("previous\n");
  });

  test("missing runtime configuration reports the cause before Docker is called", () => {
    const result = deploy("configuration");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Missing runtime configuration");
    expect(result.calls).toBe("");
  });

  test("backs up stopped writers, migrates, checks readiness, then promotes", () => {
    const result = deploy();
    expect(result.exitCode).toBe(0);
    expect(result.current).toBe("123-1\n");
    const stop = result.calls.indexOf("stop app worker");
    const backup = result.calls.indexOf("pg_dump");
    const validate = result.calls.indexOf("pg_restore");
    const migration = result.calls.indexOf(
      "run --rm --no-deps --pull never -T migrate\n",
    );
    const start = result.calls.indexOf("up -d --no-deps --no-build");
    const readiness = result.calls.indexOf("exec -T app");
    expect(stop).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(stop);
    expect(validate).toBeGreaterThan(backup);
    expect(migration).toBeGreaterThan(validate);
    expect(start).toBeGreaterThan(migration);
    expect(readiness).toBeGreaterThan(start);
  });

  for (const failure of ["backup", "migration", "readiness"]) {
    test(`${failure} failure stops writers and preserves the prior release marker`, () => {
      const result = deploy(failure);
      expect(result.exitCode).toBe(42);
      expect(result.current).toBe("previous\n");
      expect(result.calls.trim().endsWith("stop app worker")).toBe(true);
      if (failure !== "readiness") {
        expect(result.calls).not.toContain("up -d --no-deps --no-build");
      }
      if (failure === "backup")
        expect(result.calls).not.toContain(
          "run --rm --no-deps --pull never -T migrate\n",
        );
      if (failure === "readiness") {
        expect(result.calls.match(/exec -T app /g)?.length).toBe(24);
        expect(result.stderr).toContain("Readiness HTTP 503");
        expect(result.stderr).toContain(
          "did not succeed within the startup window",
        );
      }
    });
  }

  test("rejects incompatible hosts before stopping writers", () => {
    const result = deploy("", "aarch64");
    expect(result.exitCode).not.toBe(0);
    expect(result.calls).not.toContain("stop app worker");
    expect(result.current).toBe("previous\n");
  });

  test("an unreadable runtime secret fails before stopping writers", () => {
    const result = deploy("secret");
    expect(result.exitCode).toBe(42);
    expect(result.calls).not.toContain("stop app worker");
    expect(result.current).toBe("previous\n");
  });

  test("a duplicate bundle cannot overwrite its backup or stop writers", () => {
    const result = deploy("", "x86_64", true);
    expect(result.exitCode).not.toBe(0);
    expect(result.calls).toBe("");
    expect(result.current).toBe("previous\n");
  });
});
