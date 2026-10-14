import { createHmac } from "node:crypto";
import type { Workspace } from "../domain.ts";
import { equal, hash } from "../setup/credentials.ts";
import { updateMemberProfile } from "./member-profile.ts";
import { audit, eligible } from "./policy.ts";

const refreshMs = 10_000;
const lifetimeMs = 24 * 60 * 60 * 1000;

/** Signed invitations need durable state only when an account claims them. */
export class AccessLinks {
  constructor(private key: string) {}

  private signature(payload: string, botId: string) {
    return createHmac("sha256", Buffer.from(this.key, "hex"))
      .update(`repodesk:access-link:v1:${botId}:${payload}`)
      .digest("base64url")
      .slice(0, 22);
  }

  view(w: Workspace, bot?: { id: string; username: string }, now = new Date()) {
    if (!bot || w.deletion)
      return { requestUrl: null, refreshAt: null, expiresAt: null };
    const workspace = Buffer.from(w.id.replaceAll("-", ""), "hex").toString(
      "base64url",
    );
    const issued = Math.floor(now.getTime() / 1000);
    const payload = `${workspace}_${issued.toString(36)}`;
    const raw = `${payload}_${this.signature(payload, bot.id)}`;
    return {
      requestUrl: `https://t.me/${bot.username}?start=access_${raw}`,
      refreshAt: new Date(issued * 1000 + refreshMs).toISOString(),
      expiresAt: new Date(issued * 1000 + lifetimeMs).toISOString(),
    };
  }

  resolve(raw: string, botId: string, now = new Date()) {
    const match =
      /^([A-Za-z0-9_-]{22})_([a-z0-9]{1,10})_([A-Za-z0-9_-]{22})$/.exec(raw);
    if (!match) return;
    const workspace = match[1];
    const timestamp = match[2];
    const signature = match[3];
    if (!workspace || !timestamp || !signature) return;
    const issuedAt = Number.parseInt(timestamp, 36) * 1000;
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > now.getTime() ||
      issuedAt + lifetimeMs <= now.getTime() ||
      !equal(signature, this.signature(`${workspace}_${timestamp}`, botId))
    )
      return;
    const id = Buffer.from(workspace, "base64url").toString("hex");
    return {
      workspaceId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
      expiresAt: new Date(issuedAt + lifetimeMs).toISOString(),
    };
  }

  /** Call while holding the workspace row lock, in the inbox transaction. */
  redeem(
    w: Workspace,
    raw: string,
    botId: string,
    profile: { id: string; username?: string; name?: string },
    now = new Date(),
  ) {
    const invitation = this.resolve(raw, botId, now);
    if (w.deletion || invitation?.workspaceId !== w.id) return false;
    const digest = hash(raw);
    w.accessLinkClaims = (w.accessLinkClaims ?? []).filter(
      (claim) => Date.parse(claim.expiresAt) > now.getTime(),
    );
    const claimed = w.accessLinkClaims.find((claim) => claim.hash === digest);
    // Replays acknowledge current access without restoring a revoked membership.
    if (claimed) return claimed.actor === profile.id && eligible(w, profile.id);
    const member = w.members.find((m) => m.id === profile.id);
    if (member?.role === "owner" && !member.active) return false;
    if (!eligible(w, profile.id)) {
      if (member) {
        member.active = true;
        member.role = "member";
      } else w.members.push({ id: profile.id, role: "member", active: true });
      w.memberVersion++;
      audit(w, profile.id, "member.updated", profile.id, w.memberVersion, now);
    }
    updateMemberProfile(w, profile, now);
    w.accessLinkClaims.push({
      hash: digest,
      actor: profile.id,
      expiresAt: invitation.expiresAt,
    });
    // A prior manual request no longer needs an administrator's decision.
    const request = w.accessRequests?.find(
      (entry) => entry.actor === profile.id && entry.status === "pending",
    );
    if (request) {
      request.status = "approved";
      request.decidedAt = now.toISOString();
      request.decidedBy = profile.id;
      audit(
        w,
        profile.id,
        "access_request.approved",
        request.id,
        w.memberVersion,
        now,
      );
    }
    audit(
      w,
      profile.id,
      "access_link.redeemed",
      profile.id,
      w.memberVersion,
      now,
    );
    return true;
  }
}
