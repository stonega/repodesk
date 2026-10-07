import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunnerClient } from "../../src/coding/local/client.ts";
import { DeviceAuth } from "../../src/coding/local/device-auth.ts";
import { runnerSettings } from "../../src/coding/local/settings.ts";

const failures = [
  [
    "Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)",
    "coding_device_login_network_failed",
  ],
  [
    "device code request failed with status 403 Forbidden",
    "coding_device_login_rejected",
  ],
  [
    "device code login is not enabled for this Codex server",
    "coding_device_login_disabled",
  ],
  ["unexpected startup failure", "coding_device_login_unavailable"],
] as const;
for (const [output, code] of failures) {
  test(`device login reports ${code} without raw output or cross-workspace state`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "repodesk-device-error-"));
    const workspace = randomUUID();
    try {
      const executable = join(dir, "codex");
      await writeFile(
        executable,
        `#!/usr/bin/env node\nconsole.error(${JSON.stringify(`${output}\nprivate-token-fixture`)});process.exit(1);\n`,
      );
      await chmod(executable, 0o755);
      const auth = new DeviceAuth(
        runnerSettings.parse({
          CODEX_RUNNER_TOKEN: "management-token".repeat(3),
          CODEX_RUNNER_STATE: dir,
          CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
        }),
        executable,
      );
      await expect(auth.start(workspace)).rejects.toMatchObject({
        code,
        message: code,
      });
      expect(await auth.status(workspace)).toEqual({ state: "failed" });
      expect(await auth.status(randomUUID())).toEqual({
        state: "disconnected",
      });
      const client = new LocalRunnerClient(
        "http://runner.invalid",
        "fixture",
        Object.assign(
          async () =>
            new Response(
              JSON.stringify({ error: code, detail: "private-token-fixture" }),
              { status: 503 },
            ),
          { preconnect: fetch.preconnect },
        ),
      );
      await expect(client.deviceStart(workspace)).rejects.toMatchObject({
        code,
        message: code,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
test("failed sign-in preserves the sealed auth-required generation for paused tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-device-preserve-"));
  try {
    const executable = join(dir, "codex");
    await writeFile(
      executable,
      "#!/bin/sh\nprintf 'error sending request' >&2\nexit 1\n",
    );
    await chmod(executable, 0o755);
    const auth = new DeviceAuth(
      runnerSettings.parse({
        CODEX_RUNNER_TOKEN: "management-token".repeat(3),
        CODEX_RUNNER_STATE: dir,
        CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
      }),
      executable,
    );
    const workspace = randomUUID();
    const generation = await auth.save(
      workspace,
      JSON.stringify({ tokens: { access_token: "retained-account" } }),
    );
    await auth.invalidate(workspace, generation);
    const path = join(dir, "device-auth", workspace, "credential.json");
    const sealed = await readFile(path, "utf8");
    await expect(auth.start(workspace)).rejects.toThrow(
      "coding_device_login_network_failed",
    );
    expect(await auth.status(workspace)).toEqual({ state: "auth_required" });
    expect(await readFile(path, "utf8")).toBe(sealed);
    await auth.logout(workspace);
    expect(await auth.status(workspace)).toEqual({ state: "disconnected" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect terminates the launcher and its native child without affecting another workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "repodesk-device-process-group-"));
  const executable = join(dir, "codex");
  const auth = new DeviceAuth(
    runnerSettings.parse({
      CODEX_RUNNER_TOKEN: "management-token".repeat(3),
      CODEX_RUNNER_STATE: dir,
      CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
    }),
    executable,
  );
  const workspaces = [randomUUID(), randomUUID()];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Announce login only after the native child has written its first heartbeat.
    // Replace heartbeats atomically so a concurrent read cannot see an empty file.
    await writeFile(
      executable,
      `#!/usr/bin/env node
const {spawn}=require('node:child_process');const {join,basename}=require('node:path');
const marker=join(${JSON.stringify(dir)},basename(process.env.CODEX_HOME)+'.heartbeat');
const child=spawn(process.execPath,['-e',"const fs=require('node:fs');const marker=process.argv[1];const tick=()=>{fs.writeFileSync(marker+'.tmp',String(Date.now()));fs.renameSync(marker+'.tmp',marker);};tick();process.send('ready');setInterval(tick,25);",marker],{stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>console.log('https://auth.openai.com/codex/device\\nEnter this one-time code\\n ABCD-EFGH'));
setInterval(()=>{},1000);
`,
    );
    await chmod(executable, 0o755);
    for (const workspace of workspaces)
      expect((await auth.start(workspace)).state).toBe("pending");
    const first = workspaces[0] ?? "";
    const second = workspaces[1] ?? "";
    await Promise.race([
      auth.logout(first),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("native process kept login pipes open")),
          2000,
        );
      }),
    ]);
    clearTimeout(timer);
    const firstMarker = join(dir, `${first}.heartbeat`);
    const secondMarker = join(dir, `${second}.heartbeat`);
    const stopped = await readFile(firstMarker, "utf8");
    const running = await readFile(secondMarker, "utf8");
    await Bun.sleep(150);
    expect(await readFile(firstMarker, "utf8")).toBe(stopped);
    expect(await readFile(secondMarker, "utf8")).not.toBe(running);
    expect(await auth.status(second)).toMatchObject({ state: "pending" });
  } finally {
    clearTimeout(timer);
    try {
      await Promise.all(workspaces.map((workspace) => auth.logout(workspace)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
