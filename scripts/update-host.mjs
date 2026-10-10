import { spawn, spawnSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withStorageLock } from "./cleanup-host.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validateRequest(request, repository) {
  if (
    !request ||
    !/^[\w-]+\/[\w.-]+$/.test(repository) ||
    request.repository !== repository ||
    !uuid.test(request.requestId) ||
    !Number.isSafeInteger(request.releaseId) ||
    request.releaseId < 1 ||
    !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(request.tag) ||
    !/^[a-f0-9]{40}$/.test(request.commit) ||
    !/^[a-f0-9]{64}$/.test(request.fingerprint)
  )
    throw Error("invalid_update_request");
}
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.pending`;
  const file = await open(temporary, "wx", 0o644);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function github(repository, path, token, transport) {
  const response = await transport(
    `https://api.github.com/repos/${repository}${path}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "RepoDesk-host-updater",
        "x-github-api-version": "2026-03-10",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!response.ok) throw Error("verification_failed");
  return response.json();
}
export async function verifySelection(
  request,
  repository,
  token,
  transport = fetch,
) {
  validateRequest(request, repository);
  const release = await github(
    repository,
    `/releases/${request.releaseId}`,
    token,
    transport,
  );
  if (
    release.id !== request.releaseId ||
    release.tag_name !== request.tag ||
    release.draft !== false ||
    release.prerelease !== false
  )
    throw Error("release_changed");
  const { sha } = await github(
    repository,
    `/commits/${encodeURIComponent(request.tag)}`,
    token,
    transport,
  );
  const selected = {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name,
    body: release.body,
    published_at: release.published_at,
    draft: release.draft,
    prerelease: release.prerelease,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([selected, sha]))
    .digest("hex");
  if (sha !== request.commit || fingerprint !== request.fingerprint)
    throw Error("release_changed");
}
export async function requireVerifiedCommit(request, token, transport = fetch) {
  const response = await github(
    request.repository,
    `/actions/workflows/check.yml/runs?head_sha=${request.commit}&status=completed&per_page=100`,
    token,
    transport,
  );
  if (
    !Array.isArray(response.workflow_runs) ||
    !response.workflow_runs.some(
      (run) =>
        run.head_sha === request.commit &&
        run.conclusion === "success" &&
        run.event === "push",
    )
  )
    throw Error("verification_failed");
}
function commandRunner(log, token) {
  return (command, args, capture = false) =>
    new Promise((accept, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
      // Private source read access stays in process environment, never CLI arguments.
      if (token && command === "git")
        Object.assign(env, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        });
      const child = spawn(command, args, {
        env,
        stdio: ["ignore", capture ? "pipe" : log.fd, log.fd],
        timeout: 45 * 60000,
      });
      let output = "";
      if (capture)
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.length > 4096) child.kill();
        });
      child.on("error", () => reject(Error("update_failed")));
      child.on("exit", (code) =>
        code === 0 ? accept(output.trim()) : reject(Error("update_failed")),
      );
    });
}
async function requireUpdateSpace(root, readSpace) {
  const disk = await readSpace(root);
  if (disk.bavail * disk.bsize < 1024 ** 3)
    throw Error("insufficient_disk_space");
}

/** Build pinned release images locally, then reuse the protected host cutover. */
export async function installRelease(
  request,
  config,
  run,
  transport = fetch,
  readSpace = statfs,
) {
  await verifySelection(request, config.repository, config.token, transport);
  await requireVerifiedCommit(request, config.token, transport);
  await requireUpdateSpace(config.root, readSpace);
  const source = join(config.root, "updates", "sources", request.requestId);
  const releaseId = `${Date.now()}-${randomInt(1, 100000000)}`;
  const bundle = join(config.root, "releases", releaseId);
  await mkdir(source, { recursive: true, mode: 0o700 });
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  try {
    await run("git", ["init", source]);
    await run("git", [
      "-C",
      source,
      "remote",
      "add",
      "origin",
      `https://github.com/${config.repository}.git`,
    ]);
    await run("git", [
      "-C",
      source,
      "fetch",
      "--depth=1",
      "origin",
      request.commit,
    ]);
    await run("git", ["-C", source, "checkout", "--detach", "FETCH_HEAD"]);
    if (
      (await run("git", ["-C", source, "rev-parse", "HEAD"], true)) !==
      request.commit
    )
      throw Error("release_changed");
    const pkg = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    if (pkg.version !== request.tag.replace(/^v/, ""))
      throw Error("release_changed");
    // A daemon that imports the shared maintenance lock needs its companion
    // module. Reject incompatible source before building or stopping writers.
    await readFile(join(source, "scripts/cleanup-host.mjs"));
    const image = `repodesk:release-${request.commit}`;
    const supervisor = `repodesk-codex-supervisor:release-${request.commit}`;
    const job = `repodesk-codex-job:release-${request.commit}`;
    for (const [target, tag] of [
      ["app", image],
      ["codex-job", job],
      ["codex-supervisor", supervisor],
    ]) {
      await requireUpdateSpace(config.root, readSpace);
      await run("docker", [
        "build",
        "--platform",
        "linux/amd64",
        "--target",
        target,
        "-t",
        tag,
        source,
      ]);
    }
    await run("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      image,
      "dist/runtime-contract.js",
    ]);
    // These images are already on the deployment daemon. Pin their IDs rather
    // than duplicating them in an archive and importing them on the same host.
    for (const [name, value] of [
      ["image-tag", image],
      ["codex-supervisor-tag", supervisor],
      ["codex-job-tag", job],
    ]) {
      await writeFile(join(bundle, name), value, { mode: 0o600 });
      const id = await run(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", value],
        true,
      );
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw Error("update_failed");
      await writeFile(join(bundle, name.replace(/-tag$/, "-id")), id, {
        mode: 0o600,
      });
    }
    for (const [from, to] of [
      ["compose.yaml", "compose.yaml"],
      ["scripts/deploy-vps.sh", "deploy-vps.sh"],
      ["deploy/codex/docker-compose.yaml", "codex-compose.yaml"],
      ["deploy/codex/release-config.mjs", "codex-release-config.mjs"],
      ["deploy/codex/wait-checkpoint.mjs", "codex-wait-checkpoint.mjs"],
    ])
      await copyFile(join(source, from), join(bundle, to));
    // Recheck external metadata immediately before the first possible cutover.
    await verifySelection(request, config.repository, config.token, transport);
    await requireUpdateSpace(config.root, readSpace);
    await run("bash", [
      join(bundle, "deploy-vps.sh"),
      config.root,
      releaseId,
      config.project,
      "--local-images",
    ]);
    // Install the next daemon atomically; the service restarts after recording success.
    await mkdir(join(config.root, "updater"), { recursive: true, mode: 0o700 });
    await copyFile(
      join(source, "scripts/cleanup-host.mjs"),
      join(config.root, "updater/cleanup-host.mjs.pending"),
    );
    await rename(
      join(config.root, "updater/cleanup-host.mjs.pending"),
      join(config.root, "updater/cleanup-host.mjs"),
    );
    await copyFile(
      join(source, "scripts/update-host.mjs"),
      join(config.root, "updater/update-host.mjs.pending"),
    );
    await rename(
      join(config.root, "updater/update-host.mjs.pending"),
      join(config.root, "updater/update-host.mjs"),
    );
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}
export async function processRequest(
  request,
  config,
  execute = installRelease,
) {
  validateRequest(request, config.repository);
  const path = join(
    config.root,
    "updates",
    "results",
    `${request.requestId}.json`,
  );
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (["succeeded", "failed", "unknown"].includes(previous.state)) return;
    // A restarted agent must not replay an interrupted database cutover.
    if (previous.state === "running") {
      await atomicJson(path, {
        requestId: request.requestId,
        fingerprint: request.fingerprint,
        state: "unknown",
        error: "update_interrupted",
      });
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicJson(path, {
    requestId: request.requestId,
    fingerprint: request.fingerprint,
    state: "running",
  });
  const log = await open(
    join(config.root, "updates", "logs", `${request.requestId}.log`),
    "a",
    0o600,
  );
  try {
    await log.write(
      `Starting verified update ${request.repository}@${request.tag} (${request.commit}).\n`,
    );
    const acquired = await withStorageLock(
      config.root,
      () => execute(request, config, commandRunner(log, config.token)),
      true,
    );
    if (!acquired) throw Error("storage_lock_busy");
    await atomicJson(path, {
      requestId: request.requestId,
      fingerprint: request.fingerprint,
      state: "succeeded",
    });
    return true;
  } catch (error) {
    const code =
      error.code === "ENOSPC"
        ? "insufficient_disk_space"
        : [
              "release_changed",
              "verification_failed",
              "insufficient_disk_space",
            ].includes(error.message)
          ? error.message
          : "update_failed";
    await log.write(
      `Update failed: ${code}. Inspect the release, Verify result and preceding build/cutover output.\n`,
    );
    await atomicJson(path, {
      requestId: request.requestId,
      fingerprint: request.fingerprint,
      state: "failed",
      error: code,
    });
  } finally {
    await log.close();
  }
}
async function main() {
  const [rootArg, project, repository = "stonega/repodesk"] =
    process.argv.slice(2);
  const root = resolve(rootArg ?? "");
  if (
    !rootArg ||
    !/^\/[\w/-]+$/.test(root) ||
    root === "/" ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(project ?? "") ||
    !/^[\w-]+\/[\w.-]+$/.test(repository)
  )
    throw Error(
      "Usage: node update-host.mjs DEPLOY_ROOT COMPOSE_PROJECT [OWNER/REPO]",
    );
  if (!process.argv.includes("--locked")) {
    const result = spawnSync(
      "flock",
      [
        "-n",
        join(root, ".updater.lock"),
        process.execPath,
        import.meta.filename,
        root,
        project,
        repository,
        "--locked",
      ],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  }
  await readFile(join(root, ".env"));
  const directory = join(root, "updates");
  for (const child of ["requests", "results", "logs", "sources"])
    await mkdir(join(directory, child), {
      recursive: true,
      mode: child === "results" ? 0o755 : 0o700,
    });
  const config = {
    root,
    project,
    repository,
    token: process.env.UPDATES_GITHUB_TOKEN_FILE
      ? (await readFile(process.env.UPDATES_GITHUB_TOKEN_FILE, "utf8")).trim()
      : process.env.UPDATES_GITHUB_TOKEN,
  };
  const heartbeat = () =>
    atomicJson(join(directory, "heartbeat.json"), {
      repository,
      at: new Date().toISOString(),
    });
  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => process.exit(1));
  }, 5000);
  timer.unref();
  for (;;) {
    for (const file of (await readdir(join(directory, "requests")))
      .filter(
        (name) =>
          uuid.test(name.replace(/\.json$/, "")) && name.endsWith(".json"),
      )
      .sort()) {
      const request = JSON.parse(
        await readFile(join(directory, "requests", file), "utf8"),
      );
      if (`${request.requestId}.json` !== file)
        throw Error("invalid_update_request");
      if (await processRequest(request, config)) process.exit(0);
    }
    await new Promise((accept) => setTimeout(accept, 3000));
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    process.stderr.write(
      "Host updater stopped. Check its configuration and protected update logs.\n",
    );
    process.exitCode = 1;
  });
}
