import { randomUUID } from "node:crypto";
import {
  type DevelopmentTask,
  developmentPolicy,
} from "../src/coding/development.ts";
import { codingDestination } from "../src/coding/policy.ts";
import type { Workspace } from "../src/domain.ts";
import { createRun } from "../src/workspaces/service.ts";
import { workspace } from "./fixtures.ts";

export function fixtureValue<T>(value: T | undefined | null): T {
  if (value === undefined || value === null)
    throw new Error("Missing fixture value");
  return value;
}

export function teamWorkspace() {
  const w = workspace();
  w.github = {
    revision: 1,
    installationId: 501,
    repositories: [
      { id: 7001, full_name: "example/private", private: true },
      { id: 7002, full_name: "example/public", private: false },
    ],
  };
  w.coding = {
    revision: 1,
    settings: {
      enabled: true,
      backend: "podman",
      authMode: "provider_key",
      repositories: [
        { repositoryId: 7001, baseBranch: "main", maintainers: ["101", "303"] },
      ],
    },
  };
  return w;
}
export function requestRun(
  w: Workspace,
  actor = "101",
  chatId = actor,
  topicId = 0,
  task = "Investigate the bug",
) {
  const at = new Date().toISOString();
  w.messages.push({
    id: randomUUID(),
    chatId,
    topicId,
    author: actor,
    text: task,
    at,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    directed: true,
    role: "user",
  });
  const r = createRun(w, actor, task, chatId, topicId, "gpt-4.1-mini");
  r.status = "running";
  r.fence = 1;
  return r;
}
export function successfulRun(
  w: Workspace,
  actor = "101",
  chatId = actor,
  topicId = 0,
) {
  const r = requestRun(w, actor, chatId, topicId);
  r.status = "succeeded";
  r.finishedAt = new Date().toISOString();
  r.result =
    "Reproduced the bug, checked its source and prepared a minimal fix.";
  return r;
}
export function developmentTask(
  w: Workspace,
  actor = "101",
  chatId = actor,
  topicId = 0,
): DevelopmentTask {
  const r = requestRun(w, actor, chatId, topicId);
  r.status = "succeeded";
  const task: DevelopmentTask = {
    id: randomUUID(),
    workspaceId: w.id,
    actor,
    botId: "99",
    chatId,
    topicId,
    sourceId: r.sources.at(-1)?.id as string,
    payload: codingDestination(w, actor, {
      repositoryId: 7001,
      title: "Fix the login bug",
      body: "Retain the original session behavior",
    }),
    policy: developmentPolicy.parse({}),
    state: "waiting",
    phase: "work",
    revision: 1,
    consumedRevision: 1,
    verifiedRevision: 0,
    fence: 1,
    attempts: 1,
    tokens: 0,
    activeMs: 0,
    canImplement: true,
    canPublish: true,
    cancelRequested: false,
    question: {
      id: "product-question",
      text: "Should existing sessions stay signed in?",
      revision: 1,
    },
    createdAt: r.at,
    updatedAt: r.at,
  };
  r.codingTaskId = task.id;
  return task;
}
export const reusableSkill = {
  slug: "bug-triage",
  name: "Bug triage",
  description: "Repeatable bug investigation",
  body: "Inputs: bug report.\nSteps: reproduce, find source, verify.\nOutput: evidence and next steps.\nExample: explain an expired-session report.",
  tools: ["read_chat_context", "load_skill"],
};
