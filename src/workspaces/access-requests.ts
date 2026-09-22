import { randomUUID } from "node:crypto";
import { type AccessRequest, requireThat, type Workspace } from "../domain.ts";
import { updateMemberProfile } from "./member-profile.ts";
import { audit, authorize, eligible } from "./policy.ts";
import { deliver } from "./service.ts";

export function requestAccess(
  w: Workspace,
  input: Pick<
    AccessRequest,
    "actor" | "username" | "name" | "chatId" | "topicId"
  >,
  now = new Date(),
) {
  requireThat(!w.deletion, "access_request_unavailable", 409);
  requireThat(!eligible(w, input.actor), "already_authorized", 409);
  requireThat(
    input.chatId === input.actor ||
      w.chats.some((c) => c.active && c.id === input.chatId),
    "destination_denied",
    403,
  );
  w.accessRequests ??= [];
  const requests = w.accessRequests;
  const previous = requests.find((r) => r.actor === input.actor);
  if (previous?.status === "pending") return previous;
  if (
    previous?.status === "rejected" &&
    Date.parse(previous.decidedAt ?? "") > now.getTime() - 86400000
  )
    return previous;
  requireThat(
    requests.length < 500 || previous,
    "access_request_capacity",
    429,
  );
  if (previous) requests.splice(requests.indexOf(previous), 1);
  const request: AccessRequest = {
    ...input,
    id: randomUUID(),
    requestedAt: now.toISOString(),
    status: "pending",
  };
  requests.push(request);
  audit(w, input.actor, "access.requested", request.id, undefined, now);
  return request;
}

export function decideAccessRequest(
  w: Workspace,
  actor: string,
  id: string,
  decision: "approved" | "rejected",
  version: number,
  now = new Date(),
) {
  authorize(w, actor, true);
  const request = w.accessRequests?.find((r) => r.id === id);
  requireThat(request, "not_found", 404);
  // A replay must never restore access revoked after the original decision.
  if (request.status === decision) return request;
  requireThat(request.status === "pending", "access_request_decided", 409);
  requireThat(w.policy.version === version, "version_conflict", 409);
  if (decision === "approved") {
    const member = w.members.find((m) => m.id === request.actor);
    requireThat(member?.role !== "owner", "owner_requires_host_recovery", 409);
    if (member) {
      member.active = true;
      member.role = "member";
    } else w.members.push({ id: request.actor, role: "member", active: true });
    // Keep newer direct interactions when approving an older request.
    if (
      !member?.profileUpdatedAt ||
      member.profileUpdatedAt <= request.requestedAt
    )
      updateMemberProfile(
        w,
        {
          id: request.actor,
          username: request.username,
          name: request.name,
        },
        new Date(request.requestedAt),
      );
    if (!w.policy.allowed.includes(request.actor))
      w.policy.allowed.push(request.actor);
    w.policy.version++;
    audit(w, actor, "member.updated", request.actor, w.policy.version, now);
    audit(w, actor, "access.allowed", request.actor, w.policy.version, now);
    if (
      request.chatId === request.actor ||
      w.chats.some((c) => c.active && c.id === request.chatId)
    )
      deliver(
        w,
        request.actor,
        request.chatId,
        `Access approved for Telegram user ${request.actor}. You can now use the bot. Send /help to get started.`,
        { id: `access:${request.id}:approved`, topicId: request.topicId },
      );
  }
  request.status = decision;
  request.decidedAt = now.toISOString();
  request.decidedBy = actor;
  audit(
    w,
    actor,
    `access_request.${decision}`,
    request.id,
    w.policy.version,
    now,
  );
  return request;
}
