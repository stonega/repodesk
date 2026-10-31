import { spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Fault, requireThat } from "../domain.ts";
import type { BrowserOwner } from "./config.ts";
import { profileKey } from "./state.ts";

/** Fixed binaries/argument arrays only. Never emit raw process diagnostics. */
export function hostCommand(
  binary: string,
  args: string[],
  input?: string,
  acceptedExitCodes: readonly number[] = [0],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let text = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      text += data;
      if (text.length > 8192) child.kill("SIGKILL");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(deadline);
      reject(new Fault("browser_host_system_unavailable", 503));
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (
        code !== null &&
        acceptedExitCodes.includes(code) &&
        text.length <= 8192
      )
        resolve(text.trim());
      else reject(new Fault("browser_host_system_unavailable", 503));
    });
    child.stdin.end(input);
  });
}

export interface HostIdentity {
  uid: number;
  gid: number;
  home: string;
  directory: string;
  name: string;
}
async function privateDirectory(path: string, mode: number) {
  await mkdir(path, { recursive: true, mode });
  const stat = await lstat(path);
  requireThat(
    stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0,
    "browser_profile_invalid",
    503,
  );
  await chmod(path, mode);
}

/** One locked system account per tenant/user; no shared browser Unix identity. */
export async function hostIdentity(
  root: string,
  owner: BrowserOwner,
): Promise<HostIdentity> {
  requireThat(
    process.getuid?.() === 0 && process.platform === "linux",
    "browser_host_privileges_required",
    503,
  );
  const key = profileKey(owner);
  const directory = join(root, "profiles", key);
  await privateDirectory(root, 0o711);
  await privateDirectory(join(root, "profiles"), 0o711);
  await privateDirectory(directory, 0o711);
  const home = join(directory, "home");
  const name = `rdb_${key.slice(0, 20)}`;
  let entry: string;
  try {
    entry = await hostCommand("getent", ["passwd", name]);
  } catch {
    await hostCommand("useradd", [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      home,
      "--shell",
      "/usr/sbin/nologin",
      name,
    ]);
    entry = await hostCommand("getent", ["passwd", name]);
  }
  const fields = entry.split(":");
  const uid = Number(fields[2]),
    gid = Number(fields[3]);
  requireThat(
    fields[0] === name &&
      fields[5] === home &&
      fields[6] === "/usr/sbin/nologin" &&
      Number.isSafeInteger(uid) &&
      Number.isSafeInteger(gid) &&
      uid >= 100 &&
      gid >= 100,
    "browser_profile_invalid",
    503,
  );
  await mkdir(home, { mode: 0o700, recursive: true });
  const stat = await lstat(home);
  requireThat(
    stat.isDirectory() && !stat.isSymbolicLink() && [0, uid].includes(stat.uid),
    "browser_profile_invalid",
    503,
  );
  await chown(home, uid, gid);
  await chmod(home, 0o700);
  return { uid, gid, home, directory, name };
}

/** nftables prevents proxy bypass, including WebRTC, DNS and direct IP sockets. */
export class BrowserFirewall {
  private initialized = false;
  private initializing?: Promise<void>;
  private users = new Set<number>();
  private async init() {
    if (this.initialized) return;
    this.initializing ??= this.setup();
    try {
      await this.initializing;
      this.initialized = true;
    } catch (error) {
      this.initializing = undefined;
      throw error;
    }
  }
  private apply(commands: string) {
    // Node pipes can be Unix sockets; some nft versions reject them as input files.
    // One argv command batch preserves atomic updates without a shell or input file.
    return hostCommand("nft", [commands]);
  }
  private async setup() {
    try {
      await hostCommand("nft", ["list", "table", "inet", "repodesk_browser"]);
    } catch {
      await this.apply("add table inet repodesk_browser\n");
    }
    try {
      await hostCommand("nft", [
        "list",
        "chain",
        "inet",
        "repodesk_browser",
        "output",
      ]);
    } catch {
      await this.apply(
        "add chain inet repodesk_browser output { type filter hook output priority -10; policy accept; }\n",
      );
    }
  }
  async set(uid: number, proxyPort?: number) {
    requireThat(
      Number.isSafeInteger(uid) &&
        uid >= 100 &&
        uid <= 2 ** 31 - 1 &&
        (proxyPort === undefined ||
          (Number.isInteger(proxyPort) && proxyPort > 0 && proxyPort < 65536)),
      "browser_profile_invalid",
      503,
    );
    await this.init();
    const chain = `u${uid}`;
    if (!this.users.has(uid)) {
      try {
        await hostCommand("nft", [
          "list",
          "chain",
          "inet",
          "repodesk_browser",
          chain,
        ]);
      } catch {
        await this.apply(
          `add chain inet repodesk_browser ${chain}\nadd rule inet repodesk_browser output meta skuid ${uid} jump ${chain}\n`,
        );
      }
      this.users.add(uid);
    }
    await this.apply(
      `flush chain inet repodesk_browser ${chain}\n${proxyPort ? `add rule inet repodesk_browser ${chain} ip daddr 127.0.0.1 tcp dport ${proxyPort} accept\n` : ""}add rule inet repodesk_browser ${chain} reject\n`,
    );
  }
}

/** Kill only an identity whose generated passwd entry still matches its home. */
export async function stopHostIdentity(identity: HostIdentity) {
  const entry = await hostCommand("getent", ["passwd", identity.name]);
  const fields = entry.split(":");
  requireThat(
    Number(fields[2]) === identity.uid && fields[5] === identity.home,
    "browser_profile_invalid",
    503,
  );
  // pkill exit 1 means there were no matching processes; other failures matter.
  await hostCommand(
    "pkill",
    ["-KILL", "-u", String(identity.uid)],
    undefined,
    [0, 1],
  );
}

export async function browserServiceKey(path: string) {
  const stat = await lstat(path);
  requireThat(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === 0 &&
      (stat.mode & 0o077) === 0,
    "browser_credentials_unavailable",
    503,
  );
  const value = (await readFile(path, "utf8")).trim();
  requireThat(
    value.length >= 32 && value.length <= 256,
    "browser_credentials_unavailable",
    503,
  );
  return value;
}
