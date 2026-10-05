import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceAuth } from "../../src/coding/local/device-auth.ts";
import { runnerSettings } from "../../src/coding/local/settings.ts";

test("device login returns a one-time code and seals workspace credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepx-device-auth-"));
  try {
    const executable = join(dir, "fake-codex");
    await writeFile(
      executable,
      `#!/bin/sh
printf 'Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\nEnter this one-time code (expires in 15 minutes)\\n   ABCD-EFGH\\n'
sleep 0.2
printf '{"tokens":{"access_token":"workspace-secret"}}' > "$CODEX_HOME/auth.json"
`,
    );
    await chmod(executable, 0o755);
    const settings = runnerSettings.parse({
      CODEX_RUNNER_STATE: dir,
      CODEX_RUNNER_TOKEN: "management-token".repeat(3),
      CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
    });
    const auth = new DeviceAuth(settings, executable);
    const workspace = randomUUID();
    expect(await auth.start(workspace)).toMatchObject({
      state: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    let status = await auth.status(workspace);
    for (let n = 0; status.state === "pending" && n < 20; n++) {
      await Bun.sleep(50);
      status = await auth.status(workspace);
    }
    expect(status.state).toBe("connected");
    expect(await auth.read(workspace)).toContain("workspace-secret");
    expect(await auth.status(randomUUID())).toEqual({ state: "disconnected" });
    await expect(auth.read(randomUUID())).rejects.toThrow(
      "coding_device_auth_required",
    );
    const home = join(dir, "device-auth", workspace);
    expect(await readFile(join(home, "credential.json"), "utf8")).not.toContain(
      "workspace-secret",
    );
    await expect(readFile(join(home, "auth.json"))).rejects.toThrow();
    expect(await auth.logout(workspace)).toEqual({ state: "disconnected" });
    await expect(auth.read(workspace)).rejects.toThrow(
      "coding_device_auth_required",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("disconnect stops a pending device login and clears its workspace cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deepx-device-logout-"));
  try {
    const executable = join(dir, "fake-codex");
    await writeFile(
      executable,
      `#!/usr/bin/env node
process.stdout.write('https://auth.openai.com/codex/device\\nEnter this one-time code\\n ABCD-EFGH\\n');
setInterval(() => {}, 1000);
`,
    );
    await chmod(executable, 0o755);
    const auth = new DeviceAuth(
      runnerSettings.parse({
        CODEX_RUNNER_STATE: dir,
        CODEX_RUNNER_TOKEN: "management-token".repeat(3),
        CODEX_PROVIDER_BASE_URL: "https://provider.example/v1",
      }),
      executable,
    );
    const workspace = randomUUID();
    expect((await auth.start(workspace)).state).toBe("pending");
    expect(await auth.logout(workspace)).toEqual({ state: "disconnected" });
    expect(await auth.status(workspace)).toEqual({ state: "disconnected" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
