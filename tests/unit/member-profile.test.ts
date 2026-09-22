import { expect, test } from "bun:test";
import {
  membersWithProfiles,
  updateMemberProfile,
} from "../../src/workspaces/member-profile.ts";
import { workspace } from "../fixtures.ts";

test("profile updates are display-only and cannot enroll a user or change access", () => {
  const w = workspace();
  const policy = structuredClone(w.policy);
  updateMemberProfile(w, { id: "404", username: "unknown" });
  expect(w.members).toHaveLength(3);
  updateMemberProfile(w, { id: "202", username: "alice", name: "Alice" });
  expect(w.members.find((m) => m.id === "202")).toMatchObject({
    username: "alice",
    name: "Alice",
    role: "member",
    active: true,
  });
  expect(w.policy).toEqual(policy);
});

test("legacy approved profiles are available but removed usernames do not reappear", () => {
  const w = workspace();
  w.accessRequests = [
    {
      id: "approved",
      actor: "202",
      chatId: "202",
      username: "old_name",
      name: "Old name",
      status: "approved",
      requestedAt: "2026-09-20T00:00:00Z",
    },
  ];
  expect(membersWithProfiles(w).find((m) => m.id === "202")?.username).toBe(
    "old_name",
  );
  expect(w.members.find((m) => m.id === "202")?.username).toBeUndefined();
  updateMemberProfile(w, { id: "202", name: "New name" });
  const member = membersWithProfiles(w).find((m) => m.id === "202");
  expect(member?.name).toBe("New name");
  expect(member?.username).toBeUndefined();
});

test("pending requests do not overwrite known member identity", () => {
  const w = workspace();
  w.accessRequests = [
    {
      id: "pending",
      actor: "202",
      chatId: "202",
      username: "pending_name",
      status: "pending",
      requestedAt: new Date().toISOString(),
    },
  ];
  expect(
    membersWithProfiles(w).find((m) => m.id === "202")?.username,
  ).toBeUndefined();
});
