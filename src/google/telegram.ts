import type { Delivery, Deployment, Workspace } from "../domain.ts";
import { requireThat } from "../domain.ts";
import type { SearchConsoleService } from "../search-console/service.ts";
import { command, type Update } from "../telegram/router.ts";
import { authorize } from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import { type GoogleService, googleUserScope } from "./service.ts";

function propertyMenu(w: Workspace, actor: string, page: number) {
  const draft = w.googleUsers?.[actor]?.properties;
  requireThat(draft, "google_properties_expired", 409);
  const pages = Math.max(1, Math.ceil(draft.items.length / 10));
  requireThat(
    Number.isSafeInteger(page) && page >= 0 && page < pages,
    "invalid_request",
  );
  const buttons: NonNullable<Delivery["buttons"]> = draft.items
    .slice(page * 10, page * 10 + 10)
    .map((site, i) => [
      {
        text: `${draft.selected.includes(site) ? "✓ " : ""}${site}`.slice(
          0,
          64,
        ),
        callback_data: `google_site:${draft.key}:${page * 10 + i}`,
      },
    ]);
  const navigation = [];
  if (page > 0)
    navigation.push({
      text: "Previous",
      callback_data: `google_page:${draft.key}:${page - 1}`,
    });
  if (page + 1 < pages)
    navigation.push({
      text: "Next",
      callback_data: `google_page:${draft.key}:${page + 1}`,
    });
  if (navigation.length) buttons.push(navigation);
  buttons.push([
    { text: "Save", callback_data: `google_save:${draft.key}` },
    { text: "Cancel", callback_data: `google_cancel:${draft.key}` },
  ]);
  return {
    text: `Your Search Console properties · ${w.settings.name}\nChoose up to 20 properties. Selected: ${draft.selected.length}. Page ${page + 1}/${pages}.${draft.items.length ? "" : "\nNo verified properties are available for this Google account."}\nSave applies this selection only to your account in this workspace.`,
    buttons,
  };
}

export async function googleControl(
  w: Workspace,
  u: Update,
  d: Deployment,
  google?: GoogleService,
  search?: SearchConsoleService,
) {
  const msg = u.message;
  const cmd = msg && d.bot ? command(msg, d.bot) : undefined;
  const callback = u.callback_query;
  if (cmd?.name !== "google" && !callback?.data?.startsWith("google_"))
    return false;
  const sender = msg?.from ?? callback?.from;
  const chat = msg?.chat ?? callback?.message?.chat;
  const actor = String(sender?.id ?? "");
  authorize(w, actor);
  requireThat(
    sender &&
      !sender.is_bot &&
      !(msg?.sender_chat ?? callback?.message?.sender_chat) &&
      chat?.type === "private" &&
      String(chat.id) === actor,
    "use_private_chat",
    403,
  );
  requireThat(google && d.bot, "google_not_configured", 409);
  let text: string;
  let buttons: Delivery["buttons"];
  if (cmd) {
    if (cmd.args === "disconnect") {
      google.disconnect(w, actor);
      text =
        "Your Google account is disconnected from this workspace. Send /google to connect again. Revoke provider access separately in your Google account settings.";
    } else if (cmd.args === "properties") {
      requireThat(search, "google_not_configured", 409);
      await search.properties(w, actor, d.bot.id);
      ({ text, buttons } = propertyMenu(w, actor, 0));
    } else if (["", "status", "connect", "reconnect"].includes(cmd.args)) {
      const user = w.googleUsers?.[actor];
      if (
        (cmd.args === "" || cmd.args === "status") &&
        user?.connection &&
        user.botId === d.bot.id
      ) {
        const state =
          user.connection.reconnectRequired ||
          (user.connection.refresh &&
            Date.parse(user.connection.refresh.at) + 30000 <= Date.now())
            ? "Reconnect required"
            : user.connection.refresh
              ? "Refreshing connection"
              : "Connected";
        text = `Google · ${w.settings.name}\n${state}: ${user.connection.account}\n${w.plugins?.google?.google?.settings.enabled ? "Plugin enabled" : "Plugin disabled by the administrator"}\nSearch Console: ${user.siteUrls.length} selected properties\n/google connect — connect or reconnect\n/google properties — choose Search Console properties\n/google disconnect — disconnect your account`;
      } else if (cmd.args === "status")
        text = `No Google account connected in ${w.settings.name}. Send /google to connect.`;
      else {
        const url = await google.begin(w, actor, d.bot.id);
        text = `Connect your Google account to ${w.settings.name} within 10 minutes, then return here and confirm the account. Your Google data is available only to you in private conversations.`;
        buttons = [[{ text: "Connect Google account", url }]];
      }
    } else
      text =
        "Use /google to connect or view status, /google connect to reconnect, /google properties to select Search Console properties, or /google disconnect.";
  } else {
    requireThat(
      d.active && !d.paused && !w.settings.paused,
      "deployment_paused",
      409,
    );
    const [action, key, rawIndex] = (callback?.data ?? "").split(":");
    requireThat(key && /^[A-Za-z0-9_-]{43}$/.test(key), "invalid_request");
    if (action === "google_confirm" || action === "google_reject") {
      text = await google.confirm(
        w,
        actor,
        d.bot.id,
        Buffer.from(key, "base64url").toString("hex"),
        action === "google_confirm",
      );
    } else {
      const { user, connection } = googleUserScope(w, actor, d.bot.id);
      const draft = user.properties;
      requireThat(
        draft &&
          draft.key === key &&
          draft.connectionId === connection.id &&
          draft.revision === w.plugins?.revision &&
          Date.parse(draft.expiresAt) > Date.now(),
        "google_properties_expired",
        409,
      );
      if (action === "google_save") {
        requireThat(search, "google_not_configured", 409);
        await search.saveProperties(w, actor, d.bot.id, key);
        text = `Saved ${user.siteUrls.length} Search Console properties for your Google account.`;
      } else if (action === "google_cancel") {
        delete user.properties;
        text =
          "Search Console selection cancelled. Your saved selection is unchanged.";
      } else {
        requireThat(rawIndex && /^\d{1,4}$/.test(rawIndex), "invalid_request");
        const index = Number(rawIndex);
        if (action === "google_site") {
          const site = draft.items[index];
          requireThat(site, "invalid_request");
          if (draft.selected.includes(site))
            draft.selected = draft.selected.filter((s) => s !== site);
          else {
            requireThat(
              draft.selected.length < 20,
              "google_property_limit",
              409,
            );
            draft.selected.push(site);
          }
          ({ text, buttons } = propertyMenu(w, actor, Math.floor(index / 10)));
        } else {
          requireThat(action === "google_page", "invalid_request");
          ({ text, buttons } = propertyMenu(w, actor, index));
        }
      }
    }
  }
  const deliveryId = deliver(w, actor, actor, text, {
    id: `event:${u.update_id}:google`,
    buttons,
    topicId: msg?.message_thread_id ?? callback?.message?.message_thread_id,
  });
  const delivery = w.deliveries.find((d) => d.id === deliveryId);
  const user = w.googleUsers?.[actor];
  if (delivery)
    delivery.googleControl = {
      botId: d.bot.id,
      ...(user?.connection && !buttons
        ? { connectionId: user.connection.id }
        : {}),
      ...(user?.flow && buttons?.[0]?.[0]?.url
        ? { flow: { hash: user.flow.stateHash, phase: "oauth" as const } }
        : {}),
      ...(user?.properties &&
      buttons?.some((row) =>
        row.some((b) => b.callback_data?.startsWith("google_save:")),
      )
        ? { properties: user.properties.key }
        : {}),
    };
  return true;
}
