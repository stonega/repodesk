import { randomUUID } from "node:crypto";
import {
  settingsSchema,
  type Workspace,
  workflowSchema,
} from "../src/domain.ts";
import { enrollOwner, newWorkspace } from "../src/workspaces/service.ts";
export function workspace(): Workspace {
  const w = newWorkspace(
    randomUUID(),
    settingsSchema.parse({ name: "Test team", timezone: "Asia/Taipei" }),
  );
  enrollOwner(w, "101");
  w.members.push(
    { id: "202", role: "member", active: true },
    { id: "303", role: "admin", active: true },
  );
  w.policy.allowed.push("202", "303");
  w.chats.push({
    id: "-100100",
    active: true,
    collection: false,
    visibleAll: true,
    linkedAt: new Date().toISOString(),
  });
  return w;
}
export function spec(w: Workspace) {
  return workflowSchema.parse({
    name: "Friday recap",
    task: "Recap the team",
    chatId: "-100100",
    topicId: 0,
    recurrence: {
      frequency: "weekly",
      hour: 17,
      minute: 0,
      weekday: 5,
      timezone: "Asia/Taipei",
    },
    budgetUsd: 0.1,
    skillId: w.skills[0]?.id,
  });
}
