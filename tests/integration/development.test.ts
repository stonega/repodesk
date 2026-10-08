import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import {
  type DevelopmentResult,
  developmentPolicy,
} from "../../src/coding/development.ts";
import { DevelopmentExecutor } from "../../src/coding/executor.ts";
import { codingExtension } from "../../src/coding/extension.ts";
import type {
  LocalDeviceAuth,
  LocalRunner,
  LocalStart,
  LocalStatus,
} from "../../src/coding/local/protocol.ts";
import { taskGet, taskInputs, taskSave } from "../../src/coding/task-store.ts";
import {
  appendDevelopment,
  cancelDevelopment,
  pruneDevelopment,
  startDevelopment,
} from "../../src/coding/tasks.ts";
import {
  routeDevelopment,
  selectDevelopment,
} from "../../src/coding/telegram.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database, transaction } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { Fault, type Source } from "../../src/domain.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubApps } from "../../src/github/registry.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import type { SetupService } from "../../src/setup/service.ts";
import { TelegramError } from "../../src/telegram/client.ts";
import { recordProgress } from "../../src/telegram/feedback.ts";
import { stopGeneration } from "../../src/telegram/generation.ts";
import type { Message, Update } from "../../src/telegram/router.ts";
import {
  selectTaskControl,
  taskControl,
} from "../../src/telegram/task-controls.ts";
import { Ingress } from "../../src/telegram/webhook.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig, githubTransport } from "../github-fixture.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Continuous development collaboration", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const dbName = `development_${randomUUID().replaceAll("-", "")}`;
  const operator = randomUUID();
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(present(url));
    parsed.pathname = `/${dbName}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'dev','unused',true)",
      [operator],
    );
    await store.pool.query(
      "UPDATE deployment SET data=jsonb_set(jsonb_set(data,'{active}','true'),'{bot}','{\"id\":\"999\",\"username\":\"fixture\"}')",
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const original = "Fix pagination and open a draft PR";
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwEEQAwAG/ID/U0/Ov8AAAAASUVORK5CYII=",
    "base64",
  );
  const photo = {
    botId: "999",
    fileId: "screenshot",
    kind: "photo" as const,
    size: image.length,
  };
  const result = (
    patch: Partial<DevelopmentResult> = {},
  ): DevelopmentResult => ({
    status: "intent",
    intent: "implement",
    evidenceRevision: 1,
    evidence: original,
    publishRequested: true,
    summary: "Pagination fixed. Configured checks passed.",
    question: null,
    title: "Fix pagination",
    body: "Fixed pagination and verified checks.",
    verificationCommands: ["bun test"],
    ...patch,
  });
  async function fixture(
    text = original,
    chatId = "101",
    attachments?: Source["attachments"],
  ) {
    const w = workspace();
    w.operatorId = operator;
    w.github = {
      revision: 1,
      installationId: 501,
      repositories: [
        { id: 7001, full_name: "example/workspace", private: true },
      ],
    };
    w.coding = {
      revision: 1,
      settings: {
        enabled: true,
        backend: "podman",
        authMode: "provider_key",
        repositories: [
          {
            repositoryId: 7001,
            baseBranch: "develop",
            maintainers: ["101", "202"],
            development: developmentPolicy.parse({ executionMode: "direct" }),
          },
        ],
      },
    };
    const run = createRun(w, "101", text, chatId, 3, "gpt-4.1-mini", {
      replyTo: 10,
      botId: "999",
    });
    run.status = "running";
    const source = present(
      w.messages.find((s) => s.runId === run.id && s.role === "user"),
    );
    source.attachments = attachments;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operator, JSON.stringify(w)],
    );
    const task = await store.change(w.id, (current, sql) =>
      startDevelopment(sql, current, run.id, "101", 7001, [source.id], "999"),
    );
    const starts: LocalStart[] = [],
      publications: string[] = [],
      cancels: string[] = [],
      erases: string[] = [];
    let status: LocalStatus = { state: "running" };
    const runner: LocalRunner = {
      async start(input) {
        starts.push(input);
      },
      async status() {
        return status;
      },
      async publish(_w, id) {
        publications.push(id);
      },
      async cancel(_w, id) {
        cancels.push(id);
      },
      async erase(_w, id) {
        erases.push(id);
      },
    };
    const fallback = githubTransport();
    let onToken: (() => Promise<void>) | undefined;
    let onDownload: (() => Promise<void>) | undefined;
    const downloads: string[] = [];
    let downloadError: string | undefined;
    let confirmUnknown = false;
    let remoteHead = "b".repeat(40),
      closed = false;
    const app = new GitHubApp(githubFixtureConfig, (async (input, init) => {
      if (String(input).endsWith("/access_tokens")) await onToken?.();
      if (String(input).includes("/pulls?"))
        return Response.json(
          confirmUnknown
            ? [
                {
                  number: 43,
                  state: "open",
                  head: {
                    ref: `codex/repodesk-${task.id}`,
                    sha: "b".repeat(40),
                    repo: { full_name: "example/workspace" },
                  },
                  base: { ref: "develop" },
                },
              ]
            : [],
        );
      if (String(input).endsWith("/pulls/43"))
        return Response.json({
          number: 43,
          state: closed ? "closed" : "open",
          merged: false,
          head: {
            ref: `codex/repodesk-${task.id}`,
            sha: remoteHead,
            repo: { full_name: "example/workspace" },
          },
        });
      return fallback(input, init);
    }) as typeof fetch);
    const executor = () =>
      new DevelopmentExecutor(
        store,
        new GitHubApps(store, "ab".repeat(32), app),
        runner,
        "ab".repeat(32),
        async () => ({
          async call() {
            throw new Error("Unexpected Telegram call");
          },
          async downloadFile(id, _max, options) {
            downloads.push(id);
            await onDownload?.();
            options?.signal?.throwIfAborted();
            if (downloadError) throw new Fault(downloadError);
            return image;
          },
        }),
      );
    const read = () => taskGet(store.pool, w.id, task.id);
    const tick = async (next?: LocalStatus) => {
      if (next) status = next;
      await store.change(w.id, async (_w, sql) => {
        const t = await read();
        t.nextPollAt = undefined;
        t.leaseUntil = undefined;
        await taskSave(sql, t);
      });
      await executor().advance(w.id, task.id);
      return read();
    };
    const append = async (
      text: string,
      actor = "101",
      key: string = randomUUID(),
    ) =>
      store.change(w.id, async (w, sql) => {
        const t = await taskGet(sql, w.id, task.id);
        const source: Source = {
          id: `${actor}:${key}`,
          author: actor,
          chatId: t.chatId,
          topicId: t.topicId,
          text,
          directed: true,
          role: "user",
          at: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        };
        w.messages.push(source);
        return appendDevelopment(sql, w, t, actor, source, key);
      });
    return {
      w,
      task,
      run,
      source,
      starts,
      publications,
      cancels,
      erases,
      runner,
      read,
      tick,
      append,
      executor,
      downloads,
      onDownload: (fn: () => Promise<void>) => {
        onDownload = fn;
      },
      failDownload: (code: string) => {
        downloadError = code;
      },
      onToken: (fn: () => Promise<void>) => {
        onToken = fn;
      },
      confirmUnknown: () => {
        confirmUnknown = true;
      },
      close: () => {
        closed = true;
      },
      makePublic: () =>
        store.change(w.id, (current) => {
          present(present(current.github).repositories[0]).private = false;
        }),
      head: (sha: string) => {
        remoteHead = sha;
      },
    };
  }
  test("original message, atomic outbox, duplicates, tenant scope and rollback", async () => {
    const f = await fixture();
    expect((await taskInputs(store.pool, f.task))[0]?.text).toBe(original);
    expect(
      (
        await store.pool.query(
          "SELECT id FROM outbox WHERE workspace_id=$1 AND kind='delivery'",
          [f.w.id],
        )
      ).rowCount,
    ).toBe(1);
    const duplicate = await store.change(f.w.id, (w, sql) =>
      startDevelopment(sql, w, f.run.id, "101", 7001, [f.source.id], "999"),
    );
    expect(duplicate.id).toBe(f.task.id);
    await expect(taskGet(store.pool, randomUUID(), f.task.id)).rejects.toThrow(
      "not_found",
    );
    await expect(
      store.change(f.w.id, async (w, sql) => {
        const t = await taskGet(sql, w.id, f.task.id);
        await cancelDevelopment(sql, w, "101", t.id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await f.read()).cancelRequested).toBe(false);
    await f.append("Also handle empty pages", "101", "unique");
    await f.append("Also handle empty pages", "101", "unique");
    expect((await f.read()).revision).toBe(2);
  });
  test("initial screenshots reach the runner without persisting image bytes in application attempts", async () => {
    const f = await fixture(original, "101", [photo]);
    await f.tick();
    const run = present(f.starts[0]?.development);
    expect(f.downloads).toEqual(["screenshot"]);
    expect(run.inputs[0]?.text).toBe(original);
    expect(run.inputs[0]?.hasAttachments).toBe(true);
    expect(run.media?.images[0]?.data).toBe(image.toString("base64"));
    expect(run.media?.images[0]?.mimeType).toBe("image/png");
    expect(run.media?.prompt).toContain(f.source.id);
    expect(run.media?.prompt).not.toContain('"fileId"');
    const persisted = await store.pool.query(
      "SELECT data FROM coding_task_attempts WHERE workspace_id=$1",
      [f.w.id],
    );
    expect(JSON.stringify(persisted.rows)).not.toContain(
      image.toString("base64"),
    );
    // The original retained source rebuilds media for the next isolated attempt.
    await f.tick({
      state: "succeeded",
      result: result(),
      threadId: "image-thread",
    });
    await f.tick();
    expect(f.starts.at(-1)?.development?.media?.images).toEqual(
      run.media?.images,
    );
    expect(f.downloads).toHaveLength(2);
  });
  test("captionless screenshot answers survive waiting and duplicates while quoting the original instruction", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({
      state: "succeeded",
      result: result({
        status: "needs_input",
        question: "Attach the screenshot.",
      }),
    });
    await store.change(f.w.id, (w) => {
      const notice = present(
        w.deliveries.find((d) => d.id.includes(":question:")),
      );
      notice.state = "sent";
      notice.remoteId = 19;
    });
    const msg = {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false },
      chat: { id: 101, type: "private" as const },
      message_thread_id: 3,
      reply_to_message: { message_id: 19 },
      photo: [
        {
          file_id: "answer-photo",
          width: 10,
          height: 10,
          file_size: image.length,
        },
      ],
    };
    const route = () =>
      store.change(f.w.id, (w, sql) =>
        routeDevelopment(sql, w, { update_id: 20, message: msg }, "999", msg, {
          name: "ask",
          args: "",
        }),
      );
    expect(await route()).toBe(true);
    expect(await route()).toBe(true);
    expect((await f.read()).revision).toBe(2);
    const input = present((await taskInputs(store.pool, f.task)).at(-1));
    expect(input.text).toBe("");
    expect(input.kind).toBe("answer");
    expect(input.hasAttachments).toBe(true);
    expect((await store.read(f.w.id)).runs).toHaveLength(1);
    await f.tick();
    expect(f.starts.at(-1)?.development?.media?.images).toHaveLength(1);
    expect(f.downloads).toEqual(["answer-photo"]);
    const classified = await f.tick({
      state: "succeeded",
      result: result({ evidenceRevision: 1, evidence: original }),
    });
    expect(classified.canImplement).toBe(true);
    expect(classified.phase).toBe("work");
  });
  test("captioned image documents and edited media become ordered task inputs; unauthorized users cannot append", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({
      state: "succeeded",
      result: result({ status: "needs_input", question: "Which style?" }),
    });
    await store.change(f.w.id, (w) => {
      const notice = present(
        w.deliveries.find((d) => d.id.includes(":question:")),
      );
      notice.state = "sent";
      notice.remoteId = 19;
    });
    const msg = {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false },
      chat: { id: 101, type: "private" as const },
      message_thread_id: 3,
      reply_to_message: { message_id: 19 },
      caption: "Match this style",
      document: {
        file_id: "document-photo",
        mime_type: "image/png",
        file_size: image.length,
      },
    };
    await store.change(f.w.id, (w, sql) =>
      routeDevelopment(sql, w, { update_id: 20, message: msg }, "999", msg),
    );
    const edited = {
      ...msg,
      caption: "Keep the existing colors",
      document: { ...msg.document, file_id: "edited-photo" },
    };
    await store.change(f.w.id, (w, sql) =>
      routeDevelopment(
        sql,
        w,
        { update_id: 21, edited_message: edited },
        "999",
        edited,
      ),
    );
    const denied = { ...msg, from: { id: 303, is_bot: false } };
    expect(
      await store.change(f.w.id, (w, sql) =>
        routeDevelopment(
          sql,
          w,
          { update_id: 22, message: denied },
          "999",
          denied,
        ),
      ),
    ).toBe(false);
    const inputs = await taskInputs(store.pool, f.task);
    expect(inputs.map((input) => input.text)).toEqual([
      original,
      "Match this style",
      "Keep the existing colors",
    ]);
    await f.tick();
    expect(f.downloads[0]).toBe("edited-photo");
    expect(f.starts.at(-1)?.development?.media?.images).toHaveLength(2);
  });
  test("media is not dispatched after permission, cancellation, source or bot credential changes during download", async () => {
    for (const change of [
      "permission",
      "cancel",
      "source",
      "credential",
      "expiry",
    ] as const) {
      const f = await fixture(original, "101", [photo]);
      const deployment = await store.deployment();
      f.onDownload(async () => {
        if (change === "credential") {
          await store.pool.query(
            "UPDATE deployment SET data=jsonb_set(data,'{credentials,bot}','\"rotated-fixture\"')",
          );
        } else
          await store.change(f.w.id, async (w, sql) => {
            if (change === "permission")
              present(w.coding?.settings.repositories[0]).maintainers = [];
            if (change === "cancel")
              await cancelDevelopment(sql, w, "101", f.task.id);
            const source = present(
              w.messages.find((s) => s.id === f.source.id),
            );
            if (change === "source")
              source.attachments = [{ ...photo, fileId: "replaced" }];
            if (change === "expiry")
              source.expiresAt = new Date(0).toISOString();
          });
      });
      const stopped = await f.tick();
      expect(f.downloads).toHaveLength(1);
      expect(f.starts).toHaveLength(0);
      if (change === "cancel") expect(stopped.state).toBe("cancelled");
      if (change === "credential")
        await store.pool.query(
          "UPDATE deployment SET data=jsonb_set(data,'{credentials}',$1::jsonb)",
          [JSON.stringify(deployment.credentials)],
        );
    }
  });
  test("unavailable current media stops before model dispatch with readable feedback", async () => {
    const f = await fixture(original, "101", [photo]);
    f.failDownload("attachment_download_failed");
    const failed = await f.tick();
    expect(failed.state).toBe("failed");
    expect(f.starts).toHaveLength(0);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
      "couldn't download",
    );
  });
  test("a transient runner restart leaves an undispatched account task queued and starts it once after recovery", async () => {
    const f = await fixture();
    await store.change(f.w.id, async (w, sql) => {
      if (!w.coding) throw new Error("Missing coding fixture");
      w.coding.settings.authMode = "device_code";
      const task = await taskGet(sql, w.id, f.task.id);
      task.payload.authMode = "device_code";
      await taskSave(sql, task);
    });
    let calls = 0;
    (f.runner as LocalRunner & LocalDeviceAuth).deviceStatus = async () => {
      if (++calls === 1) throw new Fault("coding_runner_unavailable", 503);
      return { state: "connected" };
    };
    const queued = await f.tick();
    expect(queued.state).toBe("queued");
    expect(queued.attemptId).toBeUndefined();
    expect(queued.attempts).toBe(0);
    expect(f.starts).toHaveLength(0);
    expect((await f.tick()).state).toBe("working");
    expect(f.starts).toHaveLength(1);
  });
  test("question survives restart, releases attempt and answers continue the same PR", async () => {
    const f = await fixture();
    await f.tick();
    expect(f.starts[0]?.issue).toBeUndefined();
    expect(f.starts[0]?.development?.inputs[0]?.text).toBe(original);
    await f.tick({
      state: "succeeded",
      tokens: 20,
      threadId: "thread-1",
      result: result(),
    });
    await f.tick();
    const waiting = await f.tick({
      state: "succeeded",
      tokens: 30,
      threadId: "thread-1",
      result: result({
        status: "needs_input",
        question: "Should empty results keep page one?",
      }),
    });
    expect(waiting.state).toBe("waiting");
    expect(waiting.attemptId).toBeUndefined();
    await f.append("Yes, keep page one.");
    await f.tick();
    expect(f.starts.at(-1)?.development?.mode).toBe("work");
    expect(f.starts.at(-1)?.development?.inputs.at(-1)?.kind).toBe("answer");
    await f.tick({
      state: "ready",
      tokens: 40,
      checkPassed: true,
      threadId: "thread-2",
      result: result({ status: "completed" }),
    });
    expect(f.publications).toHaveLength(1);
    const done = await f.tick({
      state: "succeeded",
      tokens: 40,
      prUrl: "https://github.com/example/workspace/pull/43",
      publishedSha: "b".repeat(40),
    });
    expect(done.state).toBe("review");
    await f.append("Also handle negative pages.");
    await f.tick();
    expect(f.starts.at(-1)?.development?.pr?.number).toBe(43);
    await f.tick({
      state: "succeeded",
      tokens: 20,
      result: result({
        evidenceRevision: 3,
        evidence: "Also handle negative pages.",
      }),
    });
    await f.tick();
    await f.tick({
      state: "ready",
      tokens: 40,
      checkPassed: true,
      result: result({ status: "completed" }),
    });
    const updated = await f.tick({
      state: "succeeded",
      tokens: 40,
      prUrl: present(done.pr).url,
      publishedSha: "c".repeat(40),
    });
    expect(updated.pr?.number).toBe(43);
    expect(f.publications).toHaveLength(2);
  });
  test("pending input blocks stale publication and is preserved in order", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({ state: "succeeded", tokens: 10, result: result() });
    await f.tick();
    await f.append("Keep zero-based pages");
    const pending = await f.tick({
      state: "ready",
      tokens: 20,
      result: result({ status: "completed" }),
      checkPassed: true,
    });
    expect(pending.state).toBe("queued");
    expect(pending.verifiedRevision).toBe(1);
    expect(f.publications).toHaveLength(0);
    await f.tick();
    expect(f.starts.at(-1)?.development?.inputs.map((i) => i.text)).toEqual([
      original,
      "Keep zero-based pages",
    ]);
  });
  test("a lost checkpoint release acknowledgement preserves verified work and retries the same cleanup", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({ state: "succeeded", tokens: 10, result: result() });
    await f.tick();
    const attemptId = present((await f.read()).attemptId);
    await f.append("Keep zero-based pages");
    let unavailable = true;
    f.runner.cancel = async (_workspace, id) => {
      f.cancels.push(id);
      if (unavailable) throw new Fault("coding_outcome_unknown", 503);
    };
    const verified = await f.tick({
      state: "ready",
      tokens: 20,
      checkPassed: true,
      result: result({ status: "completed" }),
    });
    expect(verified.state).toBe("queued");
    expect(verified.cleanupAttemptId).toBe(attemptId);
    expect(verified.previousAttemptId).toBe(attemptId);
    expect(verified.verifiedRevision).toBe(1);
    expect(verified.tokens).toBe(30);
    expect(verified.attemptId).toBeUndefined();
    await f.tick();
    expect(f.starts).toHaveLength(2);
    expect((await f.read()).cleanupAttemptId).toBe(attemptId);
    unavailable = false;
    await f.tick();
    expect((await f.read()).cleanupAttemptId).toBeUndefined();
    expect((await f.read()).tokens).toBe(30);
    expect(f.cancels).toEqual([attemptId, attemptId, attemptId]);
    await f.tick();
    expect(f.starts).toHaveLength(3);
    expect(f.starts.at(-1)?.development?.previousAttemptId).toBe(attemptId);
    expect(f.starts.at(-1)?.development?.revision).toBe(2);
    expect(f.publications).toHaveLength(0);
    expect(
      (await store.read(f.w.id)).deliveries.some((d) =>
        d.id.startsWith(`development:${f.task.id}:stopped:`),
      ),
    ).toBe(false);
  });
  test("a checkpoint awaiting review releases its runner slot after an executor restart", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({
      state: "succeeded",
      tokens: 10,
      result: result({ publishRequested: false }),
    });
    await f.tick();
    const attemptId = present((await f.read()).attemptId);
    f.runner.cancel = async () => {
      throw new Fault("coding_runner_unavailable", 503);
    };
    const review = await f.tick({
      state: "ready",
      tokens: 20,
      checkPassed: true,
      result: result({ status: "completed", publishRequested: false }),
    });
    expect(review.state).toBe("review");
    expect(review.cleanupAttemptId).toBe(attemptId);
    f.runner.cancel = async (_workspace, id) => {
      f.cancels.push(id);
    };
    await store.change(f.w.id, async (_w, sql) => {
      const task = await f.read();
      task.nextPollAt = undefined;
      await taskSave(sql, task);
    });
    await f.executor().tick(f.w.id);
    expect((await f.read()).state).toBe("review");
    expect((await f.read()).cleanupAttemptId).toBeUndefined();
    expect(f.cancels).toEqual([attemptId]);
    expect(f.starts).toHaveLength(2);
    expect(f.publications).toHaveLength(0);
  });
  test("runner outages before dispatch leave an account-auth task queued without reserving an attempt", async () => {
    const f = await fixture();
    const device = await configureDevice(f);
    device.runner.deviceStatus = async () => {
      throw new Fault("coding_runner_unavailable", 503);
    };
    for (let n = 0; n < 2; n++) {
      const queued = await f.tick();
      expect(queued.state).toBe("queued");
      expect(queued.attemptId).toBeUndefined();
      expect(queued.attempts).toBe(0);
    }
    expect(f.starts).toHaveLength(0);
    expect(f.cancels).toHaveLength(0);
    device.runner.deviceStatus = async () => ({ state: "connected" });
    const running = await f.tick();
    expect(running.state).toBe("working");
    expect(f.starts).toHaveLength(1);
    expect(
      (await store.read(f.w.id)).deliveries.some((d) =>
        d.id.startsWith(`development:${f.task.id}:stopped:`),
      ),
    ).toBe(false);
  });
  test("analysis and forged evidence cannot publish; missing usage is explicit and does not block authorized work", async () => {
    const f = await fixture("Explain pagination only");
    await f.tick();
    await f.tick({
      state: "succeeded",
      tokens: 10,
      result: result({
        intent: "analyze",
        evidence: "Explain pagination only",
        publishRequested: false,
      }),
    });
    await f.tick();
    expect(f.starts.at(-1)?.development?.mode).toBe("analysis");
    const done = await f.tick({
      state: "succeeded",
      tokens: 20,
      result: result({ status: "analysis", intent: "analyze" }),
    });
    expect(done.state).toBe("review");
    expect(f.publications).toHaveLength(0);
    const forged = await fixture();
    await forged.tick();
    expect(
      (
        await forged.tick({
          state: "succeeded",
          tokens: 10,
          result: result({ evidence: "invented permission" }),
        })
      ).state,
    ).toBe("failed");
    const missing = await fixture();
    await missing.tick();
    const unknown = await missing.tick({
      state: "succeeded",
      result: result(),
    });
    expect(unknown.tokens).toBe(0);
    expect(unknown.usageUnknown).toBe(true);
    expect((await missing.tick()).state).toBe("working");
    expect(missing.starts.at(-1)?.development?.mode).toBe("work");
  });

  test("cycles, elapsed time and reported token counts do not impose execution quotas", async () => {
    const f = await fixture();
    await store.change(f.w.id, async (_w, sql) => {
      const task = await taskGet(sql, f.w.id, f.task.id);
      task.attempts = 100;
      task.activeMs = 30 * 86400000;
      task.tokens = 3000000;
      await taskSave(sql, task);
    });
    expect((await f.tick()).state).toBe("working");
    expect(f.starts).toHaveLength(1);
    expect(f.publications).toHaveLength(0);
    const run = f.starts[0]?.development;
    for (const key of [
      "maxAttempts",
      "maxRepairAttempts",
      "activeSeconds",
      "maxTokens",
    ])
      expect(run).not.toHaveProperty(key);
    await store.change(f.w.id, async (w, sql) => {
      await cancelDevelopment(sql, w, "101", f.task.id);
    });
    expect((await f.tick()).state).toBe("cancelled");
    expect(f.cancels).toHaveLength(1);
  });

  test("retired limits migration preserves authority, separates tenant usage and is repeatable", async () => {
    const first = await fixture();
    const second = await fixture();
    const policy = {
      executionMode: "direct",
      publishByDefault: false,
      maxAttempts: 1,
      maxRepairAttempts: 0,
      activeSeconds: 60,
      maxTokens: 200000,
    };
    for (const [f, tokens] of [
      [first, 17],
      [second, 33],
    ] as const) {
      await store.pool.query(
        "UPDATE workspaces SET data=jsonb_set(data,'{coding,settings,repositories,0,development}',$2::jsonb) WHERE id=$1",
        [f.w.id, JSON.stringify(policy)],
      );
      await store.pool.query(
        "UPDATE coding_tasks SET data=jsonb_set(jsonb_set(data,'{policy}',$3::jsonb),'{tokens}','200000') WHERE workspace_id=$1 AND id=$2",
        [f.w.id, f.task.id, JSON.stringify(policy)],
      );
      await store.pool.query(
        "INSERT INTO coding_task_attempts(workspace_id,task_id,id,fence,state,data) VALUES($1,$2,$3,1,'done',$4)",
        [
          f.w.id,
          f.task.id,
          randomUUID(),
          JSON.stringify({ tokens, endedAt: 1 }),
        ],
      );
    }
    await store.pool.query(
      "INSERT INTO coding_task_attempts(workspace_id,task_id,id,fence,state,data) VALUES($1,$2,$3,2,'done',$4)",
      [
        first.w.id,
        first.task.id,
        randomUUID(),
        JSON.stringify({ usageReserved: 199983, endedAt: 2 }),
      ],
    );
    const grants = (
      await store.pool.query(
        "SELECT data FROM coding_task_grants WHERE workspace_id=$1 AND task_id=$2",
        [first.w.id, first.task.id],
      )
    ).rows;
    const sql = await readFile(
      new URL("../../migrations/014_remove_coding_limits.sql", import.meta.url),
      "utf8",
    );
    for (let pass = 0; pass < 2; pass++) {
      await store.pool.query(sql);
      expect((await first.read()).policy).toEqual({
        executionMode: "direct",
        publishByDefault: false,
      });
      expect((await first.read()).tokens).toBe(17);
      expect((await first.read()).usageUnknown).toBe(true);
      expect((await second.read()).tokens).toBe(33);
      expect((await second.read()).usageUnknown).toBe(false);
      const w = await store.read(first.w.id);
      expect(w.coding?.revision).toBe(1);
      expect(w.coding?.settings.repositories[0]?.development).toEqual({
        executionMode: "direct",
        publishByDefault: false,
      });
      expect(
        (
          await store.pool.query(
            "SELECT data FROM coding_task_grants WHERE workspace_id=$1 AND task_id=$2",
            [first.w.id, first.task.id],
          )
        ).rows,
      ).toEqual(grants);
    }
  });
  test("failed result-validation issues persist in the fenced tenant attempt without publication", async () => {
    const f = await fixture();
    await f.tick();
    const issues: NonNullable<LocalStatus["resultIssues"]> = [
      { path: ["verificationCommands"], code: "custom" },
    ];
    const stopped = await f.tick({
      state: "failed",
      error: "coding_result_invalid",
      tokens: 32,
      usageUnknown: false,
      resultIssues: issues,
    });
    expect(stopped.state).toBe("failed");
    expect(stopped.error).toBe("coding_result_invalid");
    expect(f.publications).toHaveLength(0);
    const data = (
      await store.pool.query(
        "SELECT data FROM coding_task_attempts WHERE workspace_id=$1 AND id=$2",
        [f.w.id, stopped.previousAttemptId],
      )
    ).rows[0]?.data;
    expect(data.resultIssues).toEqual(issues);
    expect(data.tokens).toBe(32);
    expect(data.checkPassed).not.toBe(true);
  });

  test("retry intake accepts current verbatim evidence and rejects narrative or earlier requirements", async () => {
    for (const evidence of [
      "The user requested another attempt at the original pagination fix.",
      original,
    ]) {
      const rejected = await fixture("Try again");
      await rejected.tick();
      const stopped = await rejected.tick({
        state: "succeeded",
        tokens: 10,
        result: result({ evidence }),
      });
      expect(stopped.state).toBe("failed");
      expect(stopped.error).toBe("coding_intent_unverified");
      expect(stopped.canImplement).toBe(false);
      expect(stopped.canPublish).toBe(false);
      expect(rejected.publications).toHaveLength(0);
    }
    const accepted = await fixture("Try again");
    await accepted.tick();
    const queued = await accepted.tick({
      state: "succeeded",
      tokens: 10,
      result: result({ evidence: "Try again", publishRequested: false }),
    });
    expect(queued.state).toBe("queued");
    expect(queued.phase).toBe("work");
    expect(queued.canImplement).toBe(true);
    expect(queued.canPublish).toBe(false);
    await accepted.tick();
    expect(accepted.starts.at(-1)?.development?.mode).toBe("work");
    expect(accepted.publications).toHaveLength(0);
  });
  test("revocation cancels working task; initiator may stop after losing maintainer status", async () => {
    const f = await fixture();
    await f.tick();
    await store.change(f.w.id, (w) => {
      present(present(w.coding).settings.repositories[0]).maintainers = ["202"];
    });
    await store.change(f.w.id, (w, sql) =>
      cancelDevelopment(sql, w, "101", f.task.id),
    );
    expect((await f.tick()).state).toBe("cancelled");
    expect(f.cancels).toHaveLength(1);
  });
  test("publication acknowledgement loss never repeats the POST", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({ state: "succeeded", tokens: 10, result: result() });
    await f.tick();
    await f.tick({
      state: "ready",
      tokens: 20,
      result: result({ status: "completed" }),
      checkPassed: true,
    });
    expect(
      (
        await f.tick({
          state: "ready",
          tokens: 20,
          result: result({ status: "completed" }),
          checkPassed: true,
        })
      ).state,
    ).toBe("unknown");
    expect(f.publications).toHaveLength(1);
  });
  test("current remote head is fetched and a closed PR is not recreated", async () => {
    const f = await fixture();
    await store.change(f.w.id, async (_w, sql) => {
      const t = await f.read();
      t.pr = {
        number: 43,
        url: "https://github.com/example/workspace/pull/43",
        branch: `codex/repodesk-${t.id}`,
        headSha: "a".repeat(40),
      };
      await taskSave(sql, t);
    });
    f.head("c".repeat(40));
    await f.tick();
    expect(f.starts[0]?.development?.pr?.headSha).toBe("c".repeat(40));
    const closed = await fixture();
    await store.change(closed.w.id, async (_w, sql) => {
      const t = await closed.read();
      t.pr = {
        number: 43,
        url: "https://github.com/example/workspace/pull/43",
        branch: `codex/repodesk-${t.id}`,
        headSha: "a".repeat(40),
      };
      await taskSave(sql, t);
    });
    closed.close();
    expect((await closed.tick()).error).toBe("coding_pr_closed");
    expect(closed.starts).toHaveLength(0);
  });
  test("soft deletion erases private relational content before remote cleanup", async () => {
    const f = await fixture();
    await f.tick();
    await store.change(f.w.id, async (w, sql) => {
      w.deletion = {
        requestedAt: new Date().toISOString(),
        providerState: "unknown",
      };
      await pruneDevelopment(sql, w);
    });
    expect(await taskInputs(store.pool, f.task)).toHaveLength(0);
    expect(
      JSON.stringify(
        (
          await store.pool.query(
            "SELECT data FROM coding_task_attempts WHERE workspace_id=$1",
            [f.w.id],
          )
        ).rows,
      ),
    ).not.toContain(original);
    await f.executor().tick(f.w.id);
    expect(f.erases).toHaveLength(1);
    await expect(f.read()).rejects.toThrow("not_found");
  });
  test("only current question replies and accepted-input edits bypass assistant routing", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({
      state: "succeeded",
      result: result({
        status: "needs_input",
        question: "How should empty pages behave?",
      }),
    });
    await store.change(f.w.id, (w) => {
      const notice = present(
        w.deliveries.find((d) => d.id.includes(":question:")),
      );
      notice.state = "sent";
      notice.remoteId = 19;
    });
    const message: Message = {
      message_id: 20,
      date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false },
      chat: { id: 101, type: "private" },
      message_thread_id: 3,
      reply_to_message: { message_id: 19 },
      text: "Also handle empty pages",
    };
    const route = (update: Update, msg: Message) =>
      store.change(f.w.id, (w, sql) =>
        routeDevelopment(sql, w, update, "999", msg, {
          name: "ask",
          args: msg.text ?? "",
        }),
      );
    // Forged or unconfirmed reply IDs and other audiences cannot bind a question.
    for (const unrelated of [
      { ...message, reply_to_message: undefined },
      { ...message, reply_to_message: { message_id: 9999 } },
      { ...message, message_thread_id: 4 },
      { ...message, from: { id: 303, is_bot: false } },
    ])
      expect(
        await route({ update_id: 20, message: unrelated }, unrelated),
      ).toBe(false);
    expect((await f.read()).revision).toBe(1);
    expect(await route({ update_id: 20, message }, message)).toBe(true);
    expect(await route({ update_id: 20, message }, message)).toBe(true);
    const edited = {
      ...message,
      text: "Keep original page numbering",
      reply_to_message: undefined,
    };
    expect(await route({ update_id: 21, edited_message: edited }, edited)).toBe(
      true,
    );
    expect((await f.read()).revision).toBe(3);
    expect((await taskInputs(store.pool, f.task)).map((i) => i.text)).toEqual([
      original,
      present(message.text),
      edited.text,
    ]);
    const lateReply = {
      ...message,
      message_id: 22,
      text: "Can you review it?",
    };
    expect(await route({ update_id: 22, message: lateReply }, lateReply)).toBe(
      false,
    );
    expect((await f.read()).revision).toBe(3);
  });
  test("ordinary follow-ups enter Pi in private and group Topics without resuming a Codex task", async () => {
    for (const chatId of ["101", "-100100"])
      for (const state of ["queued", "working", "review", "waiting"] as const) {
        const f = await fixture(original, chatId);
        await store.pool.query(
          chatId === "101"
            ? "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id"
            : "INSERT INTO chat_bindings(chat_id,workspace_id) VALUES('-100100',$1) ON CONFLICT(chat_id) DO UPDATE SET workspace_id=excluded.workspace_id",
          [f.w.id],
        );
        await store.change(f.w.id, async (w, sql) => {
          const task = await f.read();
          task.state = state;
          if (state === "waiting")
            task.question = {
              id: randomUUID(),
              text: "Which default page?",
              revision: 1,
            };
          await taskSave(sql, task);
          const notice = present(
            w.deliveries.find((d) => d.id === `development:${task.id}:started`),
          );
          notice.state = "sent";
          notice.remoteId = 19;
        });
        // The shared topic, an old task reply and even a new coding goal all need Pi's intent decision.
        const texts = [
          "Can you review it?",
          "Explain what changed",
          "Thanks",
          "Fix sorting in a different feature",
        ];
        const ingress = new Ingress(store, {} as SetupService);
        for (const [index, text] of texts.entries()) {
          const message: Message = {
            message_id: 20 + index,
            date: Math.floor(Date.now() / 1000),
            from: { id: 101, is_bot: false },
            chat: {
              id: Number(chatId),
              type: chatId === "101" ? "private" : "supergroup",
            },
            message_thread_id: 3,
            reply_to_message:
              chatId === "101" && index % 2 === 0
                ? undefined
                : { message_id: 19, from: { id: 999, is_bot: true } },
            text,
          };
          const update = {
            update_id:
              10000 +
              texts.length *
                (["queued", "working", "review", "waiting"].indexOf(state) +
                  (chatId === "101" ? 0 : 4)) +
              index,
            message,
          };
          await ingress.accept(update);
          await ingress.accept(update);
        }
        if (chatId !== "101")
          await ingress.accept({
            update_id:
              20000 + ["queued", "working", "review", "waiting"].indexOf(state),
            message: {
              message_id: 30,
              date: Math.floor(Date.now() / 1000),
              from: { id: 101, is_bot: false },
              chat: { id: Number(chatId), type: "supergroup" },
              message_thread_id: 3,
              text: "An unrelated comment to a teammate",
            },
          });
        const w = await store.read(f.w.id);
        expect(w.runs.slice(1).map((r) => r.task)).toEqual(texts);
        expect(w.runs.slice(1).every((r) => !r.codingTaskId)).toBe(true);
        expect((await f.read()).revision).toBe(1);
        expect(await taskInputs(store.pool, f.task)).toHaveLength(1);
        expect(
          w.deliveries.some((d) => d.id.startsWith("development:selection:")),
        ).toBe(false);
      }
  });
  test("Pi can explicitly continue the same task with original inputs and a recorded handoff", async () => {
    const f = await fixture();
    const pr = {
      number: 43,
      url: "https://github.com/example/workspace/pull/43",
      branch: `codex/repodesk-${f.task.id}`,
      headSha: "a".repeat(40),
    };
    await store.change(f.w.id, async (_w, sql) => {
      const task = await f.read();
      task.state = "review";
      task.pr = pr;
      await taskSave(sql, task);
    });
    const run = await store.change(f.w.id, (w) => {
      const run = createRun(
        w,
        "101",
        "Also handle empty pages",
        "101",
        3,
        "gpt-4.1-mini",
        { replyTo: 20, botId: "999" },
      );
      run.status = "running";
      return structuredClone(run);
    });
    const w = await store.read(f.w.id);
    const source = present(
      w.messages.find((s) => s.runId === run.id && s.role === "user"),
    );
    const input: AgentInput = {
      workspaceId: w.id,
      actor: "101",
      runId: run.id,
      model: selectedModel("gpt-4.1-mini"),
      apiKey: "fixture",
      system: "",
      prompt: "",
      transcript: [],
      tools: [],
      maxTurns: 2,
      maxTools: 3,
      signal: new AbortController().signal,
      guard: async () => {},
      reserve: async () => "attempt",
      checkpoint: async () => {},
    };
    const catalog = ExtensionCatalog.fromSnapshot(
      [],
      [codingExtension(store, w)],
    );
    const host = present(await catalog.open(input));
    try {
      const tool = present(
        host.tools.find((t) => t.name === "send_development_input"),
      );
      await tool.execute(
        "continue",
        { taskId: f.task.id, sourceId: source.id },
        input.signal,
      );
      await tool.execute(
        "duplicate",
        { taskId: f.task.id, sourceId: source.id },
        input.signal,
      );
      expect((await f.read()).revision).toBe(2);
      expect((await f.read()).pr).toEqual(pr);
      expect((await taskInputs(store.pool, f.task)).map((i) => i.text)).toEqual(
        [original, run.task],
      );
      expect(
        (await store.read(w.id)).runs.find((r) => r.id === run.id)
          ?.codingTaskId,
      ).toBe(f.task.id);
      await expect(
        tool.execute(
          "past-message",
          { taskId: f.task.id, sourceId: f.source.id },
          input.signal,
        ),
      ).rejects.toThrow("coding_current_request_required");
    } finally {
      await host.close();
    }
  });
  test("plain stop with multiple tasks preserves cancellation through task selection", async () => {
    const f = await fixture();
    await store.change(f.w.id, async (w, sql) => {
      const run = createRun(w, "101", "Fix sorting", "101", 3, "gpt-4.1-mini", {
        replyTo: 30,
        botId: "999",
      });
      run.status = "running";
      const source = present(
        w.messages.find((s) => s.runId === run.id && s.role === "user"),
      );
      await startDevelopment(sql, w, run.id, "101", 7001, [source.id], "999");
    });
    const message: Message = {
      message_id: 31,
      date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false },
      chat: { id: 101, type: "private" },
      message_thread_id: 3,
      text: "stop",
    };
    const conversation = { ...message, text: "Can you review it?" };
    expect(
      await store.change(f.w.id, (w, sql) =>
        routeDevelopment(
          sql,
          w,
          { update_id: 30, message: conversation },
          "999",
          conversation,
          { name: "ask", args: conversation.text },
        ),
      ),
    ).toBe(false);
    expect(
      await store.change(f.w.id, (w, sql) =>
        routeDevelopment(sql, w, { update_id: 31, message }, "999", message, {
          name: "ask",
          args: "stop",
        }),
      ),
    ).toBe(true);
    await store.change(f.w.id, (w) => {
      const selection = present(
        w.deliveries.find((d) => d.id === "development:selection:999:31"),
      );
      expect(selection.text).toBe("Which Codex task should stop?");
      expect(selection.buttons).toHaveLength(2);
      selection.state = "sent";
      selection.remoteId = 40;
    });
    await store.change(f.w.id, (w, sql) =>
      selectDevelopment(
        sql,
        w,
        {
          update_id: 32,
          callback_query: {
            id: "choice",
            from: { id: 101, is_bot: false },
            data: `devpick:${f.task.id}:31`,
            message: { ...message, message_id: 40 },
          },
        },
        "999",
      ),
    );
    expect((await f.read()).state).toBe("cancelled");
    expect((await f.read()).revision).toBe(1);
  });
  test("two workers reserve one attempt, and revocation during token minting denies start", async () => {
    const f = await fixture();
    await Promise.all([
      f.executor().advance(f.w.id, f.task.id),
      f.executor().advance(f.w.id, f.task.id),
    ]);
    expect(f.starts).toHaveLength(1);
    expect(
      (
        await store.pool.query(
          "SELECT id FROM coding_task_attempts WHERE workspace_id=$1 AND state='running'",
          [f.w.id],
        )
      ).rowCount,
    ).toBe(1);
    const revoked = await fixture();
    revoked.onToken(async () => {
      await store.change(revoked.w.id, (w) => {
        present(w.coding).revision++;
      });
    });
    expect((await revoked.tick()).error).toBe("coding_configuration_changed");
    expect(revoked.starts).toHaveLength(0);
  });
  test("group maintainers serialize their original inputs and private context is denied", async () => {
    const f = await fixture(original, "-100100");
    await Promise.all([
      f.append("Keep zero-based pages", "101"),
      f.append("Keep one-based pages", "202"),
    ]);
    const inputs = await taskInputs(store.pool, f.task);
    expect(inputs).toHaveLength(3);
    expect(inputs.map((i) => i.revision)).toEqual([1, 2, 3]);
    expect(new Set(inputs.slice(1).map((i) => i.actor))).toEqual(
      new Set(["101", "202"]),
    );
    await expect(
      store.change(f.w.id, async (w, sql) => {
        const source = { ...f.source, id: "private-context", chatId: "101" };
        w.messages.push(source);
        return appendDevelopment(
          sql,
          w,
          await taskGet(sql, w.id, f.task.id),
          "101",
          source,
          "private-input",
        );
      }),
    ).rejects.toThrow("coding_source_required");
  });
  test("read-only reconciliation confirms a lost publication without another write", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({ state: "succeeded", tokens: 10, result: result() });
    await f.tick();
    await f.tick({
      state: "ready",
      tokens: 20,
      result: result({ status: "completed" }),
      checkPassed: true,
    });
    f.confirmUnknown();
    const done = await f.tick({
      state: "unknown",
      tokens: 20,
      publishedSha: "b".repeat(40),
      error: "coding_publication_unknown",
    });
    expect(done.state).toBe("review");
    expect(done.pr?.number).toBe(43);
    expect(f.publications).toHaveLength(1);
  });
  async function configureDevice(f: Awaited<ReturnType<typeof fixture>>) {
    let connected = true;
    const runner = f.runner as LocalRunner & LocalDeviceAuth;
    runner.deviceStatus = async () => ({
      state: connected ? "connected" : "auth_required",
    });
    await store.change(f.w.id, async (w, sql) => {
      present(w.coding).settings.authMode = "device_code";
      const task = await taskGet(sql, w.id, f.task.id);
      task.payload.authMode = "device_code";
      await taskSave(sql, task);
    });
    return {
      runner,
      connect: (value: boolean) => {
        connected = value;
      },
    };
  }
  for (const visibility of ["private", "public"]) {
    test(`account-auth direct tasks use the connected GitHub App for ${visibility} repositories`, async () => {
      const f = await fixture();
      await configureDevice(f);
      if (visibility === "public") await f.makePublic();
      expect((await f.tick()).state).toBe("working");
      expect(f.starts).toHaveLength(1);
      expect(f.starts[0]?.readToken).toBe("ghs_fixture_installation_secret");
      expect(f.starts[0]?.payload.authMode).toBe("device_code");
      await f.tick();
      expect(f.starts).toHaveLength(1);
    });
  }
  test("missing account pauses before reservation and reconnect queues without another confirmation", async () => {
    const f = await fixture();
    const device = await configureDevice(f);
    device.connect(false);
    expect((await f.tick()).state).toBe("auth_required");
    expect((await f.read()).attempts).toBe(0);
    expect(f.starts).toHaveLength(0);
    await f.tick();
    expect((await f.read()).authPauses).toBe(1);
    device.connect(true);
    expect((await f.tick()).state).toBe("queued");
    expect((await f.tick()).state).toBe("working");
    expect(f.starts).toHaveLength(1);
  });
  test("auth pause survives executor restart, deduplicates notices and excludes wait from task budget", async () => {
    const f = await fixture();
    const device = await configureDevice(f);
    await f.tick();
    const attempt = present((await f.read()).attemptId);
    device.connect(false);
    const paused = await f.tick({
      state: "auth_required",
      tokens: 7,
      error: "coding_device_auth_required",
    });
    expect(paused.state).toBe("auth_required");
    await f.tick();
    const notices = await store.pool.query(
      "SELECT id FROM outbox WHERE workspace_id=$1 AND target_id LIKE '%auth-required:%'",
      [f.w.id],
    );
    expect(notices.rows).toHaveLength(1);
    await f.append("Also cover empty pages");
    expect((await f.read()).state).toBe("auth_required");
    await store.change(f.w.id, async (_w, sql) => {
      const task = await f.read();
      task.authPausedAt = new Date(
        Date.parse(present(task.authPausedAt)) - 7200000,
      ).toISOString();
      await taskSave(sql, task);
      await sql.query(
        "UPDATE coding_task_attempts SET data=jsonb_set(data,'{startedAt}',to_jsonb((data->>'startedAt')::bigint-7200000)) WHERE workspace_id=$1 AND id=$2",
        [task.workspaceId, attempt],
      );
    });
    let resumes = 0;
    device.runner.resumeAuth = async () => {
      resumes++;
      throw new Fault("coding_outcome_unknown", 503);
    };
    device.connect(true);
    await f.tick();
    expect((await f.read()).state).toBe("auth_required");
    expect((await f.tick({ state: "running" })).state).toBe("working");
    expect(resumes).toBe(1);
    expect(f.starts).toHaveLength(1);
    const completed = await f.tick({
      state: "succeeded",
      result: result(),
      tokens: 30,
    });
    expect(completed.state).toBe("queued");
    expect(completed.tokens).toBe(30);
    expect(completed.activeMs).toBeLessThan(5000);
  });
  test("Stop and permission revocation cancel an auth-paused runner before reconnect", async () => {
    for (const revoke of [false, true]) {
      const f = await fixture();
      const device = await configureDevice(f);
      await f.tick();
      device.connect(false);
      await f.tick({ state: "auth_required", tokens: 7 });
      await store.change(f.w.id, async (w, sql) => {
        if (revoke)
          present(w.members.find((m) => m.id === "101")).active = false;
        else await cancelDevelopment(sql, w, "101", f.task.id);
      });
      device.connect(true);
      let resumes = 0;
      device.runner.resumeAuth = async () => {
        resumes++;
      };
      expect((await f.tick()).state).toBe("cancelled");
      expect(resumes).toBe(0);
      expect(f.cancels).toHaveLength(1);
    }
  });
  test("permissions changed during auth-resume token minting prevent restarted code", async () => {
    const f = await fixture();
    const device = await configureDevice(f);
    await f.tick();
    device.connect(false);
    await f.tick({ state: "auth_required", tokens: 7 });
    device.connect(true);
    let resumes = 0;
    device.runner.resumeAuth = async () => {
      resumes++;
    };
    f.onToken(() =>
      store.change(f.w.id, (w) => {
        present(w.members.find((m) => m.id === "101")).active = false;
      }),
    );
    await f.tick();
    expect(resumes).toBe(0);
    expect(f.cancels).toHaveLength(1);
  });
  test("a connected repository made public during auth wait resumes with account credentials", async () => {
    const f = await fixture();
    const device = await configureDevice(f);
    await f.tick();
    device.connect(false);
    await f.tick({ state: "auth_required", tokens: 7 });
    await f.makePublic();
    device.connect(true);
    let resumes = 0;
    device.runner.resumeAuth = async () => {
      resumes++;
    };
    expect((await f.tick()).state).toBe("working");
    expect(resumes).toBe(1);
    expect(f.cancels).toHaveLength(0);
    expect(f.starts[0]?.readToken).toBe("ghs_fixture_installation_secret");
  });
  async function telegramProgressFixture() {
    const f = await fixture();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let failure: TelegramError | undefined;
    let onEdit: (() => Promise<void>) | undefined;
    const setup = {
      client: async () => ({
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === "editMessageText") await onEdit?.();
          if (failure) throw failure;
          return {
            message_id:
              900 + calls.filter((c) => c.method === "sendMessage").length,
          };
        },
      }),
    } as unknown as SetupService;
    const worker = new DeliveryWorker(store, setup);
    const acknowledgement = present(
      (await store.read(f.w.id)).deliveries.at(-1),
    );
    await worker.send(f.w.id, acknowledgement.id);
    await f.tick();
    let now = Date.now();
    const progress = async (stage: string, cycle = "1") => {
      now += 10000;
      await store.change(f.w.id, async (w, sql) => {
        const t = await taskGet(sql, w.id, f.task.id);
        t.state = "working";
        recordProgress(w, t, "development", stage, cycle, now);
        await taskSave(sql, t);
      });
      return present((await store.read(f.w.id)).deliveries.at(-1));
    };
    return {
      ...f,
      calls,
      worker,
      acknowledgement,
      progress,
      fail: (error?: TelegramError) => {
        failure = error;
      },
      onEdit: (callback?: () => Promise<void>) => {
        onEdit = callback;
      },
    };
  }
  test("accepted task, checks and repairs edit one message; a necessary question is new", async () => {
    const f = await telegramProgressFixture();
    for (const [stage, cycle] of [
      ["check", "1"],
      ["repair", "2"],
      ["check", "2"],
    ]) {
      const d = await f.progress(present(stage), present(cycle));
      await f.worker.send(f.w.id, d.id);
      await f.worker.send(f.w.id, d.id);
    }
    expect(f.calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageText",
      "editMessageText",
    ]);
    for (const call of f.calls.slice(1)) {
      expect(call.params.message_id).toBe(901);
      expect(call.params.message_thread_id).toBeUndefined();
      expect(call.params.reply_markup).toMatchObject({
        inline_keyboard: [[{ text: "Status" }, { text: "Cancel" }]],
      });
    }
    await f.tick();
    await f.tick({
      state: "succeeded",
      result: result({
        status: "needs_input",
        question: "Which page should be the default?",
      }),
      tokens: 2,
    });
    for (const d of (await store.read(f.w.id)).deliveries)
      if (d.state === "pending") await f.worker.send(f.w.id, d.id);
    expect(f.calls.at(-1)?.method).toBe("sendMessage");
    expect(f.calls.at(-1)?.params.text).toContain("Which page");
    const closed = f.calls.find(
      (c) => c.params.text === "I’m waiting for your answer.",
    );
    expect(closed?.method).toBe("editMessageText");
    expect(closed?.params.reply_markup).toEqual({ inline_keyboard: [] });
  });
  test("uncertain edits retry the same message; already applied edits succeed", async () => {
    const f = await telegramProgressFixture();
    const d = await f.progress("check");
    f.fail(new TelegramError("telegram_outcome_unknown", "unknown"));
    await f.worker.send(f.w.id, d.id);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.state).toBe("pending");
    await store.change(f.w.id, (w) => {
      present(w.deliveries.at(-1)).nextAt = new Date(0).toISOString();
    });
    f.fail(new TelegramError("telegram_message_not_modified", "permanent"));
    await f.worker.send(f.w.id, d.id);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.state).toBe("sent");
    expect(f.calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageText",
    ]);
    expect(f.calls.slice(1).map((c) => c.params.message_id)).toEqual([
      901, 901,
    ]);
  });
  test("a deleted message gets one replacement, then subsequent progress edits the replacement", async () => {
    const f = await telegramProgressFixture();
    const d = await f.progress("check");
    f.fail(new TelegramError("telegram_message_uneditable", "permanent"));
    await f.worker.send(f.w.id, d.id);
    f.fail();
    await f.worker.send(f.w.id, d.id);
    const repair = await f.progress("repair", "2");
    await f.worker.send(f.w.id, repair.id);
    expect(f.calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "sendMessage",
      "editMessageText",
    ]);
    expect(f.calls.at(-1)?.params.message_id).toBe(902);
  });
  test("uncertain original sends never create a replacement progress message", async () => {
    const f = await telegramProgressFixture();
    await store.change(f.w.id, (w) => {
      const d = present(
        w.deliveries.find((d) => d.id === f.acknowledgement.id),
      );
      d.state = "delivery_unknown";
      d.remoteId = undefined;
    });
    const d = await f.progress("check");
    await f.worker.send(f.w.id, d.id);
    expect(f.calls).toHaveLength(1);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.state).toBe(
      "delivery_unknown",
    );
  });
  test("progress waits for an in-flight original send and uses its confirmed message", async () => {
    const f = await telegramProgressFixture();
    await store.change(f.w.id, (w) => {
      const anchor = present(
        w.deliveries.find((d) => d.id === f.acknowledgement.id),
      );
      anchor.state = "sending";
      anchor.remoteId = undefined;
      anchor.startedAt = new Date().toISOString();
    });
    const d = await f.progress("check");
    await f.worker.send(f.w.id, d.id);
    expect(f.calls).toHaveLength(1);
    await store.change(f.w.id, (w) => {
      const anchor = present(
        w.deliveries.find((d) => d.id === f.acknowledgement.id),
      );
      anchor.state = "sent";
      anchor.remoteId = 901;
    });
    await f.worker.send(f.w.id, d.id);
    expect(f.calls.at(-1)?.method).toBe("editMessageText");
    expect(f.calls.at(-1)?.params.message_id).toBe(901);
  });
  test("later confirmed edits remain reusable after the original delivery expires", async () => {
    const f = await telegramProgressFixture();
    const check = await f.progress("check");
    await f.worker.send(f.w.id, check.id);
    await store.change(f.w.id, (w) => {
      w.deliveries = w.deliveries.filter((d) => d.id !== f.acknowledgement.id);
    });
    const repair = await f.progress("repair", "2");
    await f.worker.send(f.w.id, repair.id);
    expect(f.calls.at(-1)?.method).toBe("editMessageText");
    expect(f.calls.at(-1)?.params.message_id).toBe(901);
    expect(f.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
  test("task edits serialize across workers and stale progress is suppressed", async () => {
    const f = await telegramProgressFixture();
    const d = await f.progress("check");
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.onEdit(async () => {
      entered();
      await blocked;
    });
    const first = f.worker.send(f.w.id, d.id);
    await started;
    const obsolete = await f.progress("repair", "2");
    const latest = await f.progress("check", "2");
    await new DeliveryWorker(store, {
      client: async () => {
        throw Error("Concurrent edit");
      },
    } as unknown as SetupService).send(f.w.id, latest.id);
    expect(f.calls).toHaveLength(2);
    release();
    await first;
    f.onEdit();
    await f.worker.send(f.w.id, obsolete.id);
    await f.worker.send(f.w.id, latest.id);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.at(-1)?.params.text).toContain("running the checks");
  });
  test("edit recovery after a worker crash keeps the known remote message", async () => {
    const f = await telegramProgressFixture();
    const d = await f.progress("check");
    await store.change(f.w.id, (w) => {
      const pending = present(w.deliveries.find((t) => t.id === d.id));
      pending.state = "sending";
      pending.startedAt = new Date(Date.now() - 31000).toISOString();
      pending.attempts = 1;
    });
    await f.worker.send(f.w.id, d.id);
    await f.worker.send(f.w.id, d.id);
    expect(f.calls.at(-1)?.method).toBe("editMessageText");
    expect(f.calls.at(-1)?.params.message_id).toBe(901);
  });
  test("rate limited edits honor the retry time; permanent failures do not resend", async () => {
    const f = await telegramProgressFixture();
    const d = await f.progress("check");
    f.fail(new TelegramError("telegram_rate_limited", "retry", 60));
    await f.worker.send(f.w.id, d.id);
    await f.worker.send(f.w.id, d.id);
    expect(f.calls).toHaveLength(2);
    await store.change(f.w.id, (w) => {
      present(w.deliveries.at(-1)).nextAt = new Date(0).toISOString();
    });
    f.fail(new TelegramError("telegram_destination_rejected", "permanent"));
    await f.worker.send(f.w.id, d.id);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.state).toBe("failed");
    expect(f.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
  });
  test("editing rechecks actor, topic, task and bot bindings before external writes", async () => {
    for (const boundary of [
      "actor",
      "topic",
      "task",
      "bot",
      "revoked",
    ] as const) {
      const f = await telegramProgressFixture();
      const d = await f.progress("check");
      await store.change(f.w.id, (w) => {
        const anchor = present(
          w.deliveries.find((t) => t.id === f.acknowledgement.id),
        );
        if (boundary === "actor") anchor.actor = "202";
        if (boundary === "topic") anchor.topicId++;
        if (boundary === "task")
          anchor.progressMessage = { owner: "development", id: randomUUID() };
        if (boundary === "bot") anchor.botId = "1000";
        if (boundary === "revoked")
          present(w.members.find((m) => m.id === "101")).active = false;
      });
      await f.worker.send(f.w.id, d.id);
      expect(f.calls).toHaveLength(1);
      expect((await store.read(f.w.id)).deliveries.at(-1)?.state).toBe(
        "cancelled",
      );
    }
  });
  test("runner stages survive polling and obsolete progress cannot publish after a question", async () => {
    const f = await fixture();
    await f.tick();
    await f.tick({ state: "running", phase: "setup" });
    const first = await store.read(f.w.id);
    const progress = present(
      first.deliveries.find((d) => d.feedback?.key.endsWith(":setup")),
    );
    expect((await f.read()).progress?.stage).toBe("setup");
    await f.tick();
    expect(
      (await store.read(f.w.id)).deliveries.filter((d) => d.id === progress.id),
    ).toHaveLength(1);
    await f.tick({
      state: "succeeded",
      result: result({
        status: "needs_input",
        question: "Which page should be the default?",
      }),
      tokens: 2,
    });
    expect(
      (await store.read(f.w.id)).deliveries.find((d) => d.id === progress.id)
        ?.state,
    ).toBe("cancelled");
    let sends = 0;
    const setup = {
      client: async () => ({
        call: async () => {
          sends++;
          return { message_id: 900 };
        },
      }),
    } as unknown as SetupService;
    await new DeliveryWorker(store, setup).send(f.w.id, progress.id);
    expect(sends).toBe(0);
    expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
      "Reply here to continue",
    );
  });
  test("working cancellation confirms stop after the runner acknowledges and status stays readable", async () => {
    const f = await fixture();
    await f.tick();
    await store.change(f.w.id, (w, sql) =>
      cancelDevelopment(sql, w, "101", f.task.id),
    );
    expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
      "Stopping",
    );
    expect((await f.read()).state).toBe("working");
    await f.tick();
    expect((await f.read()).state).toBe("cancelled");
    expect(f.cancels).toHaveLength(1);
    let sends = 0;
    const setup = {
      client: async () => ({
        call: async () => {
          sends++;
          return { message_id: 901 };
        },
      }),
    } as unknown as SetupService;
    const stopped = present(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === `development:${f.task.id}:cancel:stopped`,
      ),
    );
    await new DeliveryWorker(store, setup).send(f.w.id, stopped.id);
    await new DeliveryWorker(store, setup).send(f.w.id, stopped.id);
    expect(sends).toBe(1);
  });
  test("task selection retains cancellation intent and rejects another actor or topic", async () => {
    const f = await fixture();
    const second = await store.change(f.w.id, async (w, sql) => {
      const run = createRun(
        w,
        "101",
        "Fix another page",
        "101",
        3,
        "gpt-4.1-mini",
        { replyTo: 20, botId: "999" },
      );
      run.status = "running";
      const source = present(
        w.messages.find((s) => s.runId === run.id && s.role === "user"),
      );
      return startDevelopment(sql, w, run.id, "101", 7001, [source.id], "999");
    });
    const msg: Message = {
      message_id: 800,
      date: Math.floor(Date.now() / 1000),
      from: { id: 101, is_bot: false },
      chat: { id: 101, type: "private" },
      message_thread_id: 3,
      text: "/cancel",
    };
    await store.change(f.w.id, (w, sql) =>
      taskControl(sql, w, { update_id: 800, message: msg }, "999", msg, {
        name: "cancel",
        args: "",
      }),
    );
    const selection = present(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === "control:999:800",
      ),
    );
    const button = present(
      selection.buttons
        ?.flat()
        .find((b) => b.callback_data.includes(f.task.id)),
    );
    await store.change(f.w.id, (w) => {
      const d = present(w.deliveries.find((d) => d.id === selection.id));
      d.state = "sent";
      d.remoteId = 810;
    });
    const statusMsg = { ...msg, message_id: 802, text: "/status" };
    await store.change(f.w.id, (w, sql) =>
      taskControl(
        sql,
        w,
        { update_id: 802, message: statusMsg },
        "999",
        statusMsg,
        { name: "status", args: "" },
      ),
    );
    await store.change(f.w.id, (w) => {
      present(present(w.coding).settings.repositories[0]).maintainers = ["202"];
    });
    let revokedSends = 0;
    const revokedSetup = {
      client: async () => ({
        call: async () => {
          revokedSends++;
          return { message_id: 903 };
        },
      }),
    } as unknown as SetupService;
    await new DeliveryWorker(store, revokedSetup).send(
      f.w.id,
      "control:999:802",
    );
    expect(revokedSends).toBe(0);
    expect(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === "control:999:802",
      )?.state,
    ).toBe("cancelled");
    const callback = {
      update_id: 811,
      callback_query: {
        id: "callback",
        from: { id: 101, is_bot: false },
        data: button.callback_data,
        message: { ...msg, message_id: 810 },
      },
    };
    await expect(
      store.change(f.w.id, (w, sql) =>
        selectTaskControl(
          sql,
          w,
          {
            ...callback,
            callback_query: {
              ...callback.callback_query,
              from: { id: 202, is_bot: false },
            },
          },
          "999",
        ),
      ),
    ).rejects.toThrow("access_denied");
    await expect(
      store.change(f.w.id, (w, sql) =>
        selectTaskControl(
          sql,
          w,
          {
            ...callback,
            callback_query: {
              ...callback.callback_query,
              message: { ...msg, message_id: 810, message_thread_id: 4 },
            },
          },
          "999",
        ),
      ),
    ).rejects.toThrow("access_denied");
    await store.change(f.w.id, (w, sql) =>
      selectTaskControl(sql, w, callback, "999"),
    );
    await store.change(f.w.id, (w, sql) =>
      selectTaskControl(sql, w, callback, "999"),
    );
    expect((await f.read()).state).toBe("cancelled");
    expect((await taskGet(store.pool, f.w.id, second.id)).cancelRequested).toBe(
      false,
    );
    expect(await taskInputs(store.pool, await f.read())).toHaveLength(1);
    expect(
      (await store.read(f.w.id)).deliveries.filter(
        (d) => d.id === `development:${f.task.id}:cancel:stopped`,
      ),
    ).toHaveLength(1);
  });
  test("inline Status and Cancel survive long tasks, acknowledge taps and deduplicate updates", async () => {
    const f = await fixture();
    const started = present(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === `development:${f.task.id}:started`,
      ),
    );
    expect(started.text).not.toMatch(/\/status|\/cancel/);
    const buttons = present(started.buttons?.[0]);
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const setup = {
      client: async () => ({
        call: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          return { message_id: 1900 };
        },
      }),
    } as unknown as SetupService;
    await new DeliveryWorker(store, setup).send(f.w.id, started.id);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.params.reply_markup).toEqual({
      inline_keyboard: started.buttons,
    });
    expect(
      (await store.read(f.w.id)).deliveries.find((d) => d.id === started.id)
        ?.botId,
    ).toBe("999");
    await store.pool.query(
      "INSERT INTO telegram_selections(actor,workspace_id) VALUES('101',$1) ON CONFLICT(actor) DO UPDATE SET workspace_id=excluded.workspace_id",
      [f.w.id],
    );
    await f.tick();
    await f.tick({ state: "running", phase: "implement" });
    await store.change(f.w.id, (w) => {
      present(w.deliveries.find((d) => d.id === started.id)).at = new Date(
        Date.now() - 1800000,
      ).toISOString();
    });
    const update = (id: number, data: string): Update => ({
      update_id: id,
      callback_query: {
        id: `inline-${id}`,
        from: { id: 101, is_bot: false },
        data,
        message: {
          message_id: 1900,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 101, type: "private" },
          message_thread_id: 3,
        },
      },
    });
    const ingress = new Ingress(store, setup);
    const status = update(
      9200,
      present(buttons.find((b) => b.text === "Status")).callback_data,
    );
    await ingress.accept(status);
    await ingress.accept(status);
    const statuses = (await store.read(f.w.id)).deliveries.filter(
      (d) => d.id === `development:${f.task.id}:status:9200`,
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.text).toContain("investigating");
    expect(statuses[0]?.text).not.toContain("Reference:");
    expect(
      calls.filter((c) => c.method === "answerCallbackQuery"),
    ).toHaveLength(2);
    const stop = present(
      buttons.find((b) => b.text === "Cancel"),
    ).callback_data;
    await ingress.accept(update(9201, stop));
    await ingress.accept(update(9202, stop));
    expect((await f.read()).cancelRequested).toBe(true);
    expect(
      (await store.read(f.w.id)).deliveries.filter(
        (d) => d.id === `development:${f.task.id}:cancel:requested`,
      ),
    ).toHaveLength(1);
    await f.tick();
    expect((await f.read()).state).toBe("cancelled");
    expect(f.cancels).toHaveLength(1);
    await ingress.accept(
      update(
        9203,
        present(buttons.find((b) => b.text === "Status")).callback_data,
      ),
    );
    const stopped = present(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === `development:${f.task.id}:status:9203`,
      ),
    );
    expect(stopped.text).toContain("has stopped");
    expect(stopped.buttons?.[0]?.map((b) => b.text)).toEqual(["Status"]);
    expect(await taskInputs(store.pool, await f.read())).toHaveLength(1);
  });
  test("inline controls bind sent messages to actor, bot, workspace and topic and recheck access", async () => {
    const f = await fixture();
    const started = present(
      (await store.read(f.w.id)).deliveries.find(
        (d) => d.id === `development:${f.task.id}:started`,
      ),
    );
    await store.change(f.w.id, (w) => {
      Object.assign(present(w.deliveries.find((d) => d.id === started.id)), {
        state: "sent",
        botId: "999",
        remoteId: 1930,
      });
    });
    const callback = {
      id: "bound-inline",
      from: { id: 101, is_bot: false },
      data: present(started.buttons?.[0]?.[0]).callback_data,
      message: {
        message_id: 1930,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 101, type: "private" as const },
        message_thread_id: 3,
      },
    };
    const select = (
      patch: Partial<typeof callback> = {},
      botId = "999",
      workspaceId = f.w.id,
    ) =>
      store.change(workspaceId, (w, sql) =>
        selectTaskControl(
          sql,
          w,
          { update_id: 9300, callback_query: { ...callback, ...patch } },
          botId,
        ),
      );
    await expect(select({ from: { id: 202, is_bot: false } })).rejects.toThrow(
      "access_denied",
    );
    await expect(select({ from: { id: 101, is_bot: true } })).rejects.toThrow(
      "access_denied",
    );
    await expect(
      select({ message: { ...callback.message, message_id: 1931 } }),
    ).rejects.toThrow("access_denied");
    await expect(
      select({ message: { ...callback.message, message_thread_id: 4 } }),
    ).rejects.toThrow("access_denied");
    await expect(
      select({
        message: { ...callback.message, chat: { id: 202, type: "private" } },
      }),
    ).rejects.toThrow("access_denied");
    await expect(select({}, "998")).rejects.toThrow("access_denied");
    await expect(select({ data: `tdc:${randomUUID()}` })).rejects.toThrow(
      "access_denied",
    );
    const other = await fixture();
    await expect(select({}, "999", other.w.id)).rejects.toThrow(
      "access_denied",
    );
    await store.change(f.w.id, (w) => {
      present(w.deliveries.find((d) => d.id === started.id)).state =
        "delivery_unknown";
    });
    await expect(select()).rejects.toThrow("access_denied");
    await store.change(f.w.id, (w) => {
      present(w.deliveries.find((d) => d.id === started.id)).state = "sent";
      present(present(w.coding).settings.repositories[0]).maintainers = ["202"];
    });
    await expect(select()).rejects.toThrow();
    // The initiator retains cancellation authority when their maintainer grant is removed.
    await select({ data: present(started.buttons?.[0]?.[1]).callback_data });
    expect((await f.read()).state).toBe("cancelled");
    expect(
      (await taskGet(store.pool, other.w.id, other.task.id)).cancelRequested,
    ).toBe(false);
  });
  test("missing runner records cannot falsely confirm cancellation", async () => {
    const f = await fixture();
    await f.tick();
    f.runner.cancel = async () => {
      throw new Fault("coding_task_not_found", 404);
    };
    await store.change(f.w.id, (w, sql) =>
      cancelDevelopment(sql, w, "101", f.task.id),
    );
    await f.tick();
    expect((await f.read()).state).toBe("unknown");
    const text = (await store.read(f.w.id)).deliveries.at(-1)?.text;
    expect(text).toContain("couldn’t confirm");
    expect(text).not.toContain("has stopped");
  });
  test("Pi handoff cannot announce that queued Codex implementation has finished", async () => {
    const f = await fixture();
    let completionPreview = false;
    const setup = {
      client: async () => ({
        call: async (method: string) => {
          if (method === "sendRichMessageDraft") completionPreview = true;
          return { message_id: 902 };
        },
      }),
      modelKey: async () => "fixture",
    } as unknown as SetupService;
    await new Executor(store, setup, {
      run: async (input) => {
        await input.preview?.(
          "Implementation finished and every check passed.",
        );
        return {
          status: "succeeded",
          text: "Implementation finished and every check passed.",
          turns: 0,
          tools: 0,
          transcript: [],
        };
      },
    }).execute(f.w.id, f.run.id);
    const w = await store.read(f.w.id);
    expect(w.runs.find((r) => r.id === f.run.id)?.result).toContain(
      "queued for Codex",
    );
    expect(w.deliveries.some((d) => d.id === `run:${f.run.id}:result`)).toBe(
      false,
    );
    expect(
      w.deliveries.some((d) => d.text.includes("every check passed")),
    ).toBe(false);
    expect(completionPreview).toBe(false);
  });
  test("feedback delivery uses the current transaction even with a single database connection", async () => {
    const f = await fixture();
    const parsed = new URL(present(url));
    parsed.pathname = `/${dbName}`;
    const solo = new Store(
      new Pool({
        connectionString: parsed.toString(),
        max: 1,
        connectionTimeoutMillis: 1000,
      }),
    );
    let sends = 0;
    const setup = {
      client: async () => ({
        call: async () => {
          sends++;
          return { message_id: 904 };
        },
      }),
    } as unknown as SetupService;
    try {
      await new DeliveryWorker(solo, setup).send(
        f.w.id,
        `development:${f.task.id}:started`,
      );
      expect(sends).toBe(1);
      expect(
        (await solo.read(f.w.id)).deliveries.find(
          (d) => d.id === `development:${f.task.id}:started`,
        )?.state,
      ).toBe("sent");
    } finally {
      await solo.pool.end();
    }
  });
  test("native Stop reaches the linked coding task even after the Pi handoff completes", async () => {
    for (const working of [false, true]) {
      const f = await fixture();
      if (working) await f.tick();
      const setup = {
        client: async () => ({ call: async () => ({ message_id: 905 }) }),
        modelKey: async () => "fixture",
      } as unknown as SetupService;
      await new Executor(store, setup, {
        run: async () => ({
          status: "succeeded",
          text: "Queued",
          turns: 0,
          tools: 0,
          transcript: [],
        }),
      }).execute(f.w.id, f.run.id);
      const run = present(
        (await store.read(f.w.id)).runs.find((r) => r.id === f.run.id),
      );
      const draft = present(run.telegramDraft);
      await transaction(store.pool, (sql) =>
        stopGeneration(store, sql, "999", {
          chat: { id: 101, type: "private" },
          message_thread_id: 3,
          draft_id: draft.id,
        }),
      );
      expect((await f.read()).cancelRequested).toBe(true);
      await f.tick();
      expect((await f.read()).state).toBe("cancelled");
      expect(f.cancels).toHaveLength(working ? 1 : 0);
      expect(
        (await store.read(f.w.id)).deliveries.filter(
          (d) => d.cancellationRunId === f.run.id,
        ),
      ).toHaveLength(0);
    }
  });
  test("a failed Pi response reports the handoff without claiming the coding task failed", async () => {
    const f = await fixture();
    const setup = {
      client: async () => ({ call: async () => ({ message_id: 906 }) }),
      modelKey: async () => "fixture",
    } as unknown as SetupService;
    await new Executor(store, setup, {
      run: async () => {
        throw new Fault("provider_outcome_unknown", 503);
      },
    }).execute(f.w.id, f.run.id);
    expect((await f.read()).state).toBe("queued");
    expect((await store.read(f.w.id)).deliveries.at(-1)?.text).toContain(
      "handed to Codex",
    );
  });
});
