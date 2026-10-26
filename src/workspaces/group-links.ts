import type { Admin, Workspace } from "../domain.ts";
import { requireThat } from "../domain.ts";
import { hash, token } from "../setup/credentials.ts";
import { audit, eligible } from "./policy.ts";

/** Panel authority delegates group linking without linking the panel user's Telegram identity. */
export function groupLinkAuthority(w: Workspace, admin: Admin) {
  requireThat(
    !w.deletion &&
      ((admin.operator && w.operatorId === admin.id) ||
        (admin.telegramId && eligible(w, admin.telegramId, true))),
    "access_denied",
    403,
  );
}

export function issueGroupLink(
  w: Workspace,
  admin: Admin,
  bot: { id: string; username: string },
  now = new Date(),
) {
  groupLinkAuthority(w, admin);
  const raw = token();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  w.tokens = w.tokens.filter((entry) => entry.kind !== "group");
  w.tokens.push({
    kind: "group",
    hash: hash(raw),
    actor: admin.telegramId ?? admin.id,
    adminId: admin.id,
    botId: bot.id,
    expiresAt,
  });
  audit(w, admin.id, "chat.link_issued", w.id, undefined, now);
  return { command: `/link@${bot.username} ${raw}`, expiresAt };
}
