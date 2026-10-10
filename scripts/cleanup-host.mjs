import { execFile, spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const releaseTag =
  /^(repodesk|repodesk-codex-job|repodesk-codex-supervisor):release-([a-f0-9]{40})$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const imageFormat =
  '{"id":{{json .Id}},"created":{{json .Created}},"tags":{{json .RepoTags}}}';
const lines = (value) => value.trim().split("\n").filter(Boolean);

// flock locks the inherited open file description. The parent retains the lock
// until it closes its own descriptor, including while awaiting async work.
async function withFileLock(path, action, wait = false) {
  const file = await open(path, "a", 0o600);
  try {
    const status = await new Promise((accept, reject) => {
      const child = spawn("flock", [...(wait ? ["-w", "300"] : ["-n"]), "3"], {
        stdio: ["ignore", "ignore", "ignore", file.fd],
      });
      child.once("error", reject);
      child.once("exit", accept);
    });
    if (status === 1) return false;
    if (status !== 0) throw Error("storage_lock_failed");
    await action();
    return true;
  } finally {
    await file.close();
  }
}

export function withStorageLock(root, action, wait = false) {
  return withFileLock(join(root, ".storage.lock"), action, wait);
}

/** Only release tags are eligible; unrelated aliases and all container IDs stay. */
export function planReleaseCleanup(
  images,
  currentTags,
  containerIds,
  now = Date.now(),
) {
  if (!currentTags.length || currentTags.some((tag) => !releaseTag.test(tag)))
    throw Error("current_release_invalid");
  const groups = new Map();
  for (const image of images) {
    if (
      !imageId.test(image.id) ||
      !Number.isFinite(Date.parse(image.created)) ||
      !Array.isArray(image.tags)
    )
      throw Error("image_metadata_invalid");
    for (const tag of image.tags) {
      const match = releaseTag.exec(tag);
      if (!match) continue;
      const group = groups.get(match[2]) ?? {
        commit: match[2],
        repositories: new Set(),
        created: 0,
      };
      group.repositories.add(match[1]);
      group.created = Math.max(group.created, Date.parse(image.created));
      groups.set(match[2], group);
    }
  }
  const currentCommits = new Set(
    currentTags.map((tag) => releaseTag.exec(tag)[2]),
  );
  if (currentCommits.size !== 1) throw Error("current_release_invalid");
  // Keep two complete rollback sets in addition to the current release. Failed
  // partial builds cannot displace a complete app/job/supervisor set.
  const rollbacks = [...groups.values()]
    .filter(
      (group) =>
        !currentCommits.has(group.commit) && group.repositories.size === 3,
    )
    .sort((a, b) => b.created - a.created || a.commit.localeCompare(b.commit))
    .slice(0, 2);
  const retained = new Set([
    ...currentCommits,
    ...rollbacks.map((group) => group.commit),
  ]);
  const protectedIds = new Set(containerIds);
  for (const tag of currentTags) {
    const image = images.find((image) => image.tags.includes(tag));
    if (!image) throw Error("current_release_image_missing");
    protectedIds.add(image.id);
  }
  for (const image of images)
    if (image.tags.some((tag) => retained.has(releaseTag.exec(tag)?.[2])))
      protectedIds.add(image.id);
  return images.flatMap((image) => {
    if (
      protectedIds.has(image.id) ||
      Date.parse(image.created) > now - 86400000
    )
      return [];
    return image.tags
      .filter((tag) => releaseTag.test(tag))
      .map((tag) => ({ tag, id: image.id }));
  });
}

async function docker(args) {
  // Ignore DOCKER_HOST/context overrides: this maintenance targets the host's
  // production Unix socket, never an arbitrary remote daemon.
  const result = await exec(
    "docker",
    ["--host", "unix:///var/run/docker.sock", ...args],
    {
      timeout: 120000,
      maxBuffer: 8 * 1024 ** 2,
    },
  );
  return result.stdout;
}

async function currentReleaseTags(root) {
  const release = (
    await readFile(join(root, ".current-release"), "utf8")
  ).trim();
  if (!/^\d+-\d+$/.test(release)) throw Error("current_release_invalid");
  const directory = join(root, "releases", release);
  const tags = [(await readFile(join(directory, "image-tag"), "utf8")).trim()];
  for (const name of ["codex-job-tag", "codex-supervisor-tag"]) {
    try {
      tags.push((await readFile(join(directory, name), "utf8")).trim());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // A half-written Codex bundle is not a trustworthy rollback anchor.
  if (tags.length === 2) throw Error("current_release_invalid");
  return tags;
}

async function containerImages(run) {
  const containers = lines(
    await run(["container", "ls", "--all", "--quiet", "--no-trunc"]),
  );
  if (!containers.length) return [];
  const ids = lines(
    await run([
      "container",
      "inspect",
      "--format",
      "{{.Image}}",
      ...containers,
    ]),
  );
  if (ids.some((id) => !imageId.test(id)))
    throw Error("container_metadata_invalid");
  return ids;
}

export async function cleanupHost(
  root,
  apply = false,
  run = docker,
  report = console.log,
) {
  const current = await currentReleaseTags(root);
  const tags = lines(
    await run(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"]),
  ).filter((tag) => releaseTag.test(tag));
  const images = tags.length
    ? lines(
        await run(["image", "inspect", "--format", imageFormat, ...tags]),
      ).map((line) => JSON.parse(line))
    : [];
  // Docker inspect can return the same image once per alias.
  const unique = [
    ...new Map(images.map((image) => [image.id, image])).values(),
  ];
  const plan = planReleaseCleanup(unique, current, await containerImages(run));
  report(
    `${apply ? "Cleanup" : "Dry run"}: ${plan.length} old release tags eligible; current release, two rollback sets and container images retained.`,
  );
  for (const candidate of plan) {
    report(`${apply ? "Remove" : "Would remove"} ${candidate.tag}`);
    if (!apply) continue;
    const id = (
      await run(["image", "inspect", "--format", "{{.Id}}", candidate.tag])
    ).trim();
    if (id !== candidate.id || (await containerImages(run)).includes(id)) {
      report("Skipped changed or newly referenced image.");
      continue;
    }
    // Never force deletion or prune host containers/volumes. Keep untagged
    // parent images too; their ownership is outside this release-tag policy.
    await run(["image", "rm", "--no-prune", candidate.tag]);
  }
  report(
    `${apply ? "Prune" : "Would prune"} unused host build cache to a 4GB retention target.`,
  );
  if (apply)
    await run([
      "builder",
      "prune",
      "--all",
      "--force",
      "--keep-storage",
      "4GB",
    ]);
  return plan;
}

async function main() {
  const [rootArg, mode] = process.argv.slice(2);
  if (
    !rootArg ||
    ![undefined, "--apply", "--dry-run"].includes(mode) ||
    process.argv.length > 4
  )
    throw Error("Usage: node cleanup-host.mjs DEPLOY_ROOT [--dry-run|--apply]");
  const root = resolve(rootArg);
  if (root === "/") throw Error("invalid_deployment_root");
  // Same ordering as updater -> deploy-vps.sh; skip busy builds or cutovers.
  const acquired = await withStorageLock(root, async () => {
    const deployed = await withFileLock(join(root, ".deploy.lock"), () =>
      cleanupHost(root, mode === "--apply"),
    );
    if (!deployed) console.log("Cleanup skipped: deployment is active.");
  });
  if (!acquired)
    console.log("Cleanup skipped: release build or maintenance is active.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Host cleanup failed; inspect maintenance configuration and Docker. No forced removal was attempted.",
    );
    process.exitCode = 1;
  });
