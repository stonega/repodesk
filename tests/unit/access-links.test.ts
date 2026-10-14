import { describe, expect, test } from "bun:test";
import { sweep } from "../../src/privacy/service.ts";
import { AccessLinks } from "../../src/workspaces/access-links.ts";
import { requestAccess } from "../../src/workspaces/access-requests.ts";
import { eligible } from "../../src/workspaces/policy.ts";
import { workspace } from "../fixtures.ts";

const links = new AccessLinks("ab".repeat(32));
const bot = { id: "999", username: "fixture_bot" };
const now = new Date("2026-10-14T12:00:00Z");
const later = (ms: number) => new Date(now.getTime() + ms);
function invitation(w = workspace(), at = now) {
  const view = links.view(w, bot, at);
  const start = new URL(view.requestUrl ?? "").searchParams.get("start") ?? "";
  return { w, view, start, raw: start.slice(7) };
}

describe("single-account access links", () => {
  test("uses Telegram's start alphabet and length, with refresh and expiry metadata", () => {
    const { w, view, start, raw } = invitation();
    expect(start).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(start.length).toBeLessThanOrEqual(64);
    expect(view.refreshAt).toBe(later(10_000).toISOString());
    expect(view.expiresAt).toBe(later(86_400_000).toISOString());
    expect(links.resolve(raw, bot.id, now)?.workspaceId).toBe(w.id);
    expect(links.view(w).requestUrl).toBeNull();
  });

  test("refreshes the token while keeping a copied token valid for 24 hours", () => {
    const { w, raw, view } = invitation();
    expect(invitation(w, later(10_000)).view.requestUrl).not.toBe(
      view.requestUrl,
    );
    expect(links.resolve(raw, bot.id, later(86_399_999))).toBeDefined();
    expect(links.resolve(raw, bot.id, later(86_400_000))).toBeUndefined();
    expect(links.resolve(raw, bot.id, later(-1))).toBeUndefined();
  });

  test("rejects tampering, malformed tokens, wrong keys, bots and workspaces", () => {
    const { w, raw } = invitation();
    for (const token of ["", w.id, `${raw}a`, raw.slice(1), `x${raw.slice(1)}`])
      expect(links.resolve(token, bot.id, now)).toBeUndefined();
    expect(links.resolve(raw, "1000", now)).toBeUndefined();
    expect(
      new AccessLinks("cd".repeat(32)).resolve(raw, bot.id, now),
    ).toBeUndefined();
    const other = workspace();
    expect(links.redeem(other, raw, bot.id, { id: "404" }, now)).toBe(false);
    expect(other.accessLinkClaims).toBeUndefined();
    w.deletion = { requestedAt: now.toISOString(), providerState: "pending" };
    expect(links.view(w, bot, now).requestUrl).toBeNull();
    expect(links.redeem(w, raw, bot.id, { id: "404" }, now)).toBe(false);
  });

  test("enrolls a regular member immediately, with the actual Telegram profile", () => {
    const { w, raw } = invitation();
    const version = w.memberVersion;
    expect(
      links.redeem(
        w,
        raw,
        bot.id,
        { id: "404", name: "Alex", username: "alex" },
        now,
      ),
    ).toBe(true);
    expect(w.members.find((m) => m.id === "404")).toMatchObject({
      active: true,
      role: "member",
      name: "Alex",
      username: "alex",
    });
    expect(w.memberVersion).toBe(version + 1);
    expect(w.accessRequests).toBeUndefined();
    expect(w.accessLinkClaims).toHaveLength(1);
    expect(JSON.stringify(w.accessLinkClaims)).not.toContain(raw);
    expect(w.runs).toHaveLength(0);
    expect(w.audit.at(-1)?.action).toBe("access_link.redeemed");
  });

  test("binds a token to one account across saves and never restores revoked access", () => {
    const { w, raw } = invitation();
    links.redeem(w, raw, bot.id, { id: "404" }, now);
    const saved = JSON.parse(JSON.stringify(w)) as typeof w;
    const version = saved.memberVersion;
    expect(links.redeem(saved, raw, bot.id, { id: "505" }, now)).toBe(false);
    expect(links.redeem(saved, raw, bot.id, { id: "404" }, now)).toBe(true);
    expect(saved.members.filter((m) => m.id === "404")).toHaveLength(1);
    expect(saved.memberVersion).toBe(version);
    const member = saved.members.find((m) => m.id === "404");
    if (!member) throw Error("Missing fixture");
    member.active = false;
    expect(links.redeem(saved, raw, bot.id, { id: "404" }, now)).toBe(false);
    expect(eligible(saved, "404")).toBe(false);
    expect(
      links.redeem(
        saved,
        invitation(saved, later(10_000)).raw,
        bot.id,
        { id: "404" },
        later(10_000),
      ),
    ).toBe(true);
  });

  test("existing active members consume the token and keep their role", () => {
    const { w, raw } = invitation();
    const version = w.memberVersion;
    expect(links.redeem(w, raw, bot.id, { id: "303" }, now)).toBe(true);
    expect(w.members.find((m) => m.id === "303")?.role).toBe("admin");
    expect(w.memberVersion).toBe(version);
    expect(links.redeem(w, raw, bot.id, { id: "404" }, now)).toBe(false);
  });

  test("reactivates regular membership without restoring admin roles or revoked owners", () => {
    const { w, raw } = invitation();
    const admin = w.members.find((m) => m.id === "303");
    const owner = w.members.find((m) => m.id === "101");
    if (!admin || !owner) throw Error("Missing fixture");
    admin.active = false;
    owner.active = false;
    expect(links.redeem(w, raw, bot.id, { id: "101" }, now)).toBe(false);
    expect(links.redeem(w, raw, bot.id, { id: "303" }, now)).toBe(true);
    expect(admin.role).toBe("member");
    expect(owner.active).toBe(false);
  });

  test("resolves prior pending requests and removes claims only after token expiry or purge", () => {
    const { w, raw } = invitation();
    const request = requestAccess(w, { actor: "404", chatId: "404" }, now);
    links.redeem(w, raw, bot.id, { id: "404" }, now);
    expect(request.status).toBe("approved");
    sweep(w, later(86_399_999));
    expect(w.accessLinkClaims).toHaveLength(1);
    sweep(w, later(86_400_000));
    expect(w.accessLinkClaims).toHaveLength(0);
    expect(links.redeem(w, raw, bot.id, { id: "505" }, later(86_400_000))).toBe(
      false,
    );
    w.deletion = { requestedAt: now.toISOString(), providerState: "pending" };
    sweep(w, now);
    expect(w.accessLinkClaims).toHaveLength(0);
  });
});
