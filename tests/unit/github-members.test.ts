import { expect, spyOn, test } from "bun:test";
import { GitHubApp } from "../../src/github/app.ts";
import {
  assignGitHubAccount,
  availableGitHubAccount,
} from "../../src/github/member-account.ts";
import { workspace } from "../fixtures.ts";
import { githubFixtureConfig } from "../github-fixture.ts";

function fixture(
  type: "Organization" | "User",
  list: (url: URL, signal?: AbortSignal) => unknown | Promise<unknown>,
  permissions = { members: "read" },
) {
  const calls: { url: string; body?: unknown }[] = [];
  const app = new GitHubApp(githubFixtureConfig, (async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      url: url.href,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname === "/app/installations/501")
      return Response.json({
        app_id: 123,
        account: { id: 1, login: "example", type },
        permissions,
        suspended_at: null,
      });
    if (url.pathname === "/app/installations/501/access_tokens")
      return Response.json({ token: "installation-secret" });
    return Response.json(await list(url, init?.signal ?? undefined));
  }) as typeof fetch);
  return { app, calls };
}

test("organization directory paginates, deduplicates stable IDs and exposes only profiles", async () => {
  const { app, calls } = fixture("Organization", (url) => {
    expect(url.pathname).toBe("/orgs/example/members");
    expect(url.searchParams.get("per_page")).toBe("100");
    return url.searchParams.get("page") === "1"
      ? Array.from({ length: 100 }, (_, i) => ({
          id: i + 2,
          login: `user-${i}`,
          email: "private@example.com",
        }))
      : [
          {
            id: 2,
            login: "renamed-user",
            html_url: "https://untrusted.example",
          },
          { id: 102, login: "last-user" },
        ];
  });
  const result = await app.members(501, []);
  expect(result.source).toBe("organization");
  expect(result.members).toHaveLength(101);
  expect(result.members.find((m) => m.id === 2)).toEqual({
    id: 2,
    login: "renamed-user",
  });
  expect(JSON.stringify(result)).not.toContain("private@example");
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(calls.find((c) => c.url.endsWith("/access_tokens"))?.body).toEqual({
    permissions: { members: "read" },
  });
});

test("personal directory fetches only selected repository collaborators and includes the owner", async () => {
  const { app, calls } = fixture("User", () => [
    { id: 2, login: "colleague" },
    { id: 1, login: "example" },
  ]);
  const result = await app.members(501, [
    { id: 7001, full_name: "example/first" },
    { id: 7002, full_name: "example/second" },
  ]);
  expect(result).toEqual({
    account: "example",
    source: "repositories",
    members: [
      { id: 2, login: "colleague" },
      { id: 1, login: "example" },
    ],
  });
  expect(
    calls
      .filter((c) => c.url.includes("/collaborators"))
      .map((c) => new URL(c.url).pathname),
  ).toEqual([
    "/repos/example/first/collaborators",
    "/repos/example/second/collaborators",
  ]);
  expect(calls.find((c) => c.url.endsWith("/access_tokens"))?.body).toEqual({
    permissions: { metadata: "read" },
  });
  await expect(
    app.members(501, [{ id: 99, full_name: "foreign/repo" }]),
  ).rejects.toThrow("github_access_denied");
});

test("missing organization permission gives recovery guidance without fetching a partial public list", async () => {
  const { app, calls } = fixture("Organization", () => [], { members: "" });
  await expect(app.members(501, [])).rejects.toThrow(
    "github_members_permission_missing",
  );
  expect(calls).toHaveLength(1);
});

test("large personal directories fetch bounded batches and keep every selected repository", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  const { app, calls } = fixture("User", async (url) => {
    active++;
    peak = Math.max(peak, active);
    started.resolve();
    await release.promise;
    active--;
    const index = Number(url.pathname.split("/")[3]?.slice(5));
    return [
      { id: index + 2, login: `person-${index}` },
      { id: 1000, login: `shared-${index}` },
    ];
  });
  const repositories = Array.from({ length: 422 }, (_, index) => ({
    id: index + 7001,
    full_name: `example/repo-${index}`,
  }));
  const lookup = app.members(501, repositories);
  await started.promise;
  const firstBatch = active;
  release.resolve();
  const directory = await lookup;
  expect(firstBatch).toBe(8);
  expect(peak).toBe(8);
  expect(
    calls.filter((call) => call.url.includes("/collaborators")),
  ).toHaveLength(422);
  expect(directory.members).toHaveLength(424);
  expect(directory.members.find((member) => member.id === 1000)).toEqual({
    id: 1000,
    login: "shared-421",
  });
  expect(directory.members).toContainEqual({ id: 423, login: "person-421" });
});

function waitForAbort(signal?: AbortSignal) {
  if (!signal) throw Error("missing request cancellation");
  signal.throwIfAborted();
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

for (const cancellation of ["caller", "deadline"] as const) {
  test(`personal directory ${cancellation} cancellation stops in-flight requests and queued batches`, async () => {
    const controller = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      cancellation === "deadline" && ms === 60000
        ? controller.signal
        : nativeTimeout(ms),
    );
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const { app, calls } = fixture("User", (_url, signal) => {
      if (signal) signals.push(signal);
      started.resolve();
      return waitForAbort(signal);
    });
    try {
      const lookup = app.members(
        501,
        Array.from({ length: 20 }, (_, index) => ({
          id: index + 7001,
          full_name: `example/repo-${index}`,
        })),
        cancellation === "caller" ? controller.signal : undefined,
      );
      await started.promise;
      controller.abort();
      await expect(lookup).rejects.toThrow(
        cancellation === "deadline"
          ? "github_members_timeout"
          : "github_unavailable",
      );
      expect(signals).toHaveLength(8);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(
        calls.filter((call) => call.url.includes("/collaborators")),
      ).toHaveLength(8);
    } finally {
      controller.abort();
      timeout.mockRestore();
    }
  });
}

test("personal directory failures cancel the batch without returning partial accounts", async () => {
  const signals: AbortSignal[] = [];
  const { app, calls } = fixture("User", (url, signal) => {
    if (signal) signals.push(signal);
    if (url.pathname.includes("/repo-0/")) throw Error("upstream failure");
    return waitForAbort(signal);
  });
  await expect(
    app.members(
      501,
      Array.from({ length: 20 }, (_, index) => ({
        id: index + 7001,
        full_name: `example/repo-${index}`,
      })),
    ),
  ).rejects.toThrow("github_unavailable");
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(
    calls.filter((call) => call.url.includes("/collaborators")),
  ).toHaveLength(8);
});

test("personal directories validate all repository owners before requesting collaborators", async () => {
  const { app, calls } = fixture("User", () => []);
  await expect(
    app.members(501, [
      { id: 7001, full_name: "example/selected" },
      { id: 7002, full_name: "foreign/repo" },
    ]),
  ).rejects.toThrow("github_access_denied");
  expect(calls).toHaveLength(1);
});

test("directory errors do not return partial member lists", async () => {
  const { app } = fixture("Organization", () => ({
    message: "upstream error",
  }));
  await expect(app.members(501, [])).rejects.toThrow();
});

test("admin account assignments are scoped, unique profile data and preserve verified access", () => {
  const w = workspace();
  const member = w.members.find((m) => m.id === "202");
  if (!member) throw Error("missing fixture member");
  const role = member.role;
  assignGitHubAccount(w, member, { id: 42, login: "person" });
  expect(member.githubAccount).toEqual({ id: 42, login: "person" });
  expect(member.github).toBeUndefined();
  expect(member.role).toBe(role);
  expect(() => availableGitHubAccount(w, "303", 42)).toThrow(
    "github_identity_already_linked",
  );
  expect(() => availableGitHubAccount(workspace(), "303", 42)).not.toThrow();
  assignGitHubAccount(w, member, null);
  expect(member.githubAccount).toBeUndefined();
  member.github = {
    id: 42,
    login: "person",
    status: "connected",
    syncedAt: new Date().toISOString(),
    connectionRevision: 1,
    repositories: [],
  };
  expect(() => assignGitHubAccount(w, member, null)).toThrow(
    "github_verified_account_requires_member_reconnect",
  );
  expect(() =>
    assignGitHubAccount(w, member, { id: 43, login: "other-person" }),
  ).toThrow("github_verified_account_requires_member_reconnect");
  expect(member.github.id).toBe(42);
  expect(() => availableGitHubAccount(w, "303", 42)).toThrow(
    "github_identity_already_linked",
  );
});
