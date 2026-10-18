import type { Delivery, Workspace } from "../domain.ts";

export function developmentMessageTask(d: Delivery) {
  if (d.taskControlsCleanup)
    return d.id.startsWith(
      `task-controls:${d.botId}:${d.taskControlsCleanup.taskId}:`,
    )
      ? d.taskControlsCleanup.taskId
      : undefined;
  return /^development:([0-9a-f-]{36}):/.exec(d.id)?.[1];
}

export function sameTaskAudience(a: Delivery, b: Delivery) {
  return (
    !!developmentMessageTask(a) &&
    developmentMessageTask(a) === developmentMessageTask(b) &&
    a.actor === b.actor &&
    a.botId === b.botId &&
    a.chatId === b.chatId &&
    a.topicId === b.topicId
  );
}

export function withoutTaskControls(
  buttons: Delivery["buttons"],
  taskId: string,
) {
  return buttons
    ?.map((row) =>
      row.filter(
        (button) =>
          !(
            "callback_data" in button &&
            (button.callback_data === `tds:${taskId}` ||
              button.callback_data === `tdc:${taskId}`)
          ),
      ),
    )
    .filter((row) => row.length);
}

function hasTaskControls(buttons: Delivery["buttons"], taskId: string) {
  return (
    buttons
      ?.flat()
      .some(
        (button) =>
          button.callback_data === `tds:${taskId}` ||
          button.callback_data === `tdc:${taskId}`,
      ) ?? false
  );
}

/** Backfill retained legacy message identities once; edits share their original order. */
function messageOrders(w: Workspace, scope: Delivery) {
  const messages = w.deliveries.filter(
    (d) =>
      sameTaskAudience(d, scope) &&
      !d.taskControlsCleanup &&
      d.state === "sent" &&
      d.remoteId !== undefined,
  );
  const orders = new Map<number, number>();
  for (const d of messages)
    if (d.remoteId !== undefined && d.taskMessageSequence !== undefined)
      orders.set(d.remoteId, d.taskMessageSequence);
  for (const [index, d] of messages.entries()) {
    if (d.remoteId === undefined) continue;
    let order = orders.get(d.remoteId);
    if (order === undefined) {
      order = index - messages.length;
      orders.set(d.remoteId, order);
    }
    d.taskMessageSequence = order;
  }
  return messages;
}

export function latestTaskMessage(w: Workspace, scope: Delivery) {
  return messageOrders(w, scope).reduce<Delivery | undefined>(
    (latest, d) =>
      !latest ||
      (d.taskMessageSequence ?? 0) >= (latest.taskMessageSequence ?? 0)
        ? d
        : latest,
    undefined,
  );
}

/** Called after confirmed sends/edits, in the same workspace transaction. */
export function confirmTaskMessage(
  w: Workspace,
  d: Delivery,
  buttons = d.buttons,
) {
  if (d.state !== "sent") return;
  const taskId = developmentMessageTask(d);
  if (!taskId || d.remoteId === undefined) return;
  d.buttons = buttons;
  const messages = messageOrders(w, d);
  if (d.taskControlsCleanup) {
    for (const previous of messages)
      if (previous.remoteId === d.remoteId) previous.sentButtons = d.buttons;
    return;
  }
  const aliases = messages.filter(
    (previous) => previous.remoteId === d.remoteId && previous.id !== d.id,
  );
  d.taskMessageSequence =
    d.editOf && aliases.length
      ? aliases[0]?.taskMessageSequence
      : Math.max(
          0,
          ...messages
            .filter((previous) => previous.id !== d.id)
            .map((previous) => previous.taskMessageSequence ?? 0),
        ) + 1;
  for (const message of [...aliases, d]) {
    message.taskMessageSequence = d.taskMessageSequence;
    message.buttons = d.buttons;
    message.sentButtons = d.buttons;
  }
  const latest = latestTaskMessage(w, d);
  if (!latest) return;
  const seen = new Set<number>();
  for (const previous of messages) {
    if (
      previous.remoteId === undefined ||
      previous.remoteId === latest.remoteId
    )
      continue;
    const sentButtons = previous.sentButtons ?? previous.buttons;
    previous.sentButtons = sentButtons;
    // Revoke stale callbacks immediately, even if Telegram rejects/defers the edit.
    previous.buttons = withoutTaskControls(previous.buttons, taskId);
    if (
      previous.editUnavailable ||
      seen.has(previous.remoteId) ||
      !hasTaskControls(sentButtons, taskId)
    )
      continue;
    seen.add(previous.remoteId);
    // Reuse in-flight cleanup, including its rate-limit backoff, as updates arrive.
    if (
      w.deliveries.some(
        (intent) =>
          intent.taskControlsCleanup &&
          sameTaskAudience(intent, d) &&
          intent.remoteId === previous.remoteId &&
          ["pending", "sending"].includes(intent.state),
      )
    )
      continue;
    const id = `task-controls:${d.botId}:${taskId}:${d.actor}:${d.chatId}:${d.topicId}:${latest.taskMessageSequence}:${previous.remoteId}`;
    if (w.deliveries.some((intent) => intent.id === id)) continue;
    w.deliveries.push({
      id,
      actor: d.actor,
      botId: d.botId,
      chatId: d.chatId,
      topicId: d.topicId,
      text: "",
      state: "pending",
      at: new Date().toISOString(),
      attempts: 0,
      remoteId: previous.remoteId,
      taskControlsCleanup: { taskId, messageId: previous.remoteId },
    });
  }
}

/** Only remove callbacks; preserve PR actions and any other delivered links. */
export function cleanupTaskButtons(w: Workspace, cleanup: Delivery) {
  if (cleanup.taskControlsCleanup?.messageId !== cleanup.remoteId) return;
  const latest = latestTaskMessage(w, cleanup);
  if (!latest || latest.remoteId === cleanup.remoteId) return;
  const message = w.deliveries.findLast(
    (d) =>
      sameTaskAudience(d, cleanup) &&
      !d.taskControlsCleanup &&
      d.state === "sent" &&
      d.remoteId === cleanup.remoteId,
  );
  if (!message) return;
  const buttons = message.sentButtons ?? message.buttons;
  if (!hasTaskControls(buttons, cleanup.taskControlsCleanup?.taskId ?? ""))
    return;
  return withoutTaskControls(
    buttons,
    cleanup.taskControlsCleanup?.taskId ?? "",
  );
}
