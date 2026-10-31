import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { operator } from "../admin/auth.ts";
import type { PluginRecord } from "../agent/plugin-config.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, Fault, requireThat } from "../domain.ts";
import { fingerprint } from "../setup/credentials.ts";
import {
  audit,
  eligible,
  revokeWork,
  runAllowed,
} from "../workspaces/policy.ts";
import { deliver } from "../workspaces/service.ts";
import {
  type BrowserAccessRequest,
  browserGrantPolicy,
  browserNeedsActionApproval,
  decideBrowserAccess,
  emptyBrowserAccess,
  grantBrowserSite,
  invalidateBrowserAccess,
  requestBrowserAccess,
} from "./access.ts";
import type { BrowserHost } from "./client.ts";
import type { CodexBrowsers } from "./codex.ts";
import {
  type BrowserController,
  type BrowserOwner,
  type BrowserPluginPage,
  browserAction,
  browserEnabled,
  browserGeneration,
  browserSave,
  browserSession,
  browserTools,
} from "./config.ts";
import { type BrowserAuthority, BrowserControl } from "./control.ts";
import { authorizeBrowserOwner } from "./policy.ts";
import { browserEpoch } from "./privacy.ts";
import {
  type BrowserRepository,
  PostgresBrowserRepository,
} from "./repository.ts";
import {
  type BrowserLease,
  type BrowserState,
  releaseBrowser,
  sameController,
} from "./state.ts";

export interface BrowserDirectory extends BrowserRepository {
  owners(workspaceId: string): Promise<BrowserOwner[]>;
}
export interface BrowserConsumer {
  owner: BrowserOwner;
  controller: BrowserController;
  configuration: number;
  epoch: number;
  botId: string;
  guard(phase: "active" | "waiting"): Promise<void>;
  waiting(requestId: string): Promise<void>;
  markPrivate(): Promise<void>;
  pause(
    request: {
      id: string;
      kind: "site" | "action" | "input" | "control";
      expiresAt: number;
    },
    callId: string,
    phase?: "active" | "waiting",
  ): Promise<void>;
  complete(
    callId: string,
    requestId: string,
    result: unknown,
  ): Promise<boolean>;
}
type ConsumerResolver = (
  owner: BrowserOwner,
  controller: BrowserController,
  configuration: number,
  epoch: number,
) => Promise<BrowserConsumer>;
const toolResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: {},
});
const operationKey = (consumer: BrowserConsumer, callId: string) =>
  `${consumer.controller.kind}:${consumer.controller.id}:${consumer.controller.fence}:${fingerprint(callId)}`;
const staleConsumer = (error: unknown) =>
  error instanceof Fault &&
  [
    "access_denied",
    "not_found",
    "browser_consumer_unavailable",
    "browser_configuration_changed",
    "browser_private_task_required",
    "browser_request_unavailable",
    "browser_control_expired",
    "coding_cancelled",
    "coding_configuration_changed",
  ].includes(error.code);

/** One broker for all consumers. Only trusted adapters construct consumer identity. */
export class BrowserService {
  coding?: CodexBrowsers;
  private repository?: BrowserDirectory;
  private control?: BrowserControl;
  private resolvers = new Map<BrowserController["kind"], ConsumerResolver>();
  private cursors = new Map<string, number>();
  private maintenance = new Map<string, Promise<void>>();
  constructor(
    private store: Store,
    key?: string,
    private host?: BrowserHost,
    repository?: BrowserDirectory,
  ) {
    if (key) store.configurePrivateState(key);
    this.repository =
      repository ??
      (key ? new PostgresBrowserRepository(store.pool, key) : undefined);
    if (this.repository && host)
      this.control = new BrowserControl(this.repository, host);
    this.resolvers.set("chat", (owner, controller, configuration, epoch) =>
      this.chatConsumer(owner, controller, configuration, epoch),
    );
    this.resolvers.set("plugin", (owner, controller, configuration, epoch) =>
      this.chatConsumer(owner, controller, configuration, epoch),
    );
  }
  get configured() {
    return !!this.control;
  }
  /** Trusted member UI adapter. Owner always comes from verified Telegram identity. */
  async personalRuntime(owner: BrowserOwner, botId: string, cleanup = false) {
    const initial = await this.store.read(owner.workspaceId);
    const guard = async () => {
      const w = await this.store.read(owner.workspaceId),
        deployment = await this.store.deployment();
      authorizeBrowserOwner(w, owner.actor, cleanup);
      requireThat(
        cleanup ||
          (browserGeneration(w) === browserGeneration(initial) &&
            browserEpoch(w, owner.actor) ===
              browserEpoch(initial, owner.actor)),
        "browser_authorization_expired",
        403,
      );
      requireThat(
        deployment.active && !deployment.paused && deployment.bot?.id === botId,
        "browser_authorization_expired",
        403,
      );
    };
    await guard();
    return { ...this.runtime(), guard };
  }
  registerConsumer(kind: "codex" | "plugin", resolver: ConsumerResolver) {
    requireThat(!this.resolvers.has(kind), "browser_consumer_conflict", 409);
    this.resolvers.set(kind, resolver);
  }
  async saveReceipt(
    consumer: BrowserConsumer,
    id: string,
    callId: string,
    result: NonNullable<BrowserAccessRequest["result"]>,
  ) {
    await consumer.guard("waiting");
    await this.runtime().repository.change(consumer.owner, (state) => {
      state.receipts ??= [];
      const previous = state.receipts.find((receipt) => receipt.id === id);
      if (previous) {
        requireThat(
          sameController(previous.controller, consumer.controller) &&
            previous.callId === callId,
          "browser_duplicate_conflict",
          409,
        );
        return;
      }
      state.receipts = state.receipts.filter(
        (receipt) => receipt.at > Date.now() - 24 * 3600_000,
      );
      requireThat(state.receipts.length < 256, "browser_capacity", 409);
      state.receipts.push({
        id,
        controller: consumer.controller,
        callId,
        at: Date.now(),
        result,
      });
    });
  }
  async receipt(consumer: BrowserConsumer, id: string) {
    await consumer.guard("active");
    const receipt = (
      await this.runtime().repository.read(consumer.owner)
    ).receipts?.find(
      (receipt) =>
        receipt.id === id &&
        sameController(receipt.controller, consumer.controller),
    );
    return receipt?.result;
  }
  private runtime() {
    requireThat(
      this.repository && this.host && this.control,
      "browser_service_unavailable",
      503,
    );
    return {
      repository: this.repository,
      host: this.host,
      control: this.control,
    };
  }
  async view(admin: Admin, workspaceId: string): Promise<BrowserPluginPage> {
    operator(admin);
    const w = await this.store.read(workspaceId);
    requireThat(!w.deletion && w.operatorId === admin.id, "access_denied", 403);
    return {
      revision: w.plugins?.revision ?? 0,
      settings: {
        enabled: browserEnabled(w),
        generation: browserGeneration(w),
        previewOrigins: [...(w.plugins?.browser?.previewOrigins ?? [])],
      },
      serviceConfigured: this.configured,
    };
  }
  async configure(
    admin: Admin,
    workspaceId: string,
    value: unknown,
    fallback: PluginRecord[] = [],
  ) {
    operator(admin);
    const input = browserSave.parse(value);
    const invalidated = await this.store.change(workspaceId, (w) => {
      requireThat(
        !w.deletion && w.operatorId === admin.id,
        "access_denied",
        403,
      );
      requireThat(
        (w.plugins?.revision ?? 0) === input.revision,
        "version_conflict",
        409,
      );
      const entries = w.plugins?.entries ?? fallback;
      const previewOrigins =
        input.settings.previewOrigins ??
        w.plugins?.browser?.previewOrigins ??
        [];
      for (const entry of input.settings.enabled ? entries : [])
        requireThat(
          !entry.enabled ||
            !entry.tools.some((tool) =>
              (browserTools as readonly string[]).includes(tool),
            ),
          "extension_tool_collision",
          409,
        );
      const changed =
        browserEnabled(w) !== input.settings.enabled ||
        fingerprint(w.plugins?.browser?.previewOrigins ?? []) !==
          fingerprint(previewOrigins);
      w.plugins = {
        ...w.plugins,
        revision: input.revision + 1,
        entries,
        browser: {
          ...input.settings,
          previewOrigins,
          generation: browserGeneration(w) + Number(changed),
        },
      };
      if (changed) revokeWork(w);
      audit(w, admin.id, "plugins.updated", "browser", w.plugins.revision);
      return changed;
    });
    if (invalidated && this.repository)
      for (const owner of await this.repository.owners(workspaceId))
        await this.scheduleCleanup(owner, "close");
    return this.view(admin, workspaceId);
  }
  async executionFence(workspaceId: string, runId: string) {
    const w = await this.store.read(workspaceId);
    return w.runs.find((run) => run.id === runId)?.fence ?? 0;
  }
  private async chatConsumer(
    owner: BrowserOwner,
    controller: BrowserController,
    configuration: number,
    epoch: number,
  ): Promise<BrowserConsumer> {
    const guard = async (phase: "active" | "waiting") => {
      const [w, d] = await Promise.all([
        this.store.read(owner.workspaceId),
        this.store.deployment(),
      ]);
      authorizeBrowserOwner(w, owner.actor);
      requireThat(
        d.active && !d.paused && d.bot,
        "browser_consumer_unavailable",
        403,
      );
      const run = w.runs.find((run) => run.id === controller.id);
      requireThat(
        (controller.kind === "chat" || controller.kind === "plugin") &&
          run &&
          run.actor === owner.actor &&
          run.fence === controller.fence &&
          runAllowed(w, run),
        "access_denied",
        403,
      );
      if (controller.kind === "plugin")
        requireThat(
          controller.pluginRevision === (w.plugins?.revision ?? 0) &&
            w.plugins?.entries.some(
              (entry) =>
                entry.id === controller.pluginId &&
                entry.enabled &&
                entry.browserAccess &&
                entry.workspaces.includes(w.id),
            ),
          "browser_consumer_unavailable",
          403,
        );
      requireThat(
        run.chatId === owner.actor && !run.workflowId,
        "browser_private_task_required",
        403,
      );
      requireThat(
        browserGeneration(w) === configuration &&
          browserEpoch(w, owner.actor) === epoch &&
          (!run.browserRead || run.browserRead.botId === d.bot.id),
        "browser_configuration_changed",
        409,
      );
      if (phase === "waiting" && run.status === "running")
        throw new Fault("browser_task_not_waiting", 409);
      requireThat(
        run.status === (phase === "active" ? "running" : "awaiting_approval"),
        "browser_consumer_unavailable",
        409,
      );
    };
    const d = await this.store.deployment();
    requireThat(d.bot, "browser_consumer_unavailable", 503);
    const bot = d.bot;
    return {
      owner,
      controller,
      configuration,
      epoch,
      botId: d.bot.id,
      guard,
      waiting: async (requestId) => {
        await guard("waiting");
        const w = await this.store.read(owner.workspaceId);
        requireThat(
          w.runs.some(
            (run) =>
              run.id === controller.id && run.browserWait?.id === requestId,
          ),
          "browser_request_unavailable",
          409,
        );
      },
      markPrivate: async () => {
        await guard("active");
        await this.store.change(owner.workspaceId, (w) => {
          const run = w.runs.find((run) => run.id === controller.id);
          requireThat(
            run &&
              run.fence === controller.fence &&
              run.actor === owner.actor &&
              run.status === "running",
            "access_denied",
            403,
          );
          run.browserRead = {
            owner: owner.actor,
            generation: configuration,
            epoch,
            botId: bot.id,
          };
        });
      },
      pause: async (request, callId, phase = "active") => {
        await guard(phase);
        await this.store.change(owner.workspaceId, (w) => {
          const run = w.runs.find((run) => run.id === controller.id);
          requireThat(
            run &&
              run.fence === controller.fence &&
              run.status ===
                (phase === "active" ? "running" : "awaiting_approval") &&
              runAllowed(w, run),
            "access_denied",
            403,
          );
          run.browserWait = {
            ...request,
            callId,
            toolName: run.tools[callId]?.name,
          };
          if (d.bot?.username) {
            const deliveryId = deliver(
              w,
              owner.actor,
              owner.actor,
              "Browser needs your input or approval. Open Browser to continue.",
              {
                id: `browser:${request.id}`,
                runId: run.id,
                topicId: run.topicId,
                buttons: [
                  [
                    {
                      text: "Open Browser",
                      url: `https://t.me/${d.bot.username}?startapp=browser_${owner.workspaceId.replaceAll("-", "")}`,
                    },
                  ],
                ],
              },
            );
            const notification = w.deliveries.find(
              (item) => item.id === deliveryId,
            );
            if (notification)
              notification.browserRequest = {
                id: request.id,
                expiresAt: request.expiresAt,
              };
          }
        });
      },
      complete: async (callId, requestId, result) =>
        this.store.change(owner.workspaceId, async (w, sql) => {
          const run = w.runs.find((run) => run.id === controller.id);
          requireThat(
            run && run.actor === owner.actor && runAllowed(w, run),
            "access_denied",
            403,
          );
          if (run.browserResumed?.includes(requestId)) return true;
          if (controller.kind === "plugin")
            requireThat(
              controller.pluginRevision === (w.plugins?.revision ?? 0) &&
                w.plugins?.entries.some(
                  (entry) =>
                    entry.id === controller.pluginId &&
                    entry.enabled &&
                    entry.browserAccess &&
                    entry.workspaces.includes(w.id),
                ),
              "browser_consumer_unavailable",
              403,
            );
          requireThat(
            run &&
              run.actor === owner.actor &&
              run.fence === controller.fence &&
              runAllowed(w, run),
            "access_denied",
            403,
          );
          if (run.status === "running") return false;
          requireThat(
            run.status === "awaiting_approval" &&
              run.browserWait?.id === requestId &&
              run.browserWait.callId === callId,
            "browser_consumer_unavailable",
            409,
          );
          requireThat(
            run.tools[callId]?.state === "done",
            "browser_task_not_waiting",
            409,
          );
          const receipt = toolResult(result);
          run.tools[callId].result = receipt;
          const message = (run.transcript as AgentMessage[]).findLast(
            (message) =>
              message.role === "toolResult" && message.toolCallId === callId,
          );
          requireThat(
            message?.role === "toolResult",
            "browser_task_not_waiting",
            409,
          );
          message.content = receipt.content;
          delete run.browserWait;
          run.browserResumed = [...(run.browserResumed ?? []), requestId];
          delete run.finishedAt;
          delete run.result;
          delete run.error;
          const code =
            result && typeof result === "object" && "code" in result
              ? result.code
              : undefined;
          const terminal =
            typeof code === "string" &&
            [
              "browser_request_expired",
              "browser_request_denied",
              "browser_input_expired",
              "browser_input_cancelled",
              "browser_request_cancelled",
            ].includes(code);
          const approval = w.approvals.some(
            (item) => item.runId === run.id && !item.decision,
          );
          run.status = terminal
            ? "partial"
            : approval
              ? "awaiting_approval"
              : "queued";
          if (terminal) {
            run.error = code;
            run.finishedAt = new Date().toISOString();
          }
          await sql.query(
            "DELETE FROM outbox WHERE kind='run' AND workspace_id=$1 AND target_id=$2",
            [w.id, run.id],
          );
          return true;
        }),
    };
  }
  private async resolve(
    owner: BrowserOwner,
    controller: BrowserController,
    configuration: number,
    epoch: number,
  ) {
    const resolver = this.resolvers.get(controller.kind);
    requireThat(resolver, "browser_consumer_unavailable", 403);
    return resolver(owner, controller, configuration, epoch);
  }
  private async authority(
    consumer: BrowserConsumer,
    phase: "active" | "waiting",
    signal?: AbortSignal,
    interact = false,
  ): Promise<BrowserAuthority> {
    const { repository } = this.runtime();
    return {
      owner: consumer.owner,
      controller: consumer.controller,
      signal,
      guard: () => consumer.guard(phase),
      policy: async () => {
        await consumer.guard(phase);
        const state = await repository.read(consumer.owner);
        const policy = browserGrantPolicy(
          state.access ?? emptyBrowserAccess(),
          consumer.controller,
          consumer.configuration,
          consumer.epoch,
        );
        const w = await this.store.read(consumer.owner.workspaceId);
        policy.previewOrigins = policy.previewOrigins.filter((origin) =>
          w.plugins?.browser?.previewOrigins?.includes(origin),
        );
        return { ...policy, interact };
      },
    };
  }
  private async wait(
    consumer: BrowserConsumer,
    callId: string,
    input: Pick<BrowserAccessRequest, "kind"> &
      Partial<
        Pick<
          BrowserAccessRequest,
          "action" | "origin" | "preview" | "page" | "generation"
        >
      >,
  ) {
    const { repository } = this.runtime();
    await consumer.guard("active");
    const request = await repository.change(consumer.owner, (state) => {
      state.access ??= emptyBrowserAccess();
      const pending = requestBrowserAccess(state.access, {
        ...input,
        controller: consumer.controller,
        configuration: consumer.configuration,
        epoch: consumer.epoch,
        operationId: callId,
      });
      if (
        state.lease &&
        sameController(state.lease.controller, consumer.controller)
      )
        state.lease.expiresAt = pending.expiresAt;
      return pending;
    });
    await consumer.pause(request, callId);
    return {
      status: "waiting",
      requestId: request.id,
      kind: request.kind,
      expiresAt: request.expiresAt,
    };
  }
  async tool(
    workspaceId: string,
    runId: string,
    actor: string,
    configuration: number,
    fence: number,
    name: "browser_session" | "browser_action",
    value: unknown,
    callId: string,
    signal?: AbortSignal,
  ) {
    const w = await this.store.read(workspaceId);
    const consumer = await this.resolve(
      { workspaceId, actor },
      { kind: "chat", id: runId, fence },
      configuration,
      browserEpoch(w, actor),
    );
    return this.consume(consumer, name, value, callId, signal);
  }
  async fileTool(
    workspaceId: string,
    runId: string,
    actor: string,
    fence: number,
    generation: number,
    pluginId: string,
    pluginRevision: number,
    toolName: string,
    callId: string,
    name: "browser_session" | "browser_action",
    value: unknown,
    signal?: AbortSignal,
  ) {
    const w = await this.store.read(workspaceId),
      entry = w.plugins?.entries.find((entry) => entry.id === pluginId);
    requireThat(
      entry?.tools.includes(toolName) && entry.browserAccess,
      "browser_consumer_unavailable",
      403,
    );
    const consumer = await this.resolve(
      { workspaceId, actor },
      { kind: "plugin", id: runId, fence, pluginId, pluginRevision },
      generation,
      browserEpoch(w, actor),
    );
    return this.consume(consumer, name, value, callId, signal);
  }
  /** For registered Codex/plugin adapters; never accept a model-supplied consumer. */
  async consume(
    consumer: BrowserConsumer,
    name: "browser_session" | "browser_action",
    value: unknown,
    callId: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    await consumer.guard("active");
    signal?.throwIfAborted();
    const { repository, control, host } = this.runtime();
    await consumer.markPrivate();
    const state = await repository.read(consumer.owner);
    if ((state.epoch ?? 0) !== consumer.epoch) {
      if (
        state.revision === 0 &&
        !state.access &&
        !state.lease &&
        !state.input &&
        !state.operations.length &&
        !state.lifecycle
      )
        await repository.change(consumer.owner, (current) => {
          current.epoch = consumer.epoch;
        });
      else {
        await this.scheduleCleanup(consumer.owner, "delete", consumer.epoch);
        throw new Fault("browser_cleanup_pending", 409);
      }
    }
    requireThat(!state.cleanup, "browser_cleanup_pending", 409);
    const authority = await this.authority(consumer, "active", signal);
    if (name === "browser_session") {
      const input = browserSession.parse(value);
      if (input.action === "status") return control.status(authority);
      if (input.action === "release") return control.release(authority);
      if (input.action === "close") {
        await control.release(authority);
        const current = await repository.read(consumer.owner);
        return host.invoke(
          {
            owner: consumer.owner,
            controller: consumer.controller,
            generation: current.generation,
            operation: { command: "close" },
          },
          signal,
        );
      }
      try {
        return await control.acquire(authority);
      } catch (error) {
        if (error instanceof Fault && error.code === "browser_busy")
          return this.wait(consumer, callId, { kind: "control" });
        throw error;
      }
    }
    const action = browserAction.parse(value);
    if (action.action === "navigate" || action.action === "request_site") {
      const origin = new URL(action.url).origin;
      const policy = await authority.policy?.(consumer.controller);
      requireThat(policy, "browser_service_unavailable", 503);
      if (
        !policy.origins.includes(origin) ||
        state.operations.some(
          (operation) =>
            operation.state === "started" &&
            operation.hash === fingerprint(action),
        )
      ) {
        const w = await this.store.read(consumer.owner.workspaceId);
        const preview = !!w.plugins?.browser?.previewOrigins?.includes(origin);
        return this.wait(consumer, callId, {
          kind: "site",
          origin,
          preview,
          ...(action.action === "navigate" ? { action } : {}),
        });
      }
      if (action.action === "request_site") return { status: "completed" };
    }
    let lease: BrowserLease;
    try {
      lease = await control.acquire(authority);
    } catch (error) {
      if (error instanceof Fault && error.code === "browser_busy")
        return this.wait(consumer, callId, { kind: "control", action });
      throw error;
    }
    if (browserNeedsActionApproval(action)) {
      const current = await control.perform(
        authority,
        lease.generation,
        operationKey(consumer, `${callId}:view`),
        { action: "read" },
      );
      requireThat(current.page, "browser_page_unavailable", 409);
      return this.wait(consumer, callId, {
        kind: "action",
        action,
        page: current.page,
        generation: lease.generation,
      });
    }
    const result = await control.perform(
      authority,
      lease.generation,
      operationKey(consumer, callId),
      action,
    );
    if (action.action === "request_input") {
      const input = (await repository.read(consumer.owner)).input;
      requireThat(input, "browser_input_unavailable", 409);
      await repository.change(consumer.owner, (state) => {
        if (state.input?.id === input.id) state.input.callId = callId;
      });
      await consumer.pause(
        { id: input.id, kind: "input", expiresAt: input.expiresAt },
        callId,
      );
      return {
        status: "waiting",
        kind: "input",
        requestId: input.id,
        expiresAt: input.expiresAt,
      };
    }
    return result;
  }
  async decide(owner: BrowserOwner, id: string, approve: boolean) {
    const w = await this.store.read(owner.workspaceId);
    authorizeBrowserOwner(w, owner.actor);
    const { repository } = this.runtime();
    return repository.change(owner, (state) => {
      state.access ??= emptyBrowserAccess();
      return decideBrowserAccess(
        state.access,
        id,
        approve,
        browserGeneration(w),
        browserEpoch(w, owner.actor),
      );
    });
  }
  async submitInput(
    owner: BrowserOwner,
    id: string,
    submissionId: string,
    value: string,
  ) {
    const { repository, control } = this.runtime();
    const state = await repository.read(owner),
      input = state.input;
    requireThat(input?.id === id, "browser_input_unavailable", 404);
    const w = await this.store.read(owner.workspaceId);
    const consumer = await this.resolve(
      owner,
      input.controller,
      browserGeneration(w),
      browserEpoch(w, owner.actor),
    );
    await consumer.waiting(id);
    const authority = await this.authority(consumer, "waiting");
    await control.submitInput(authority, id, submissionId, value);
    // Only the completion signal is durable. Never enqueue the submitted value.
    return { status: "completed" };
  }
  async scheduleCleanup(
    owner: BrowserOwner,
    command: "close" | "delete",
    epoch?: number,
  ) {
    if (!this.repository) return;
    await this.repository.change(owner, (state) => {
      if (
        state.lifecycle === "deleted" ||
        (state.lifecycle === "closed" && command === "close")
      ) {
        if (epoch !== undefined && state.lifecycle === "deleted")
          state.epoch = epoch;
        return;
      }
      if (
        state.cleanup?.command === "delete" ||
        state.cleanup?.command === command
      )
        return;
      releaseBrowser(state);
      if (state.access) invalidateBrowserAccess(state.access);
      state.cleanup = { command, generation: state.generation };
    });
  }
  maintain(workspaceId: string, signal: AbortSignal) {
    if (
      signal.aborted ||
      this.maintenance.has(workspaceId) ||
      this.maintenance.size >= 2
    )
      return;
    const work = this.reconcile(workspaceId, signal)
      .catch(() => {})
      .finally(() => {
        this.maintenance.delete(workspaceId);
      });
    this.maintenance.set(workspaceId, work);
  }
  async drain() {
    await Promise.allSettled(this.maintenance.values());
  }
  private async endStaleWait(
    owner: BrowserOwner,
    controller: BrowserController,
    requestId: string,
  ) {
    if (!["chat", "plugin"].includes(controller.kind)) return;
    await this.store.change(owner.workspaceId, async (w, sql) => {
      const run = w.runs.find((r) => r.id === controller.id);
      if (
        !run ||
        run.actor !== owner.actor ||
        run.fence !== controller.fence ||
        run.status !== "awaiting_approval" ||
        run.browserWait?.id !== requestId
      )
        return;
      const callId = run.browserWait.callId;
      const receipt = toolResult({
        status: "unavailable",
        code: "browser_request_cancelled",
      });
      if (run.tools[callId]?.state === "done")
        run.tools[callId].result = receipt;
      const message = (run.transcript as AgentMessage[]).findLast(
        (m) => m.role === "toolResult" && m.toolCallId === callId,
      );
      if (message?.role === "toolResult") message.content = receipt.content;
      delete run.browserWait;
      run.status = "partial";
      run.error = "browser_request_cancelled";
      run.finishedAt = new Date().toISOString();
      await sql.query(
        "DELETE FROM outbox WHERE kind='run' AND workspace_id=$1 AND target_id=$2",
        [w.id, run.id],
      );
    });
  }
  async reconcile(workspaceId: string, signal?: AbortSignal) {
    if (!this.repository || !this.host || !this.control) return;
    const owners = await this.repository.owners(workspaceId);
    if (!owners.length) return;
    const start = (this.cursors.get(workspaceId) ?? 0) % owners.length;
    for (let index = 0; index < Math.min(owners.length, 50); index++) {
      const owner = owners[(start + index) % owners.length];
      if (!owner) continue;
      if (signal?.aborted) return;
      try {
        await this.reconcileOwner(owner, signal);
      } catch (error) {
        this.store.log.write("worker_maintenance_failed", {
          workspaceId,
          error: new Fault(
            error instanceof Fault && /^browser_[a-z_]+$/.test(error.code)
              ? error.code
              : "browser_reconcile_failed",
            503,
          ),
        });
      }
    }
    this.cursors.set(workspaceId, start + Math.min(owners.length, 50));
  }
  private async reconcileOwner(owner: BrowserOwner, signal?: AbortSignal) {
    const { repository, host } = this.runtime();
    let state = await repository.read(owner);
    const w = await this.store.read(owner.workspaceId);
    if (
      !eligible(w, owner.actor) ||
      (state.epoch ?? 0) !== browserEpoch(w, owner.actor)
    ) {
      await this.scheduleCleanup(owner, "delete", browserEpoch(w, owner.actor));
      state = await repository.read(owner);
    } else if (!browserEnabled(w) || w.settings.paused) {
      await this.scheduleCleanup(owner, "close");
      state = await repository.read(owner);
    }
    if (state.cleanup) {
      const cleanup = state.cleanup;
      await host.invoke({
        owner,
        controller: BrowserControl.humanController(),
        generation: cleanup.generation,
        operation: { command: cleanup.command },
      });
      await repository.change(owner, (current) => {
        if (current.cleanup?.generation !== cleanup.generation) return;
        delete current.cleanup;
        current.lifecycle = cleanup.command === "delete" ? "deleted" : "closed";
        if (cleanup.command === "delete") {
          current.epoch = browserEpoch(w, owner.actor);
          current.operations = [];
          delete current.input;
          delete current.access;
          delete current.receipts;
        }
      });
      return;
    }
    const deployment = await this.store.deployment();
    if (!deployment.active || deployment.paused) return;
    state = await this.releaseFinishedLease(owner, state, signal);
    const input = state.input;
    if (
      input &&
      ["completed", "expired", "cancelled", "unknown"].includes(input.state)
    ) {
      if (input.controller.kind === "human") {
        await repository.change(owner, (current) => {
          if (current.input?.id === input.id) delete current.input;
        });
      } else
        try {
          const consumer = await this.resolve(
            owner,
            input.controller,
            browserGeneration(w),
            browserEpoch(w, owner.actor),
          );
          const callId = input.callId;
          if (
            callId &&
            (await consumer.complete(
              callId,
              input.id,
              input.state === "completed"
                ? { status: "completed", inputApplied: true }
                : {
                    status: "unavailable",
                    code:
                      input.state === "expired"
                        ? "browser_input_expired"
                        : input.state === "cancelled"
                          ? "browser_input_cancelled"
                          : "browser_outcome_unknown",
                  },
            ))
          )
            await repository.change(owner, (current) => {
              if (current.input?.id === input.id) delete current.input;
            });
        } catch (error) {
          if (!staleConsumer(error)) throw error;
          await this.endStaleWait(owner, input.controller, input.id);
          // Only terminal metadata is acknowledged; an uncertain effect is never retried.
          await repository.change(owner, (current) => {
            if (current.input?.id === input.id) delete current.input;
          });
        }
    }
    for (const request of state.access?.requests ?? []) {
      try {
        await this.processRequest(owner, request, signal);
      } catch (error) {
        if (error instanceof Fault && error.code === "browser_task_not_waiting")
          continue;
        if (!staleConsumer(error)) throw error;
        await this.endStaleWait(owner, request.controller, request.id);
        await repository.change(owner, (current) => {
          const saved = current.access?.requests.find(
            (r) => r.id === request.id,
          );
          if (!saved) return;
          if (saved.state === "applying") saved.state = "unknown";
          else if (["waiting", "approved"].includes(saved.state))
            saved.state = "cancelled";
          saved.result ??= {
            status: "unavailable",
            code:
              saved.state === "unknown"
                ? "browser_outcome_unknown"
                : "browser_request_cancelled",
          };
          saved.resumePending = false;
        });
      }
    }
  }
  private async releaseFinishedLease(
    owner: BrowserOwner,
    state: BrowserState,
    signal?: AbortSignal,
  ) {
    const lease = state.lease;
    if (
      !lease ||
      (lease.controller.kind === "human" && lease.expiresAt > Date.now())
    )
      return state;
    const w = await this.store.read(owner.workspaceId);
    if (
      lease.expiresAt > Date.now() &&
      this.resolvers.has(lease.controller.kind)
    ) {
      try {
        const consumer = await this.resolve(
          owner,
          lease.controller,
          browserGeneration(w),
          browserEpoch(w, owner.actor),
        );
        try {
          await consumer.guard("active");
          return state;
        } catch (error) {
          if (
            !staleConsumer(error) &&
            !(
              error instanceof Fault &&
              error.code === "browser_task_not_waiting"
            )
          )
            throw error;
        }
        try {
          await consumer.guard("waiting");
          return state;
        } catch (error) {
          if (
            error instanceof Fault &&
            error.code === "browser_task_not_waiting"
          )
            return state;
          throw error;
        }
      } catch (error) {
        if (!staleConsumer(error)) throw error;
        /* Ended or revoked consumers relinquish control. */
      }
    }
    const { repository, host } = this.runtime();
    const generation = await repository.change(owner, (current) => {
      if (
        !current.lease ||
        current.lease.generation !== lease.generation ||
        !sameController(current.lease.controller, lease.controller)
      )
        return;
      releaseBrowser(current);
      return current.generation;
    });
    if (generation !== undefined)
      try {
        await host.invoke(
          {
            owner,
            controller: lease.controller,
            generation,
            operation: { command: "release" },
          },
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof Fault) ||
          error.code !== "browser_control_expired"
        )
          throw error;
      }
    return repository.read(owner);
  }
  private async finishRequest(
    owner: BrowserOwner,
    consumer: BrowserConsumer,
    request: BrowserAccessRequest,
  ) {
    if (!request.result || !request.resumePending) return;
    if (
      await consumer.complete(request.operationId, request.id, request.result)
    )
      await this.runtime().repository.change(owner, (state) => {
        const saved = state.access?.requests.find(
          (item) => item.id === request.id,
        );
        if (saved) saved.resumePending = false;
      });
  }
  private async processRequest(
    owner: BrowserOwner,
    request: BrowserAccessRequest,
    signal?: AbortSignal,
  ) {
    if (request.result && !request.resumePending) return;
    if (
      request.state === "applying" &&
      (request.startedAt ?? 0) + 45_000 > Date.now()
    )
      return;
    if (
      ![
        "waiting",
        "approved",
        "applying",
        "completed",
        "denied",
        "cancelled",
        "expired",
        "unknown",
      ].includes(request.state)
    )
      return;
    const { repository, control } = this.runtime();
    const consumer = await this.resolve(
      owner,
      request.controller,
      request.configuration,
      request.epoch,
    );
    if (request.result) {
      await this.finishRequest(owner, consumer, request);
      return;
    }
    try {
      await consumer.waiting(request.id);
    } catch (error) {
      if (error instanceof Fault && error.code === "browser_task_not_waiting")
        return;
      if (!staleConsumer(error)) throw error;
      await this.endStaleWait(owner, request.controller, request.id);
      await repository.change(owner, (state) => {
        const saved = state.access?.requests.find(
          (item) => item.id === request.id,
        );
        if (saved) {
          saved.state = saved.state === "applying" ? "unknown" : "cancelled";
          saved.resumePending = false;
        }
      });
      return;
    }
    if (request.state === "waiting" && request.expiresAt > Date.now()) return;
    const current = await repository.read(owner);
    if (
      request.state === "approved" &&
      request.expiresAt > Date.now() &&
      current.lease &&
      current.lease.expiresAt > Date.now() &&
      !sameController(current.lease.controller, request.controller)
    )
      return;
    let result: NonNullable<BrowserAccessRequest["result"]> = {
      status: "unavailable",
      code:
        request.state === "denied"
          ? "browser_request_denied"
          : request.state === "cancelled"
            ? "browser_request_cancelled"
            : request.state === "applying" || request.state === "unknown"
              ? "browser_outcome_unknown"
              : "browser_request_expired",
    };
    let inputWait = false;
    if (request.state === "approved" && request.expiresAt > Date.now()) {
      const reserved = await repository.change(owner, (state) => {
        const saved = state.access?.requests.find(
          (item) => item.id === request.id,
        );
        if (saved?.state !== "approved") return false;
        saved.state = "applying";
        saved.startedAt = Date.now();
        if (saved.kind === "site") {
          requireThat(state.access, "browser_request_unavailable", 409);
          grantBrowserSite(state.access, saved);
        }
        return true;
      });
      if (!reserved) return;
      try {
        const authority = await this.authority(
          consumer,
          "waiting",
          signal,
          request.kind === "action",
        );
        const lease = await control.acquire(authority);
        if (request.kind === "action") {
          const page = await control.perform(
            authority,
            lease.generation,
            operationKey(consumer, `${request.operationId}:review`),
            { action: "read" },
          );
          requireThat(
            lease.generation === request.generation &&
              page.page &&
              fingerprint(page.page) === fingerprint(request.page),
            "browser_page_changed",
            409,
          );
        }
        result = request.action
          ? await control.perform(
              authority,
              lease.generation,
              operationKey(consumer, request.operationId),
              request.action,
              request.kind === "action" ? request.page : undefined,
            )
          : { status: "completed" };
        if (request.action?.action === "request_input") {
          const input = (await repository.read(owner)).input;
          requireThat(input, "browser_input_unavailable", 409);
          await repository.change(owner, (state) => {
            if (state.input?.id === input.id)
              state.input.callId = request.operationId;
          });
          await consumer.pause(
            { id: input.id, kind: "input", expiresAt: input.expiresAt },
            request.operationId,
            "waiting",
          );
          inputWait = true;
        }
      } catch (error) {
        result = {
          status: "unavailable",
          code:
            error instanceof Fault && /^browser_[a-z_]+$/.test(error.code)
              ? error.code
              : "browser_outcome_unknown",
        };
      }
    }
    const saved = await repository.change(owner, (state) => {
      const saved = state.access?.requests.find(
        (item) => item.id === request.id,
      );
      requireThat(saved, "browser_request_unavailable", 409);
      saved.result = result;
      saved.state =
        result.status !== "unavailable"
          ? "completed"
          : saved.state === "applying"
            ? "unknown"
            : ["waiting", "approved"].includes(saved.state)
              ? "expired"
              : saved.state;
      saved.resumePending = !inputWait;
      return structuredClone(saved);
    });
    if (!inputWait) await this.finishRequest(owner, consumer, saved);
  }
}
