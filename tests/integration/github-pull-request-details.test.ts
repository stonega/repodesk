import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ExtensionCatalog } from "../../src/agent/extensions.ts";
import { type AgentInput, selectedModel } from "../../src/agent/runtime.ts";
import { migrate } from "../../src/db/migrate.ts";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import { GitHubApp } from "../../src/github/app.ts";
import { githubExtension } from "../../src/github/extension.ts";
import { GitHubMetadata } from "../../src/github/metadata.ts";
import { githubFixtureConfig } from "../github-fixture.ts";
import {
  fixtureValue,
  requestRun,
  teamWorkspace,
} from "../team-workflows-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
const headSha = "a".repeat(40),
  baseSha = "b".repeat(40);
const args = { repositoryId: 7001, number: 2 };
const signal = () => new AbortController().signal;
const guard = async () => {};
const pull = (number = 2, changedFiles = 1) => ({
  number,
  head: { sha: headSha, ref: `feature-${number}` },
  base: {
    sha: baseSha,
    ref: "main",
    repo: { id: 7001, full_name: "example/private" },
  },
  changed_files: changedFiles,
});
const file = (number = 2) => ({
  filename: "src/login.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: `@@ -1 +1 @@\n-old\n+implementation ${number}`,
});
const review = {
  id: 71,
  user: { login: "reviewer" },
  body: "Check the session lifetime",
  state: "CHANGES_REQUESTED",
  commit_id: "c".repeat(40),
  submitted_at: "2026-10-17T00:00:00Z",
};

(url ? describe : describe.skip)("PR code and review reads", () => {
  const root = database(url ?? "postgres://unused@localhost/unused");
  const name = `repodesk_pr_details_${randomUUID().replaceAll("-", "")}`;
  const operatorId = randomUUID();
  let store: Store;
  beforeAll(async () => {
    await root.query(`CREATE DATABASE ${name}`);
    const parsed = new URL(url as string);
    parsed.pathname = `/${name}`;
    store = new Store(database(parsed.toString()));
    await migrate(store.pool);
    await store.pool.query(
      "INSERT INTO admins(id,username,password_hash,operator) VALUES($1,'pr_details','unused',true)",
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
    response: (u: URL) => unknown = (u) =>
      /\/pulls\/\d+$/.test(u.pathname)
        ? pull(Number(u.pathname.split("/").at(-1)))
        : [file()],
    during?: (u: URL) => Promise<void>,
  ) {
    const requests: { url: URL; init: RequestInit }[] = [];
    const app = new GitHubApp(githubFixtureConfig, (async (
      input,
      init = {},
    ) => {
      const u = new URL(String(input));
      requests.push({ url: u, init });
      await during?.(u);
      if (u.pathname.endsWith("/access_tokens"))
        return Response.json({
          token: "ghs_fixture_secret",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      const data = response(u);
      return data instanceof Response ? data : Response.json(data);
    }) as typeof fetch);
    return { requests, service: new GitHubMetadata(store, app) };
  }
  const read = (
    p: ReturnType<typeof provider>,
    f: Awaited<ReturnType<typeof seed>>,
    q: unknown = args,
    s = signal(),
  ) => p.service.pullRequest(f.w.id, f.r.id, q, s, guard);

  test("two PRs expose different actual patches using only repository-scoped PR read tokens", async () => {
    const f = await seed();
    const p = provider((u) =>
      /\/pulls\/\d+$/.test(u.pathname)
        ? pull(Number(u.pathname.split("/").at(-1)))
        : [file(Number(u.pathname.split("/").at(-2)))],
    );
    for (const number of [2, 3]) {
      const result = await read(p, f, { ...args, number });
      expect(result).toMatchObject({
        number,
        headSha,
        baseSha,
        complete: true,
        url: `https://github.com/example/private/pull/${number}`,
      });
      expect(result.items[0]).toMatchObject({
        path: "src/login.ts",
        patch: file(number).patch,
        patchAvailable: true,
      });
      expect(JSON.stringify(result)).not.toContain("ghs_fixture");
    }
    for (const req of p.requests) {
      expect(req.init.redirect).toBe("error");
      if (req.url.pathname.endsWith("/access_tokens"))
        expect(JSON.parse(String(req.init.body))).toEqual({
          repository_ids: [7001],
          permissions: { pull_requests: "read" },
        });
      else expect(req.init.method).toBe("GET");
    }
    expect((await store.read(f.w.id)).runs[0]?.githubRead).toEqual({
      revision: 1,
      repositoryIds: [7001],
    });
    expect(JSON.stringify(await store.read(f.w.id))).not.toContain(
      "implementation 2",
    );
  });

  test("file pagination pins commits and reports the 3000-file API boundary without claiming completeness", async () => {
    const f = await seed();
    const p = provider((u) =>
      u.pathname.endsWith("/files")
        ? Array.from(
            { length: u.searchParams.get("page") === "2" ? 1 : 20 },
            () => file(),
          )
        : pull(2, 21),
    );
    const first = await read(p, f);
    expect(first).toMatchObject({
      hasMore: true,
      nextPage: 2,
      complete: false,
    });
    const last = await read(p, f, {
      ...args,
      page: 2,
      headSha: first.headSha,
      baseSha: first.baseSha,
    });
    expect(last).toMatchObject({ hasMore: false, complete: true });
    expect(last.items).toHaveLength(1);
    expect(
      p.requests
        .find((r) => r.url.pathname.endsWith("/files"))
        ?.url.searchParams.get("per_page"),
    ).toBe("20");
    const capped = provider((u) =>
      u.pathname.endsWith("/files")
        ? Array.from({ length: 20 }, () => file())
        : pull(2, 3001),
    );
    const result = await read(capped, f, {
      ...args,
      page: 150,
      headSha,
      baseSha,
    });
    expect(result).toMatchObject({
      hasMore: true,
      nextPage: undefined,
      complete: false,
    });
    expect(result.coverage).toContain("limit was reached");
    const short = provider((u) =>
      u.pathname.endsWith("/files") ? [] : pull(2, 1),
    );
    expect(await read(short, f)).toMatchObject({
      hasMore: true,
      nextPage: undefined,
      complete: false,
    });
  });

  test("missing patches, renames and bounded diff text disclose incomplete evidence", async () => {
    const f = await seed();
    const p = provider((u) =>
      u.pathname.endsWith("/files")
        ? [
            { ...file(), filename: "assets/image.png", patch: undefined },
            {
              ...file(),
              previous_filename: "old/login.ts",
              status: "renamed",
              patch: "x".repeat(12001),
            },
            ...Array.from({ length: 4 }, () => ({
              ...file(),
              patch: "y".repeat(12000),
            })),
          ]
        : pull(2, 6),
    );
    const result = await read(p, f);
    expect(result).toMatchObject({ complete: false, missingPatchCount: 1 });
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(result.items[0]).toMatchObject({ patchAvailable: false });
    expect(result.items[1]).toMatchObject({
      previousPath: "old/login.ts",
      patchTruncated: true,
    });
    expect(
      result.items.reduce(
        (n, item) => n + ("patch" in item ? (item.patch?.length ?? 0) : 0),
        0,
      ),
    ).toBe(40000);
  });

  test("reviews and inline comments retain authors, states, old commits, anchors and truncation flags", async () => {
    const f = await seed();
    const p = provider((u) =>
      u.pathname.endsWith("/reviews")
        ? [review]
        : u.pathname.endsWith("/comments")
          ? [
              {
                ...review,
                user: null,
                path: "src/login.ts",
                line: null,
                original_line: 4,
                side: "RIGHT",
                pull_request_review_id: 71,
                original_commit_id: "d".repeat(40),
                in_reply_to_id: 70,
                body: "x".repeat(4001),
                diff_hunk: "y".repeat(4001),
                created_at: review.submitted_at,
                updated_at: review.submitted_at,
                html_url: "https://attacker.invalid",
              },
            ]
          : pull(),
    );
    const reviews = await read(p, f, { ...args, resource: "reviews" });
    expect(reviews.items[0]).toMatchObject({
      author: "reviewer",
      state: "CHANGES_REQUESTED",
      commitSha: "c".repeat(40),
      url: "https://github.com/example/private/pull/2#pullrequestreview-71",
    });
    const comments = await read(p, f, {
      ...args,
      resource: "comments",
      headSha,
      baseSha,
    });
    expect(comments.items[0]).toMatchObject({
      path: "src/login.ts",
      line: null,
      originalLine: 4,
      reviewId: 71,
      inReplyToId: 70,
      bodyTruncated: true,
      diffHunkTruncated: true,
      url: "https://github.com/example/private/pull/2#discussion_r71",
    });
    expect(comments.complete).toBe(false);
    expect(JSON.stringify(comments)).not.toContain("attacker.invalid");
    const pages = provider((u) =>
      u.pathname.endsWith("/reviews")
        ? u.searchParams.get("page") === "2"
          ? []
          : Array.from({ length: 20 }, () => review)
        : pull(),
    );
    expect(
      await read(pages, f, { ...args, resource: "reviews" }),
    ).toMatchObject({ nextPage: 2, complete: false });
    expect(
      await read(pages, f, {
        ...args,
        resource: "reviews",
        page: 2,
        headSha,
        baseSha,
      }),
    ).toMatchObject({ complete: true, items: [] });
  });

  test("invalid targets, arbitrary endpoints and unpinned pages fail before contacting GitHub", async () => {
    const f = await seed(),
      p = provider();
    for (const q of [
      { ...args, number: -1 },
      { ...args, page: 2 },
      { ...args, page: 151, headSha, baseSha },
      { ...args, resource: "merge" },
      { ...args, url: "https://attacker.invalid" },
      { ...args, headSha: "not-a-commit" },
    ])
      await expect(read(p, f, q)).rejects.toThrow();
    expect(p.requests).toHaveLength(0);
  });

  test("tenant, membership, upstream read and private-group boundaries deny before external reads", async () => {
    for (const variant of [
      "tenant",
      "inactive",
      "upstream",
      "stale",
      "private-group",
      "unselected",
    ] as const) {
      const w = teamWorkspace();
      const r = requestRun(
        w,
        "101",
        variant === "private-group" ? "-100100" : "101",
      );
      const member = fixtureValue(w.members[0]);
      if (variant === "inactive") member.active = false;
      if (variant === "upstream") fixtureValue(member.github).repositories = [];
      if (variant === "stale")
        fixtureValue(member.github).syncedAt = new Date(0).toISOString();
      const f = await seed(w, r),
        p = provider();
      if (variant === "tenant") f.r = (await seed()).r;
      await expect(
        read(
          p,
          f,
          variant === "unselected" ? { ...args, repositoryId: 9999 } : args,
        ),
      ).rejects.toThrow();
      expect(p.requests).toHaveLength(0);
    }
    const w = teamWorkspace(),
      r = requestRun(w, "101", "-100100");
    const f = await seed(w, r);
    const p = provider((u) =>
      u.pathname.endsWith("/files")
        ? [file()]
        : {
            ...pull(),
            base: {
              ...pull().base,
              repo: { id: 7002, full_name: "example/public" },
            },
          },
    );
    expect((await read(p, f, { ...args, repositoryId: 7002 })).complete).toBe(
      true,
    );
  });

  test("revoked access and cancellation during every network stage prevent returning private data", async () => {
    for (const stage of ["token", "snapshot", "resource", "final"] as const) {
      const f = await seed();
      let snapshots = 0;
      const controller = new AbortController();
      const p = provider(undefined, async (u) => {
        if (/\/pulls\/\d+$/.test(u.pathname)) snapshots++;
        if (
          (stage === "token" && u.pathname.endsWith("/access_tokens")) ||
          (stage === "snapshot" && snapshots === 1) ||
          (stage === "resource" && u.pathname.endsWith("/files")) ||
          (stage === "final" && snapshots === 2)
        ) {
          if (stage === "final") controller.abort();
          else
            await store.change(f.w.id, (w) => {
              if (stage === "token") fixtureValue(w.github).revision++;
              else if (stage === "snapshot")
                fixtureValue(w.members[0]).active = false;
              else fixtureValue(w.runs[0]).cancelled = true;
            });
        }
      });
      await expect(read(p, f, args, controller.signal)).rejects.toThrow();
      if (stage === "token") expect(p.requests).toHaveLength(1);
      if (stage === "snapshot") expect(p.requests).toHaveLength(2);
    }
  });

  test("changed commits and contradictory PR identities cannot produce comparison evidence", async () => {
    for (const variant of [
      "head",
      "base",
      "count",
      "number",
      "repository",
      "name",
      "pin",
    ] as const) {
      const f = await seed();
      let snapshots = 0;
      const p = provider((u) => {
        if (u.pathname.endsWith("/files")) return [file()];
        const value = pull();
        snapshots++;
        if (variant === "number") value.number = 3;
        if (variant === "repository") value.base.repo.id = 7002;
        if (variant === "name") value.base.repo.full_name = "other/repository";
        if (snapshots === 2) {
          if (variant === "head") value.head.sha = "c".repeat(40);
          if (variant === "base") value.base.sha = "c".repeat(40);
          if (variant === "count") value.changed_files++;
        }
        return value;
      });
      await expect(
        read(
          p,
          f,
          variant === "pin"
            ? { ...args, headSha: "c".repeat(40), baseSha }
            : args,
        ),
      ).rejects.toThrow(
        ["number", "repository", "name"].includes(variant)
          ? "github_item_response_mismatch"
          : "github_pr_changed",
      );
    }
  });

  test("GitHub failures and malformed detail responses never become empty successful reads", async () => {
    const f = await seed();
    for (const status of [401, 403, 404, 503]) {
      const p = provider(() =>
        Response.json({ message: "private upstream diagnostic" }, { status }),
      );
      await expect(read(p, f)).rejects.toMatchObject({
        code: status === 503 ? "github_unavailable" : "github_access_denied",
      });
    }
    for (const raw of [
      {},
      [{ ...file(), filename: undefined }],
      Array.from({ length: 21 }, () => file()),
    ]) {
      const p = provider((u) => (u.pathname.endsWith("/files") ? raw : pull()));
      await expect(read(p, f)).rejects.toThrow();
    }
  });

  test("the actual Pi tool returns patches and actionable missing-grant guidance without private diagnostics", async () => {
    const f = await seed();
    for (const missingPermission of [false, true]) {
      const requests: RequestInit[] = [];
      const app = new GitHubApp(githubFixtureConfig, (async (
        input,
        init = {},
      ) => {
        requests.push(init);
        if (String(input).endsWith("/access_tokens"))
          return missingPermission
            ? Response.json(
                { message: "Permissions requested are not granted" },
                { status: 422 },
              )
            : Response.json({
                token: "ghs_fixture_secret",
                expires_at: new Date(Date.now() + 3600000).toISOString(),
              });
        return Response.json(
          String(input).includes("/files?") ? [file()] : pull(),
        );
      }) as typeof fetch);
      const input: AgentInput = {
        workspaceId: f.w.id,
        actor: "101",
        runId: f.r.id,
        model: selectedModel("gpt-4.1-mini"),
        apiKey: "fake",
        system: "",
        prompt: "Compare PR #2 and #3",
        transcript: [],
        tools: [],
        maxTurns: 2,
        maxTools: 3,
        signal: signal(),
        guard,
        reserve: async () => "attempt",
        checkpoint: async () => {},
      };
      const host = await ExtensionCatalog.fromSnapshot(
        [],
        [
          githubExtension(
            store,
            f.w.id,
            fixtureValue(f.w.github),
            new GitHubMetadata(store, app),
          ),
        ],
      ).open(input);
      try {
        const tool = fixtureValue(
          host?.tools.find((t) => t.name === "query_github_pull_request"),
        );
        const result = JSON.stringify(
          await tool.execute("detail", args, input.signal),
        );
        expect(result).toContain(
          missingPermission
            ? "github_app_permissions_missing"
            : "implementation 2",
        );
        if (missingPermission)
          expect(result).toContain("accept the updated permissions");
        expect(result).not.toContain("ghs_fixture");
        expect(requests[0]?.method).toBe("POST");
      } finally {
        await host?.close();
      }
    }
  });
});
