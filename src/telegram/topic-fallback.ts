import { type Delivery, requireThat, type Workspace } from "../domain.ts";
import { audit, authorize } from "../workspaces/policy.ts";

/** Host recovery only: the operator must first obtain the named member's consent. */
export function configurePrivateTopicFallback(
  w: Workspace,
  operator: string,
  actor: string,
  botId: string,
  enabled: boolean,
  now = new Date(),
) {
  requireThat(operator === w.operatorId, "access_denied", 403);
  authorize(w, operator, true);
  const member = w.members.find((m) => m.id === actor && m.active);
  requireThat(member && botId, "destination_denied", 403);
  member.privateTopicFallback = enabled
    ? { botId, enabledAt: now.toISOString() }
    : undefined;
  // A fresh opt-in never restores an intent carrying an earlier consent.
  for (const d of w.deliveries)
    if (d.actor === actor && d.privateTopicFallback && d.state === "pending")
      d.state = "cancelled";
  w.memberVersion++;
  audit(
    w,
    operator,
    enabled
      ? "member.topic_fallback_enabled"
      : "member.topic_fallback_disabled",
    actor,
    w.memberVersion,
    now,
  );
}

/** Only ordinary run replies may move to the same consenting member's main chat. */
export function privateTopicFallback(
  w: Workspace,
  d: Delivery,
  botId?: string,
) {
  const consent = w.members.find(
    (m) => m.id === d.actor && m.active,
  )?.privateTopicFallback;
  const run = w.runs.find((r) => r.id === d.runId);
  if (
    w.deletion ||
    !botId ||
    !consent ||
    consent.botId !== botId ||
    d.botId !== botId ||
    (d.privateTopicFallback &&
      (d.privateTopicFallback.botId !== botId ||
        d.privateTopicFallback.enabledAt !== consent.enabledAt)) ||
    d.chatId !== d.actor ||
    d.topicId <= 0 ||
    !run ||
    run.actor !== d.actor ||
    run.chatId !== d.chatId ||
    run.topicId !== d.topicId ||
    run.workflowId ||
    ![`run:${run.id}:result`, `run:${run.id}:failure`].includes(d.id) ||
    d.buttons?.length ||
    d.widget ||
    d.reaction ||
    d.editOf ||
    d.progressMessage ||
    d.taskControlsCleanup ||
    d.repositoryMenu ||
    d.googleControl ||
    d.browserRequest ||
    d.browserResume ||
    d.browserTaskState ||
    d.browserRead ||
    d.browserSealed ||
    d.cancellationRunId
  )
    return;
  return structuredClone(consent);
}

export function privateTopicFallbackText(text: string) {
  return `Telegram couldn't reply in your Topic, so I'm replying here.\n\n${text}`;
}
