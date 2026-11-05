import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const destination = process.argv[2];
const release = process.env.RELEASE_ID;
const commit = process.env.GITHUB_SHA;
if (!/^\d+-\d+$/.test(release ?? "") || !/^[a-f0-9]{40}$/.test(commit ?? ""))
  throw Error("invalid_update_identity");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const digest = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const baseline = JSON.parse(
  readFileSync("deploy/browser-operator/update-baseline.json", "utf8"),
);
try {
  git("merge-base", "--is-ancestor", baseline.previous_source_commit, commit);
} catch {
  throw Error("update_source_does_not_preserve_production");
}
const meta = {
  ...baseline,
  release_id: release,
  source_commit: commit,
  source_tree: git("rev-parse", "HEAD^{tree}"),
  source_sha256: digest(join(destination, "source.tar.gz")),
  code_truth_tree: git("rev-parse", "HEAD:services/code-truth"),
  migration_tree: git("rev-parse", "HEAD:migrations"),
  package_version: JSON.parse(readFileSync("package.json", "utf8")).version,
};
if (
  meta.code_truth_tree !== meta.previous_code_truth_tree ||
  meta.migration_tree !== meta.previous_migration_tree
)
  throw Error("update_baseline_changed");
writeFileSync(
  join(destination, "source-metadata.json"),
  `${JSON.stringify(meta, null, 2)}\n`,
);
const checks = Object.fromEntries(
  readdirSync(destination)
    .filter((name) => name !== "payload-checksums.json")
    .map((name) => [name, digest(join(destination, name))]),
);
writeFileSync(
  join(destination, "payload-checksums.json"),
  `${JSON.stringify(checks, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    release_id: release,
    source_commit: commit,
    source_archive_sha256: meta.source_sha256,
  }),
);
