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
  const result = await app.members(501);
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

test("personal directory returns only its owner without tokens or repository requests", async () => {
  const { app, calls } = fixture("User", () => {
    throw Error("Unexpected member request");
  });
  expect(await app.members(501)).toEqual({
    account: "example",
    source: "personal",
    members: [{ id: 1, login: "example" }],
  });
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
    "/app/installations/501",
  ]);
});

test("missing organization permission gives recovery guidance without fetching a partial public list", async () => {
  const { app, calls } = fixture("Organization", () => [], { members: "" });
  await expect(app.members(501)).rejects.toThrow(
    "github_members_permission_missing",
  );
  expect(calls).toHaveLength(1);
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
  test(`organization directory ${cancellation} cancellation stops the member lookup`, async () => {
    const controller = new AbortController();
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      cancellation === "deadline" && ms === 60000
        ? controller.signal
        : nativeTimeout(ms),
    );
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const { app, calls } = fixture("Organization", (_url, signal) => {
      if (signal) signals.push(signal);
      started.resolve();
      return waitForAbort(signal);
    });
    try {
      const lookup = app.members(
        501,
        cancellation === "caller" ? controller.signal : undefined,
      );
      await started.promise;
      controller.abort();
      await expect(lookup).rejects.toThrow(
        cancellation === "deadline"
          ? "github_members_timeout"
          : "github_unavailable",
      );
      expect(signals).toHaveLength(1);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(
        calls.filter((call) => call.url.includes("/orgs/example/members")),
      ).toHaveLength(1);
    } finally {
      controller.abort();
      timeout.mockRestore();
    }
  });
}

test("custom usernames resolve public user IDs and expose only profile fields", async () => {
  const { app, calls } = fixture("User", (url) => {
    expect(url.pathname).toBe("/users/Outside-User");
    return {
      id: 42,
      login: "outside-user",
      type: "User",
      email: "private@example.com",
    };
  });
  expect(await app.member(" @Outside-User ")).toEqual({
    id: 42,
    login: "outside-user",
  });
  expect(calls).toHaveLength(1);
  await expect(app.member("https://github.com/person")).rejects.toThrow();
  expect(calls).toHaveLength(1);
});

test("custom username lookup rejects organizations, missing profiles and upstream failures", async () => {
  const { app } = fixture("User", () => ({
    id: 42,
    login: "org",
    type: "Organization",
  }));
  await expect(app.member("org")).rejects.toThrow(
    "github_personal_account_required",
  );
  const missing = new GitHubApp(githubFixtureConfig, (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => Response.json({}, { status: 404 })) as typeof fetch);
  await expect(missing.member("missing")).rejects.toThrow(
    "github_member_not_found",
  );
  const failed = new GitHubApp(githubFixtureConfig, (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => Response.json({}, { status: 502 })) as typeof fetch);
  await expect(failed.member("person")).rejects.toThrow("github_unavailable");
});

test("directory errors do not return partial member lists", async () => {
  const { app } = fixture("Organization", () => ({
    message: "upstream error",
  }));
  await expect(app.members(501)).rejects.toThrow();
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
