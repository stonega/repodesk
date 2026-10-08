import { expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import type { Workspace } from "../../src/domain.ts";
import {
  recentRepositories,
  repositoryDeliveryAllowed,
  selectedRepository,
} from "../../src/github/repository-context.ts";
import { sweep } from "../../src/privacy/service.ts";
import {
  repositoryMenu,
  selectRepository,
} from "../../src/telegram/repositories.ts";
import { type Update, updateSchema } from "../../src/telegram/router.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 7,
    repositories: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      full_name: `example/repo-${i + 1}`,
      private: false,
      pushed_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
    })),
  };
  return w;
}
function mention(w: Workspace, text: string, minutes: number, author = "101") {
  w.messages.push({
    id: `mention:${w.messages.length}`,
    chatId: author,
    topicId: 0,
    author,
    text,
    directed: true,
    at: new Date(Date.now() - minutes * 60000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}
function menu(w: Workspace, updateId = 1, query = "") {
  const u = updateSchema.parse({
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 101, type: "private" },
      from: { id: 101, is_bot: false },
      message_thread_id: 21,
      text: `/repos ${query}`,
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    },
  });
  if (!u.message) throw Error("missing message");
  repositoryMenu(w, u, u.message, "999", query);
  const d = w.deliveries.find((d) => d.id === `repos:999:${updateId}`);
  if (!d) throw Error("missing menu");
  d.state = "sent";
  d.remoteId = 100 + updateId;
  return d;
}
function click(updateId = 1, repository: number | "clear" = 12): Update {
  return updateSchema.parse({
    update_id: 50 + updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 101, is_bot: false },
      data: `repo:${updateId}:${repository}`,
      message: {
        message_id: 100 + updateId,
        date: 1,
        chat: { id: 101, type: "private" },
        from: { id: 999, is_bot: true },
        message_thread_id: 21,
      },
    },
  });
}

test("latest 10 active repositories prefer retained mentions, including GitHub links and unique short names", () => {
  const w = fixture();
  mention(w, "Please inspect https://github.com/example/repo-11/pull/1", 2);
  mention(w, "Fix REPO-12", 1);
  mention(w, "repo-10", 0, "202");
  mention(w, "repo-9", 0);
  const expired = w.messages.at(-1);
  if (expired) expired.expiresAt = new Date(0).toISOString();
  mention(w, "repo-8", 0);
  const assistant = w.messages.at(-1);
  if (assistant) assistant.role = "assistant";
  expect(recentRepositories(w, "101", "101").map((r) => r.id)).toEqual([
    12, 11, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(
    recentRepositories(w, "101", "101", "REPO-11").map((r) => r.id),
  ).toEqual([11]);
  expect(recentRepositories(w, "101", "101", "unknown")).toEqual([]);
});

test("mentions respect name boundaries and ambiguous short names; activity fallback is stable", () => {
  const w = fixture();
  w.github?.repositories.push({
    id: 13,
    full_name: "other/repo-12",
    private: false,
  });
  mention(w, "repo-12 repo-11-extra other/repo-10", 1);
  expect(recentRepositories(w, "101", "101")[0]?.id).toBe(1);
  mention(w, "EXAMPLE/REPO-12", 0);
  expect(recentRepositories(w, "101", "101")[0]?.id).toBe(12);
  for (const r of w.github?.repositories ?? []) {
    delete r.pushed_at;
    delete r.updated_at;
  }
  w.messages = [];
  const names = recentRepositories(w, "101", "101").map((r) => r.full_name);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  const first = w.github?.repositories[0];
  if (first) first.updated_at = new Date().toISOString();
  expect(recentRepositories(w, "101", "101")[0]?.id).toBe(1);
});

test("active repository choices enforce upstream grants and private group boundaries", () => {
  const w = fixture();
  const repositories = w.github?.repositories ?? [];
  Object.assign(repositories[0] ?? {}, { private: true });
  Object.assign(repositories[1] ?? {}, { archived: true });
  Object.assign(repositories[2] ?? {}, { disabled: true });
  expect(
    recentRepositories(w, "101", "-100100").map((r) => r.id),
  ).not.toContain(1);
  const member = w.members.find((m) => m.id === "101");
  if (!member) throw Error("missing member");
  member.github = {
    id: 1,
    login: "member",
    status: "connected",
    connectionRevision: 1,
    syncedAt: new Date().toISOString(),
    repositories: [
      {
        id: 4,
        full_name: "example/repo-4",
        permissions: { pull: true, push: false, admin: false },
      },
    ],
  };
  expect(recentRepositories(w, "101", "101").map((r) => r.id)).toEqual([4]);
  member.github.syncedAt = new Date(Date.now() - 11 * 60000).toISOString();
  expect(recentRepositories(w, "101", "101")).toEqual([]);
  expect(recentRepositories(w, "404", "404")).toEqual([]);
});

test("inline selection, saved checkmark and clearing stay within the actor, bot and topic", () => {
  const w = fixture();
  mention(w, "repo-12", 1);
  const first = menu(w);
  expect(first.buttons).toHaveLength(10);
  expect(first.buttons?.every((row) => row.length === 1)).toBe(true);
  expect(
    first.buttons
      ?.flat()
      .every(
        (b) =>
          typeof b.callback_data === "string" &&
          Buffer.byteLength(b.callback_data) <= 64,
      ),
  ).toBe(true);
  expect(selectRepository(w, click(), "999")).toBe(true);
  expect(selectedRepository(w, "101", "101", 21, "999")?.id).toBe(12);
  expect(selectedRepository(w, "101", "101", 22, "999")).toBeUndefined();
  expect(selectedRepository(w, "202", "202", 21, "999")).toBeUndefined();
  expect(selectedRepository(w, "101", "101", 21, "888")).toBeUndefined();
  const second = menu(w, 2);
  expect(second.buttons?.[0]?.[0]?.text).toBe("✓ example/repo-12");
  expect(second.buttons?.at(-1)?.[0]?.text).toBe("Clear selection");
  expect(second.text).toContain("Selected: example/repo-12");
  expect(selectRepository(w, click(2, "clear"), "999")).toBe(true);
  expect(w.repositorySelections).toEqual([]);
  expect(() => selectRepository(w, click(), "999")).toThrow(
    "repository_menu_expired",
  );
});

test("stale, forged, copied and revoked callbacks cannot change repository context", () => {
  const mutations: Array<(w: Workspace, u: Update) => void> = [
    (w) => {
      const d = w.deliveries[0];
      if (d?.repositoryMenu)
        d.repositoryMenu.expiresAt = new Date(0).toISOString();
    },
    (w) => {
      if (w.github) w.github.revision++;
    },
    (w) => {
      if (w.github) w.github.installationId = 8;
    },
    (w) => {
      const r = w.github?.repositories.find((r) => r.id === 12);
      if (r) r.archived = true;
    },
    (w) => {
      const r = w.github?.repositories.find((r) => r.id === 12);
      if (r) r.full_name = "example/renamed";
    },
    (w) => {
      const member = w.members[0];
      if (member) member.active = false;
    },
    (w) => {
      w.settings.paused = true;
    },
    (_, u) => {
      if (u.callback_query) u.callback_query.from.id = 202;
    },
    (_, u) => {
      if (u.callback_query?.message) u.callback_query.message.message_id++;
    },
    (_, u) => {
      if (u.callback_query?.message)
        u.callback_query.message.message_thread_id = 22;
    },
    (_, u) => {
      if (u.callback_query?.message?.from)
        u.callback_query.message.from.id = 888;
    },
    (_, u) => {
      if (u.callback_query) u.callback_query.data = "repo:1:13";
    },
  ];
  for (const mutate of mutations) {
    const w = fixture();
    mention(w, "repo-12", 1);
    menu(w);
    const u = click();
    mutate(w, u);
    expect(() => selectRepository(w, u, "999")).toThrow();
    expect(w.repositorySelections).toBeUndefined();
  }
});

test("selection is pinned as default context without changing original task or approvals", () => {
  const w = fixture();
  mention(w, "repo-12", 1);
  menu(w);
  selectRepository(w, click(), "999");
  const run = createRun(
    w,
    "101",
    "Explain the architecture",
    "101",
    21,
    "fake",
    { botId: "999" },
  );
  expect(run.task).toBe("Explain the architecture");
  expect(run.repository?.id).toBe(12);
  expect(JSON.parse(buildContext(w, run).prompt).selectedRepository).toEqual({
    id: 12,
    full_name: "example/repo-12",
  });
  expect(buildContext(w, run).system).toContain(
    "an explicit repository in the current request takes precedence",
  );
  expect(w.approvals).toEqual([]);
  const other = createRun(w, "101", "Another topic", "101", 22, "fake", {
    botId: "999",
  });
  expect(other.repository).toBeUndefined();
  if (w.github) w.github.repositories = [];
  expect(
    JSON.parse(buildContext(w, run).prompt).selectedRepository,
  ).toBeUndefined();
});

test("empty/search-miss menus offer useful recovery and retention purges selection state", () => {
  const w = fixture();
  expect(menu(w, 1, "unknown").text).toContain("Try /repos <name>");
  delete w.github;
  expect(menu(w, 2).text).toContain("Ask your workspace admin");
  w.repositorySelections = [
    {
      actor: "101",
      chatId: "101",
      topicId: 21,
      botId: "999",
      installationId: 7,
      repositoryId: 1,
      at: new Date(0).toISOString(),
    },
  ];
  sweep(w);
  expect(w.repositorySelections).toEqual([]);
  w.deletion = {
    requestedAt: new Date().toISOString(),
    providerState: "pending",
  };
  sweep(w);
  expect(w.repositorySelections).toBeUndefined();
});

test("superseded pending menus and already-prepared delivery snapshots are revoked", () => {
  const w = fixture();
  const first = menu(w, 1);
  first.state = "pending";
  const prepared = structuredClone(first);
  menu(w, 2);
  expect(w.deliveries.find((d) => d.id === first.id)?.state).toBe("cancelled");
  expect(repositoryDeliveryAllowed(w, prepared)).toBe(false);
});
