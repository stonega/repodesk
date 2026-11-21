import {
  browserDeliveryAllowed,
  browserReadAllowed,
} from "../browser/privacy.ts";
import { browserTaskButtons, browserTaskStatus } from "../browser/tasks.ts";
import { taskGet } from "../coding/task-store.ts";
import { checkDevelopment } from "../coding/tasks.ts";
import type { Sql } from "../db/pool.ts";
import type { Store } from "../db/repositories.ts";
import {
  type Delivery,
  type Deployment,
  requireThat,
  type Workspace,
} from "../domain.ts";
import { notificationDeliveryAllowed } from "../github/notifications.ts";
import { repositoryDeliveryAllowed } from "../github/repository-context.ts";
import { googleDeliveryAllowed, googleReadAllowed } from "../google/policy.ts";
import { referenceMemoryValid } from "../memory/state.ts";
import { taskReference } from "../miniapp/auth.ts";
import { nowledgeReadAllowed } from "../nowledge-mem/policy.ts";
import { pluginNotificationDeliveryAllowed } from "../plugins/notifications.ts";
import { searchConsoleReadAllowed } from "../search-console/policy.ts";
import { reactionDeliveryAllowed } from "../telegram/reactions.ts";
import {
  cleanupTaskButtons,
  confirmTaskMessage,
  developmentMessageTask,
  sameTaskAudience,
  withoutTaskControls,
} from "../telegram/task-control-messages.ts";
import { selectionAllowed } from "../telegram/task-controls.ts";
import { widgetDeliveryAllowed } from "../telegram/widgets.ts";

export type DeliveryKind =
  | "reaction"
  | "widget"
  | "task_controls_cleanup"
  | "task_edit"
  | "github_notification"
  | "plugin_notification"
  | "browser_request"
  | "browser_resume"
  | "browser_status"
  | "google_control"
  | "repository_menu"
  | "cancellation"
  | "development_feedback"
  | "chat_reply";

/** Semantic classification of a delivery intent for policy routing and diagnostics. */
export function deliveryKind(d: Delivery): DeliveryKind {
  if (d.reaction) return "reaction";
  if (d.widget) return "widget";
  if (d.taskControlsCleanup) return "task_controls_cleanup";
  if (d.editOf) return "task_edit";
  if (d.githubNotification) return "github_notification";
  if (d.pluginNotification) return "plugin_notification";
  if (d.browserRequest) return "browser_request";
  if (d.browserResume) return "browser_resume";
  if (d.browserTaskState) return "browser_status";
  if (d.googleControl) return "google_control";
  if (d.repositoryMenu) return "repository_menu";
  if (d.cancellationRunId) return "cancellation";
  if (d.feedback?.owner === "development") return "development_feedback";
  return "chat_reply";
}

export interface DeliveryPolicyContext {
  store: Store;
  sql: Sql;
  workspace: Workspace;
  delivery: Delivery;
  deployment: () => Promise<Deployment>;
}

export interface DeliveryPolicy {
  readonly name: string;
  applies(delivery: Delivery): boolean;
  allow(ctx: DeliveryPolicyContext): boolean | Promise<boolean>;
}

export interface DeliveryLifecycleHooks {
  refreshBeforeClaim(w: Workspace, d: Delivery, bot: Deployment["bot"]): void;
  shouldDeferClaim(w: Workspace, d: Delivery, botId?: string): boolean;
  validateTaskAudience(
    sql: Sql,
    w: Workspace,
    d: Delivery,
    botId: string | undefined,
    verifyCurrentBot?: () => Promise<string | undefined>,
  ): Promise<void>;
  prepareButtons(
    workspaceId: string,
    w: Workspace,
    d: Delivery,
    bot: Deployment["bot"],
  ): { cancelled: boolean; buttons: Delivery["buttons"] };
  onComplete(w: Workspace, d: Delivery, sentButtons: Delivery["buttons"]): void;
  markTaskUneditable(w: Workspace, intent: Delivery): void;
}

export class DeliveryPolicyRegistry {
  constructor(
    private readonly policies: DeliveryPolicy[],
    readonly hooks: DeliveryLifecycleHooks,
  ) {}

  async allowed(
    store: Store,
    workspace: Workspace,
    delivery: Delivery,
    sql: Sql = store.pool,
  ): Promise<boolean> {
    let cachedDeployment: Promise<Deployment> | undefined;
    const ctx: DeliveryPolicyContext = {
      store,
      sql,
      workspace,
      delivery,
      deployment: () => {
        cachedDeployment ??= store.deployment(sql);
        return cachedDeployment;
      },
    };
    for (const policy of this.policies) {
      if (!policy.applies(delivery)) continue;
      if (!(await policy.allow(ctx))) return false;
    }
    return true;
  }
}

const notificationPolicy: DeliveryPolicy = {
  name: "notifications",
  applies: (d) => Boolean(d.githubNotification || d.pluginNotification),
  async allow({ workspace: w, delivery: d, deployment }) {
    const dep = await deployment();
    return (
      dep.active &&
      !dep.paused &&
      !w.settings.paused &&
      notificationDeliveryAllowed(w, d, dep.bot?.id) &&
      pluginNotificationDeliveryAllowed(w, d, dep.bot?.id)
    );
  },
};

const repositoryMemoryPolicy: DeliveryPolicy = {
  name: "repository_memory",
  applies: (d) => Boolean(d.repositoryMemory),
  async allow({ sql, workspace: w, delivery: d, deployment }) {
    if (!d.repositoryMemory) return true;
    try {
      const task = await taskGet(sql, w.id, d.repositoryMemory.taskId);
      checkDevelopment(w, task, d.actor, false, true);
      if (
        task.contentRemoved ||
        task.botId !== (await deployment()).bot?.id ||
        task.chatId !== d.chatId ||
        task.topicId !== d.topicId ||
        !referenceMemoryValid(w, d.repositoryMemory.refs, d.actor, task.botId)
      ) {
        d.text = "";
        d.buttons = undefined;
        return false;
      }
      return true;
    } catch {
      return false;
    }
  },
};

const browserTaskStatePolicy: DeliveryPolicy = {
  name: "browser_task_state",
  applies: (d) => Boolean(d.browserTaskState),
  allow({ workspace: w, delivery: d }) {
    const expected = d.browserTaskState;
    if (!expected) return true;
    const run = w.runs.find((r) => r.id === d.runId);
    return Boolean(
      run &&
        !run.cancelled &&
        run.actor === d.actor &&
        run.chatId === d.chatId &&
        run.topicId === d.topicId &&
        run.status === expected.status &&
        run.fence === expected.fence &&
        run.browserWait?.id === expected.requestId &&
        run.error === expected.error,
    );
  },
};

const browserResumePolicy: DeliveryPolicy = {
  name: "browser_resume",
  applies: (d) => Boolean(d.browserResume),
  async allow({ sql, workspace: w, delivery: d, deployment }) {
    if (!d.browserResume) return true;
    if (d.browserResume.taskId) {
      try {
        const task = await taskGet(sql, w.id, d.browserResume.taskId);
        checkDevelopment(w, task);
        return (
          !task.cancelRequested &&
          !task.contentRemoved &&
          task.state === "working" &&
          task.actor === d.actor &&
          task.chatId === d.chatId &&
          task.topicId === d.topicId &&
          task.botId === (await deployment()).bot?.id &&
          !task.browserWait &&
          task.browserResumed?.at(-1) === d.browserResume.id
        );
      } catch {
        return false;
      }
    }
    return w.runs.some(
      (run) =>
        run.id === d.runId &&
        run.actor === d.actor &&
        run.chatId === d.chatId &&
        run.topicId === d.topicId &&
        !run.cancelled &&
        !run.browserWait &&
        ["queued", "running"].includes(run.status) &&
        run.browserResumed?.at(-1) === d.browserResume?.id,
    );
  },
};

const browserRequestPolicy: DeliveryPolicy = {
  name: "browser_request",
  applies: (d) => Boolean(d.browserRequest),
  async allow({ sql, workspace: w, delivery: d }) {
    if (!d.browserRequest) return true;
    if (d.browserRequest.taskId) {
      try {
        const task = await taskGet(sql, w.id, d.browserRequest.taskId);
        return (
          !task.cancelRequested &&
          task.state === "working" &&
          task.actor === d.actor &&
          task.chatId === d.chatId &&
          task.browserWait?.id === d.browserRequest.id &&
          d.browserRequest.expiresAt > Date.now()
        );
      } catch {
        return false;
      }
    }
    return Boolean(
      d.runId &&
        d.browserRequest.expiresAt > Date.now() &&
        w.runs.some(
          (run) =>
            run.id === d.runId &&
            run.browserWait?.id === d.browserRequest?.id &&
            run.actor === d.actor &&
            run.chatId === d.chatId &&
            !run.cancelled &&
            ["running", "awaiting_approval"].includes(run.status),
        ),
    );
  },
};

const browserReadPolicy: DeliveryPolicy = {
  name: "browser_read",
  applies: (d) => Boolean(d.browserRead),
  async allow({ workspace: w, delivery: d, deployment }) {
    return browserDeliveryAllowed(w, d, (await deployment()).bot?.id);
  },
};

const reactionAndWidgetPolicy: DeliveryPolicy = {
  name: "reaction_and_widget",
  applies: (d) => Boolean(d.reaction || d.widget),
  async allow({ workspace: w, delivery: d, deployment }) {
    const dep = await deployment();
    return (
      dep.active &&
      !dep.paused &&
      reactionDeliveryAllowed(w, d, dep.bot?.id) &&
      widgetDeliveryAllowed(w, d, dep.bot?.id)
    );
  },
};

const googleControlPolicy: DeliveryPolicy = {
  name: "google_control",
  applies: (d) => Boolean(d.googleControl),
  async allow({ workspace: w, delivery: d, deployment }) {
    return googleDeliveryAllowed(w, d, (await deployment()).bot?.id);
  },
};

const runReadProvenancePolicy: DeliveryPolicy = {
  name: "run_read_provenance",
  applies: (d) => Boolean(d.runId),
  async allow({ workspace: w, delivery: d, deployment }) {
    const run = w.runs.find((r) => r.id === d.runId);
    if (!run) return true;
    const botId = (await deployment()).bot?.id;
    return (
      browserReadAllowed(w, run, botId) &&
      googleReadAllowed(w, run, botId) &&
      searchConsoleReadAllowed(w, run, botId) &&
      nowledgeReadAllowed(w, run, botId)
    );
  },
};

const repositoryScopePolicy: DeliveryPolicy = {
  name: "repository_scope",
  applies: () => true,
  allow({ workspace: w, delivery: d }) {
    return repositoryDeliveryAllowed(w, d);
  },
};

const taskSelectionPolicy: DeliveryPolicy = {
  name: "task_selection",
  applies: () => true,
  allow({ sql, workspace: w, delivery: d }) {
    return selectionAllowed(sql, w, d);
  },
};

const cancellationPolicy: DeliveryPolicy = {
  name: "cancellation",
  applies: (d) => Boolean(d.cancellationRunId),
  allow({ workspace: w, delivery: d }) {
    const r = w.runs.find((r) => r.id === d.cancellationRunId);
    if (
      !r?.cancelled ||
      r.actor !== d.actor ||
      r.chatId !== d.chatId ||
      r.topicId !== d.topicId
    )
      return false;
    if (d.id.endsWith(":requested") && r.stopConfirmed) return false;
    return true;
  },
};

const feedbackPolicy: DeliveryPolicy = {
  name: "feedback",
  applies: (d) => Boolean(d.feedback),
  async allow({ sql, workspace: w, delivery: d }) {
    // Old queued chat notices must also stay silent after an upgrade.
    if (d.feedback?.owner === "run") return false;
    if (d.feedback?.owner === "development") {
      try {
        const t = await taskGet(sql, w.id, d.feedback.id);
        return (
          !t.cancelRequested &&
          (d.feedback.key === "queued"
            ? t.state === "queued"
            : ["working", "publishing"].includes(t.state) &&
              t.progress?.key === d.feedback.key &&
              !t.progress.unavailable)
        );
      } catch {
        return false;
      }
    }
    return true;
  },
};

const defaultHooks: DeliveryLifecycleHooks = {
  refreshBeforeClaim(w, d, bot) {
    if (!d.browserTaskState?.refresh) return;
    const run = w.runs.find((r) => r.id === d.runId);
    if (!run) return;
    d.text = browserTaskStatus(run);
    d.browserTaskState = {
      refresh: true,
      status: run.status,
      fence: run.fence,
      requestId: run.browserWait?.id,
      error: run.error,
    };
    d.buttons = browserTaskButtons(w, run, bot);
  },
  shouldDeferClaim(w, d, botId) {
    if (
      d.browserRequest &&
      !d.browserRequest.taskId &&
      w.runs.some(
        (run) =>
          run.id === d.runId &&
          run.browserWait?.id === d.browserRequest?.id &&
          run.status === "running",
      )
    )
      return true;
    const taskId = developmentMessageTask(d);
    if (
      taskId &&
      w.deliveries.some(
        (other) =>
          other.id !== d.id &&
          other.state === "sending" &&
          Date.parse(other.startedAt ?? "1970-01-01") > Date.now() - 30000 &&
          sameTaskAudience(other, { ...d, botId }),
      )
    )
      return true;
    return false;
  },
  async validateTaskAudience(sql, w, d, botId, verifyCurrentBot) {
    const taskId = developmentMessageTask(d);
    if (!taskId) return;
    const task = await taskGet(sql, w.id, taskId);
    requireThat(
      task.botId === botId &&
        (!verifyCurrentBot || (await verifyCurrentBot()) === d.botId),
      "delivery_revoked",
      403,
    );
    checkDevelopment(
      w,
      task,
      d.actor,
      d.id.includes(":cancel:") ||
        (!!d.taskControlsCleanup &&
          task.cancelRequested &&
          task.actor === d.actor),
      d.id.includes(":status:") || !!d.taskControlsCleanup,
    );
  },
  prepareButtons(workspaceId, w, d, bot) {
    let buttons = d.buttons;
    const taskId = developmentMessageTask(d);
    if (d.taskControlsCleanup) {
      buttons = cleanupTaskButtons(w, d);
      if (buttons === undefined) return { cancelled: true, buttons: undefined };
    } else if (taskId) {
      buttons = withoutTaskControls(buttons, taskId);
    }
    const developmentId = /^development:([0-9a-f-]{36}):/.exec(d.id)?.[1];
    if (developmentId && bot?.username) {
      buttons = [
        ...(buttons ?? []),
        [
          {
            text: "View conversation",
            url: `https://t.me/${bot.username}?startapp=${taskReference(workspaceId, developmentId)}`,
          },
        ],
      ];
    }
    return { cancelled: false, buttons };
  },
  onComplete(w, d, sentButtons) {
    confirmTaskMessage(w, d, sentButtons);
  },
  markTaskUneditable(w, intent) {
    for (const old of w.deliveries)
      if (sameTaskAudience(old, intent) && old.remoteId === intent.remoteId)
        old.editUnavailable = true;
  },
};

export function defaultDeliveryPolicies(): DeliveryPolicyRegistry {
  return new DeliveryPolicyRegistry(
    [
      notificationPolicy,
      repositoryMemoryPolicy,
      browserTaskStatePolicy,
      browserResumePolicy,
      browserRequestPolicy,
      browserReadPolicy,
      reactionAndWidgetPolicy,
      googleControlPolicy,
      runReadProvenancePolicy,
      repositoryScopePolicy,
      taskSelectionPolicy,
      cancellationPolicy,
      feedbackPolicy,
    ],
    defaultHooks,
  );
}
