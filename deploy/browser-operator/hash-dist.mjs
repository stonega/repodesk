import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = "/app/dist",
  hashes = {};
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, item.name);
    if (item.isDirectory()) walk(name);
    else if (item.isFile())
      hashes[path.relative(root, name)] = crypto
        .createHash("sha256")
        .update(fs.readFileSync(name))
        .digest("hex");
  }
}
walk(root);
console.log(JSON.stringify(hashes, null, 2));
