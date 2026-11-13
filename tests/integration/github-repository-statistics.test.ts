import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { PluginService } from "../../src/agent/plugin-service.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { GitHubMetadata } from "../../src/github/metadata.ts";
import { DeliveryWorker } from "../../src/jobs/delivery.ts";
import { Executor } from "../../src/jobs/execute.ts";
import { encrypt } from "../../src/setup/credentials.ts";
import { SetupService } from "../../src/setup/service.ts";
import type { Telegram } from "../../src/telegram/client.ts";
import { activateWorkflow, tick } from "../../src/workflows/service.ts";
import { grantGitHubAccess, spec } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";
import {
  fixtureValue,
  requestRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

const rootUrl = process.env.TEST_DATABASE_URL;
const args = { repositoryId: 7001, kind: "repository" };
const statistics = {
  id: 7001,
  full_name: "example/private",
  stargazers_count: 42,
  forks_count: 3,
  subscribers_count: 7,
  watchers_count: 42,
  html_url: "https://untrusted.invalid",
};

(rootUrl ? describe : describe.skip)("GitHub repository statistics", () => {
  const root = database(rootUrl ?? "postgres://unused@localhost/unused");
  const name = `repository_stats_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(rootUrl as string);
    url.pathname = `/${name}`;
    store = new Store(database(url.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'repository_stats','unused',true)",
      [operatorId],
    );
  });
  afterAll(async () => {
    await store?.pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  });
  async function seed(w = teamWorkspace(), r = requestRun(w)) {
    w.operatorId = operatorId;
    await store.pool.query(
      "INSERT INTO workspaces(id,operator_id,data) VALUES($1,$2,$3)",
      [w.id, operatorId, JSON.stringify(w)],
    );
    return { w, r };
  }
  function provider(
    response: unknown = statistics,
    during?: (url: URL) => Promise<void>,
  ) {
    const requests: { url: URL; init: RequestInit }[] = [];
    const app = new GitHubApp(githubFixtureConfig, (async (
      input,
      init = {},
    ) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      await during?.(url);
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json({
          token: "ghs_statistics_fixture",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      return response instanceof Response ? response : Response.json(response);
    }) as typeof fetch);
    return { app, requests, service: new GitHubMetadata(store, app) };
  }
  const read = (
    p: ReturnType<typeof provider>,
    f: Awaited<ReturnType<typeof seed>>,
    query: unknown = args,
    signal = new AbortController().signal,
  ) => p.service.repository(f.w.id, f.r.id, query, signal, async () => {});

  test.each([0, 42])(
    "reports %i stars and actual notification watchers with a repository-scoped Metadata-read token",
    async (stars) => {
      const f = await seed();
      const p = provider({ ...statistics, stargazers_count: stars });
      const result = await read(p, f);
      expect(result).toMatchObject({
        repositoryId: 7001,
        repository: "example/private",
        url: "https://github.com/example/private",
        kind: "repository",
        stars,
        forks: 3,
        watchers: 7,
      });
      expect(Number.isFinite(Date.parse(result.retrievedAt))).toBe(true);
      expect(result.coverage).toContain(
        "Historical counts and daily changes are not provided",
      );
      expect(JSON.stringify(result)).not.toMatch(/ghs_|untrusted/);
      expect(p.requests).toHaveLength(2);
      expect(JSON.parse(String(p.requests[0]?.init.body))).toEqual({
        repository_ids: [7001],
        permissions: { metadata: "read" },
      });
      expect(p.requests[1]?.url.href).toBe(
        "https://api.github.com/repos/example/private",
      );
      expect(p.requests[1]?.init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { authorization: "Bearer ghs_statistics_fixture" },
      });
      expect((await store.read(f.w.id)).runs[0]?.githubRead).toEqual({
        revision: 1,
        repositoryIds: [7001],
      });
    },
  );

  test.each([
    { number: 1 },
    { page: 1 },
    { state: "open" },
    { since: "2026-11-12T00:00:00Z" },
    { token: "forged" },
  ])(
    "repository queries reject irrelevant filters or credentials: %j",
    async (extra) => {
      const f = await seed();
      const p = provider();
      await expect(read(p, f, { ...args, ...extra })).rejects.toThrow();
      expect(p.requests).toHaveLength(0);
    },
  );

  test.each([
    [
      { ...statistics, stargazers_count: -1 },
      "github_repository_response_invalid",
    ],
    [{ ...statistics, forks_count: 0.5 }, "github_repository_response_invalid"],
    [
      { ...statistics, subscribers_count: undefined },
      "github_repository_response_invalid",
    ],
    [
      { ...statistics, stargazers_count: Number.MAX_SAFE_INTEGER + 1 },
      "github_repository_response_invalid",
    ],
    [{ ...statistics, id: 7002 }, "github_repository_response_mismatch"],
    [
      { ...statistics, full_name: "other/repository" },
      "github_repository_response_mismatch",
    ],
  ])(
    "rejects invalid or mismatched upstream repository statistics: %j",
    async (response, code) => {
      const f = await seed();
      await expect(read(provider(response), f)).rejects.toThrow(code);
    },
  );

  test.each([
    "unselected",
    "private group",
    "inactive",
    "stale permissions",
    "other workspace",
  ])("denies %s before contacting GitHub", async (scenario) => {
    const w = teamWorkspace();
    const r = requestRun(
      w,
      "101",
      scenario === "private group" ? "-100100" : "101",
    );
    if (scenario === "inactive") fixtureValue(w.members[0]).active = false;
    if (scenario === "stale permissions")
      fixtureValue(fixtureValue(w.members[0]).github).syncedAt =
        "2000-01-01T00:00:00Z";
    const f = await seed(w, r);
    if (scenario === "other workspace") f.w = teamWorkspace();
    const p = provider();
    await expect(
      read(p, f, {
        ...args,
        repositoryId: scenario === "unselected" ? 9999 : 7001,
      }),
    ).rejects.toThrow();
    expect(p.requests).toHaveLength(0);
  });

  test.each(["token", "response"])(
    "rechecks revocation after the %s step",
    async (stage) => {
      const f = await seed();
      const p = provider(statistics, async (url) => {
        if ((stage === "token") === url.pathname.endsWith("/access_tokens"))
          await store.change(f.w.id, (w) => {
            fixtureValue(w.members.find((m) => m.id === "101")).active = false;
          });
      });
      await expect(read(p, f)).rejects.toThrow("tool_policy_denied");
      expect(p.requests).toHaveLength(stage === "token" ? 1 : 2);
    },
  );

  test.each([
    [403, "github_access_denied"],
    [503, "github_unavailable"],
    [429, "github_rate_limited"],
  ])(
    "HTTP %i remains a failure rather than zero counts",
    async (status, code) => {
      const f = await seed();
      await expect(
        read(provider(new Response("private upstream detail", { status })), f),
      ).rejects.toThrow(code);
    },
  );

  test("an aborted read does not mint a token", async () => {
    const f = await seed();
    const p = provider();
    const controller = new AbortController();
    controller.abort();
    await expect(read(p, f, args, controller.signal)).rejects.toThrow();
    expect(p.requests).toHaveLength(0);
  });

  test("a workflow cannot read a repository outside its saved sources", async () => {
    const w = teamWorkspace();
    const { workflow } = activateWorkflow(w, "101", {
      ...spec(w),
      chatId: "101",
      skillId: undefined,
      github: { revision: 1, repositoryIds: [7001] },
    });
    const now = new Date();
    workflow.nextAt = now.toISOString();
    tick(w, "gpt-4.1-mini", now);
    const r = fixtureValue(w.runs.at(-1));
    r.status = "running";
    const f = await seed(w, r);
    const p = provider();
    await expect(read(p, f, { ...args, repositoryId: 7002 })).rejects.toThrow(
      "github_workflow_source_denied",
    );
    expect(p.requests).toHaveLength(0);
  });

  test.each([false, true])(
    "a member's scheduled private Topic report survives restart and duplicate execution (revoked before delivery: %s)",
    async (revoke) => {
      const w = teamWorkspace();
      grantGitHubAccess(w, ["202"]);
      const now = new Date();
      const { workflow } = activateWorkflow(w, "202", {
        ...spec(w),
        chatId: "202",
        topicId: 7,
        skillId: undefined,
        task: "Report example/private stars, forks and watchers",
        format: "Current totals, link and retrieval time",
        github: { revision: 1, repositoryIds: [7001] },
      });
      workflow.nextAt = now.toISOString();
      tick(w, "gpt-4.1-mini", now);
      tick(w, "gpt-4.1-mini", now);
      expect(w.occurrences).toHaveLength(1);
      const r = fixtureValue(w.runs.at(-1));
      expect(r.status).toBe("queued");
      expect(r.threadId).toBeUndefined();
      await seed(w, r);
      const p = provider();
      const key = "bd".repeat(32);
      const telegramCalls: {
        method: string;
        params: Record<string, unknown>;
      }[] = [];
      const telegram: Telegram = {
        async call<T>(method: string, params = {}) {
          telegramCalls.push({ method, params });
          return { message_id: 900 } as T;
        },
      };
      const deployment = await store.deployment();
      Object.assign(deployment, {
        active: true,
        paused: false,
        bot: { id: "999", username: "test_bot", visibleAll: true },
        credentials: {
          bot: encrypt(key, "bot", "999:fake"),
          model: encrypt(key, "model", "fake"),
        },
      });
      await store.saveDeployment(store.pool, deployment);
      const restarted = new Store(store.pool);
      const setup = new SetupService(
        restarted,
        key,
        "http://localhost:3000",
        () => telegram,
      );
      const plugins = new PluginService(restarted, undefined, undefined, p.app);
      let modelCalls = 0;
      const stream: StreamFn = (model, context) => {
        modelCalls++;
        expect(
          getCurrentTools(context.messages)?.some(
            (t) => t.name === "query_github_metadata",
          ),
        ).toBe(true);
        const result = context.messages.findLast(
          (m) => m.role === "toolResult",
        );
        let text = "";
        if (result?.role === "toolResult") {
          expect(result.isError).toBe(false);
          const content = fixtureValue(
            result.content.find((c) => c.type === "text"),
          );
          if (content.type !== "text") throw Error("missing statistics result");
          const data = JSON.parse(content.text);
          expect(data).toMatchObject({ stars: 42, forks: 3, watchers: 7 });
          text = `${data.repository}: ${data.stars} stars, ${data.forks} forks, ${data.watchers} watchers. ${data.url} Retrieved ${data.retrievedAt}`;
        } else {
          expect(p.requests).toHaveLength(0);
          expect(getCurrentSystemPrompt(context.messages)).toContain(
            "kind: repository",
          );
        }
        const message = {
          role: "assistant" as const,
          content: text
            ? [{ type: "text" as const, text }]
            : [
                {
                  type: "toolCall" as const,
                  id: "statistics",
                  name: "query_github_metadata",
                  arguments: args,
                },
              ],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: text ? ("stop" as const) : ("toolUse" as const),
          timestamp: Date.now(),
          usage: {
            input: 10,
            output: 10,
            totalTokens: 20,
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        const events = new AssistantMessageEventStream();
        events.push({ type: "done", reason: message.stopReason, message });
        events.end(message);
        return events;
      };
      const executor = new Executor(restarted, setup, (d, id) =>
        plugins.runner(d, id, stream),
      );
      await executor.execute(w.id, r.id);
      await executor.execute(w.id, r.id);
      const saved = await restarted.read(w.id);
      expect(saved.runs[0]?.status).toBe("succeeded");
      expect(saved.runs[0]?.result).toContain("42 stars, 3 forks, 7 watchers");
      expect(
        Object.values(fixtureValue(saved.runs[0]).tools).map((t) => t.name),
      ).toEqual(["query_github_metadata"]);
      expect(modelCalls).toBe(2);
      expect(p.requests).toHaveLength(2);
      const delivery = fixtureValue(
        saved.deliveries.find((d) => d.runId === r.id),
      );
      expect(delivery.topicId).toBe(7);
      if (revoke)
        await restarted.change(w.id, (current) => {
          fixtureValue(current.members.find((m) => m.id === "202")).active =
            false;
        });
      const worker = new DeliveryWorker(new Store(store.pool), setup);
      await worker.send(w.id, delivery.id);
      await worker.send(w.id, delivery.id);
      if (revoke) {
        expect(telegramCalls).toHaveLength(0);
        expect(
          (await restarted.read(w.id)).deliveries.find(
            (d) => d.id === delivery.id,
          )?.state,
        ).toBe("cancelled");
        return;
      }
      expect(telegramCalls).toHaveLength(1);
      expect(telegramCalls[0]).toMatchObject({
        method: "sendRichMessage",
        params: { chat_id: "202", message_thread_id: 7 },
      });
    },
  );
});
