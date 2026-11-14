import { expect, test } from "bun:test";
import { buildContext } from "../../src/agent/context.ts";
import { selectedRepository } from "../../src/github/repository-context.ts";
import {
  repositoryMenu,
  selectRepository,
} from "../../src/telegram/repositories.ts";
import { updateSchema } from "../../src/telegram/router.ts";
import {
  groupRepositories,
  groupRepositoryAllowed,
  requireGroupRepositoryTarget,
  saveGroupRepository,
} from "../../src/workspaces/group-repository.ts";
import { runAllowed } from "../../src/workspaces/policy.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 7,
    repositories: [
      { id: 1, full_name: "example/product", private: false },
      { id: 2, full_name: "example/other", private: false },
      { id: 3, full_name: "example/private", private: true },
      { id: 4, full_name: "example/archived", private: false, archived: true },
      { id: 5, full_name: "example/unknown" },
    ],
  };
  return w;
}
const chatId = "-100100";
function present<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing fixture value");
  return value;
}

test("group binding is administrator-owned, revision checked and public-only", () => {
  const w = fixture();
  expect(groupRepositories(w).map((r) => r.id)).toEqual([1, 2]);
  expect(() => saveGroupRepository(w, chatId, "202", "999", 0, 1)).toThrow(
    "access_denied",
  );
  for (const id of [3, 4, 5, 999])
    expect(() => saveGroupRepository(w, chatId, "101", "999", 0, id)).toThrow(
      "group_repository_unavailable",
    );
  saveGroupRepository(w, chatId, "303", "999", 0, 1);
  expect(w.chats[0]?.repository).toMatchObject({
    repositoryId: 1,
    revision: 1,
    savedBy: "303",
  });
  expect(() => saveGroupRepository(w, chatId, "101", "999", 0, 2)).toThrow(
    "version_conflict",
  );
  expect(() =>
    saveGroupRepository(w, "-200", w.operatorId, "999", 0, 1),
  ).toThrow("not_found");
  expect(saveGroupRepository(w, chatId, "101", "999", 1, 1)).toBe(false);
  expect(w.chats[0]?.repositoryRevision).toBe(1);
});

test("all people and topics inherit one target over personal selections without changing private context", () => {
  const w = fixture();
  saveGroupRepository(w, chatId, "101", "999", 0, 1);
  w.repositorySelections = [
    {
      actor: "202",
      chatId,
      topicId: 40,
      botId: "999",
      installationId: 7,
      repositoryId: 2,
      at: new Date().toISOString(),
    },
    {
      actor: "202",
      chatId: "202",
      topicId: 40,
      botId: "999",
      installationId: 7,
      repositoryId: 2,
      at: new Date().toISOString(),
    },
  ];
  for (const actor of ["101", "202", "303"])
    for (const topic of [0, 1, 40, 900]) {
      expect(selectedRepository(w, actor, chatId, topic, "999")?.id).toBe(1);
      const run = createRun(w, actor, "Fix the bug", chatId, topic, "fixture", {
        botId: "999",
        replyTo: topic + Number(actor),
      });
      expect(run.repository?.id).toBe(1);
      expect(runAllowed(w, run)).toBe(true);
      expect(
        JSON.parse(buildContext(w, run).prompt).groupRepository,
      ).toMatchObject({ repositoryId: 1, available: true });
    }
  expect(selectedRepository(w, "202", "202", 40, "999")?.id).toBe(2);
  expect(selectedRepository(w, "202", chatId, 40, "other-bot")).toBeUndefined();
  expect(selectedRepository(w, "404", chatId, 40, "999")).toBeUndefined();
});

test("target changes, removal and restoration fence old work without a personal fallback", () => {
  const w = fixture();
  const unbound = createRun(w, "101", "Fix it", chatId, 1, "fixture", {
    botId: "999",
    replyTo: 1,
  });
  saveGroupRepository(w, chatId, "101", "999", 0, 1);
  const run = createRun(w, "101", "Fix it", chatId, 1, "fixture", {
    botId: "999",
    replyTo: 2,
  });
  expect(() =>
    requireGroupRepositoryTarget(w, chatId, "999", 2, run.groupRepository),
  ).toThrow("group_repository_target_mismatch");
  const binding = structuredClone(run.groupRepository);
  present(present(w.github).repositories[0]).private = true;
  expect(runAllowed(w, run)).toBe(false);
  expect(selectedRepository(w, "101", chatId, 1, "999")).toBeUndefined();
  present(present(w.github).repositories[0]).private = false;
  present(w.github).repositoryRevisions = { "1": 2 };
  expect(groupRepositoryAllowed(w, chatId, binding)).toBe(false);
  saveGroupRepository(w, chatId, "101", "999", 1, null);
  expect(runAllowed(w, unbound)).toBe(false);
  expect(runAllowed(w, run)).toBe(false);
  saveGroupRepository(w, chatId, "101", "999", 2, 1);
  expect(runAllowed(w, run)).toBe(false);
  expect(() =>
    requireGroupRepositoryTarget(w, chatId, "999", 1, binding),
  ).toThrow("group_repository_changed");
  const other = fixture();
  expect(groupRepositoryAllowed(other, chatId, binding)).toBe(false);
});

test("group repository menu explains binding and old selection callbacks cannot change it", () => {
  const w = fixture();
  const request = updateSchema.parse({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      from: { id: 101, is_bot: false },
      chat: { id: Number(chatId), type: "supergroup" },
      text: "/repos",
      message_thread_id: 4,
    },
  });
  repositoryMenu(w, request, present(request.message), "999", "");
  const original = present(w.deliveries[0]);
  original.state = "sent";
  original.remoteId = 20;
  saveGroupRepository(w, chatId, "101", "999", 0, 1);
  const callback = updateSchema.parse({
    update_id: 2,
    callback_query: {
      id: "old",
      from: { id: 101, is_bot: false },
      data: "repo:1:2",
      message: {
        message_id: 20,
        date: 1,
        from: { id: 999, is_bot: true },
        chat: { id: Number(chatId), type: "supergroup" },
        message_thread_id: 4,
      },
    },
  });
  expect(() => selectRepository(w, callback, "999")).toThrow(
    "group_repository_managed",
  );
  repositoryMenu(
    w,
    { ...request, update_id: 3 },
    present(request.message),
    "999",
    "",
  );
  expect(w.deliveries.at(-1)?.buttons).toBeUndefined();
  expect(w.deliveries.at(-1)?.text).toContain(
    "all its topics use example/product",
  );
  expect(w.chats[0]?.repository?.repositoryId).toBe(1);
});

test("an unavailable optional repository blocks coding but permits a new greeting with truthful context", () => {
  const w = fixture();
  saveGroupRepository(w, chatId, "101", "999", 0, 1);
  present(present(w.github).repositories[0]).disabled = true;
  const run = createRun(w, "101", "Hello", chatId, 1, "fixture", {
    botId: "999",
    replyTo: 55,
  });
  expect(run.repository).toBeUndefined();
  expect(runAllowed(w, run)).toBe(true);
  expect(JSON.parse(buildContext(w, run).prompt).groupRepository).toMatchObject(
    { available: false },
  );
  expect(() =>
    requireGroupRepositoryTarget(w, chatId, "999", 1, run.groupRepository),
  ).toThrow("group_repository_changed");
  saveGroupRepository(w, chatId, "101", "999", 1, null);
  expect(runAllowed(w, run)).toBe(false);
});
