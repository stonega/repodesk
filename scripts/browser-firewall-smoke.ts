import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { BrowserFirewall, hostCommand } from "../src/browser/host-system.ts";

// Run only in the disposable Ubuntu/Node fixture, never against host networking.
await access("/.dockerenv");
assert.equal(process.getuid?.(), 0);
const uid = 10001;
const rules = () =>
  hostCommand("nft", ["list", "chain", "inet", "repodesk_browser", `u${uid}`]);
try {
  const firewall = new BrowserFirewall();
  await firewall.set(uid);
  assert.match(await rules(), /reject/);
  assert.doesNotMatch(await rules(), /accept/);
  await firewall.set(uid, 12345);
  assert.match(await rules(), /127\.0\.0\.1 tcp dport 12345 accept/);
  assert.match(await rules(), /reject/);
  const before = await rules();
  await assert.rejects(firewall.set(uid, 0), /browser_profile_invalid/);
  assert.equal(await rules(), before);
  // A restarted supervisor must revoke the previous proxy allow rule.
  await new BrowserFirewall().set(uid);
  assert.match(await rules(), /reject/);
  assert.doesNotMatch(await rules(), /accept/);
  console.log(
    JSON.stringify({ nodeUbuntuFirewall: true, restartRevokes: true }),
  );
} finally {
  await hostCommand("nft", ["delete", "table", "inet", "repodesk_browser"]);
}
