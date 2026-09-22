import type { Member, Workspace } from "../domain.ts";

/** Display metadata only; identity and permissions always use the numeric ID. */
export function updateMemberProfile(
  w: Workspace,
  profile: Pick<Member, "id" | "username" | "name">,
  now = new Date(),
) {
  const member = w.members.find((m) => m.id === profile.id);
  if (!member) return;
  member.username = profile.username;
  member.name = profile.name;
  member.profileUpdatedAt = now.toISOString();
}

/** Older approved requests may be the only profile available until the next update. */
export function membersWithProfiles(w: Workspace): Member[] {
  return w.members.map((member) => {
    if (member.profileUpdatedAt) return member;
    const request = w.accessRequests?.find(
      (r) => r.actor === member.id && r.status === "approved",
    );
    return request
      ? { ...member, username: request.username, name: request.name }
      : member;
  });
}
