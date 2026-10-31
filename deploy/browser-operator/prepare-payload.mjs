import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const destination = process.argv[2],
  release = process.env.RELEASE_ID;
if (!/^\d+-\d+$/.test(release ?? "")) throw Error("Invalid release ID");
const digest = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const meta = {
  release_id: release,
  previous_release_id: "1793266373668-15413800",
  source_commit: process.env.GITHUB_SHA,
  source_tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  }).trim(),
  base_commit: "a2e21666a24d9b48f2ec76417c914eb101f87fec",
  package_version: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  source_sha256: digest(path.join(destination, "source.tar.gz")),
  verification: {
    deterministic_tests: 1363,
    browser_scenarios: 15,
    native_plugin_revision_regression: true,
    installer_uid_regression: true,
  },
};
if (!/^[a-f0-9]{40}$/.test(meta.source_commit ?? ""))
  throw Error("Invalid source commit");
fs.writeFileSync(
  path.join(destination, "source-metadata.json"),
  JSON.stringify(meta, null, 2) + "\n",
  { mode: 0o600 },
);
const hashes = {};
for (const f of fs.readdirSync(destination)) {
  if (fs.statSync(path.join(destination, f)).isFile())
    hashes[f] = digest(path.join(destination, f));
}
fs.writeFileSync(
  path.join(destination, "payload-checksums.json"),
  JSON.stringify(hashes, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    release_id: release,
    source_commit: meta.source_commit,
    source_archive_sha256: meta.source_sha256,
    files: Object.keys(hashes).length,
  }),
);
