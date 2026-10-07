import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../deploy/codex/wait-checkpoint.mjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(state: string) {
  const root = await mkdtemp(join(tmpdir(), "repodesk-checkpoint-"));
  roots.push(root);
  const path = join(root, `deepx-codex-${"a".repeat(32)}.json`);
  const record = JSON.stringify({ state, input: "private-fixture-content" });
  await writeFile(path, record);
  return { root, path, record };
}
function wait(root: string) {
  const child = Bun.spawn(["node", script, "1"], {
    env: { ...process.env, CODEX_RUNNER_STATE: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  };
}

test("checkpoint timeout defers a busy runner without changing or disclosing its state", async () => {
  const f = await fixture("running");
  const job = wait(f.root);
  expect(await job.child.exited).not.toBe(0);
  expect(await job.stdout).toContain("Waiting for 1 coding attempt");
  expect(await job.stderr).toContain("deployment deferred");
  expect(`${await job.stdout}${await job.stderr}`).not.toContain(
    "private-fixture-content",
  );
  expect(await readFile(f.path, "utf8")).toBe(f.record);
});

test("checkpoint wait observes a completed turn and leaves a queued temporary file alone", async () => {
  const f = await fixture("running");
  await writeFile(`${f.path}.tmp`, "incomplete atomic write");
  const job = wait(f.root);
  await Bun.sleep(100);
  expect(job.child.exitCode).toBeNull();
  await writeFile(f.path, JSON.stringify({ state: "ready" }));
  expect(await job.child.exited).toBe(0);
  expect(await job.stdout).toContain("durable checkpoints");
  expect(await readFile(`${f.path}.tmp`, "utf8")).toBe(
    "incomplete atomic write",
  );
});

test("unknown record states and invalid records cannot authorize a runner replacement", async () => {
  const f = await fixture("new-executing-state");
  const unknown = wait(f.root);
  expect(await unknown.child.exited).not.toBe(0);
  await unknown.stdout;
  await unknown.stderr;
  await writeFile(f.path, "private-fixture-content invalid JSON");
  const invalid = wait(f.root);
  expect(await invalid.child.exited).not.toBe(0);
  await invalid.stdout;
  expect(await invalid.stderr).not.toContain("private-fixture-content");
});
