import { z } from "zod";
import type { Store } from "../db/repositories.ts";
import { requireThat } from "../domain.ts";
import { revokeWork } from "../workspaces/policy.ts";
import {
  browserGrantPolicy,
  browserPageBinding,
  emptyBrowserAccess,
} from "./access.ts";
import {
  type BrowserOwner,
  browserAction,
  browserEnabled,
  browserGeneration,
} from "./config.ts";
import { type BrowserAuthority, BrowserControl } from "./control.ts";
import { authorizeBrowserOwner } from "./policy.ts";
import { browserEpoch } from "./privacy.ts";
import type { BrowserHostPolicy, HostResult } from "./protocol.ts";
import type { BrowserService } from "./service.ts";
import type { BrowserState } from "./state.ts";

export interface PersonalBrowserPage {
  workspace: string;
  enabled: boolean;
  configured: boolean;
  revision: number;
  generation: number;
  lifecycle?: "closed" | "deleted";
  controller?: { kind: string; expiresAt: number };
  requests: {
    id: string;
    kind: string;
    consumer: string;
    task: string;
    origin?: string;
    description: string;
    state: string;
    expiresAt: number;
  }[];
  input?: {
    id: string;
    task: string;
    consumer: string;
    label: string;
    kind: "password" | "code" | "text";
    origin: string;
    state: string;
    expiresAt: number;
  };
  origins: string[];
}
export const personalBrowserOperation = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z
    .object({
      command: z.literal("prepare_input"),
      generation: z.number().int().nonnegative(),
      operationId: z.uuid(),
      page: browserPageBinding,
      kind: z.enum(["password", "code", "text"]),
    })
    .strict(),
  z
    .object({
      command: z.literal("observe"),
      view: z.enum(["tabs", "read", "screenshot"]),
    })
    .strict(),
  z.object({ command: z.literal("artifact"), id: z.uuid() }).strict(),
  z
    .object({
      command: z.literal("takeover"),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      command: z.literal("release"),
      generation: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      command: z.literal("action"),
      generation: z.number().int().nonnegative(),
      operationId: z.uuid(),
      input: browserAction,
      page: browserPageBinding.optional(),
    })
    .strict(),
  z.object({ command: z.literal("close") }).strict(),
  z.object({ command: z.literal("delete") }).strict(),
  z.object({ command: z.literal("cancel_input"), id: z.uuid() }).strict(),
]);

/** Member interactions share the broker; no administrator substitution or raw host access. */
export class BrowserMembers {
  constructor(
    private store: Store,
    private service: BrowserService,
  ) {}
  async view(owner: BrowserOwner, botId: string): Promise<PersonalBrowserPage> {
    const w = await this.store.read(owner.workspaceId);
    authorizeBrowserOwner(w, owner.actor, true);
    const page: PersonalBrowserPage = {
      workspace: w.settings.name,
      enabled: browserEnabled(w),
      configured: this.service.configured,
      revision: 0,
      generation: 0,
      requests: [],
      origins: [],
    };
    if (!page.configured) return page;
    const { repository } = await this.service.personalRuntime(
        owner,
        botId,
        true,
      ),
      state = await repository.read(owner);
    if (
      state.epoch !== undefined &&
      state.epoch !== browserEpoch(w, owner.actor)
    )
      return page;
    const titles = new Map(
      w.runs
        .filter((r) => r.actor === owner.actor)
        .map((r) => [r.id, r.task.slice(0, 240)]),
    );
    for (const controller of [
      ...(state.access?.requests.slice(-20).map((r) => r.controller) ?? []),
      ...(state.input ? [state.input.controller] : []),
    ])
      if (
        controller.kind === "codex" &&
        this.service.coding &&
        !titles.has(controller.id)
      ) {
        try {
          titles.set(
            controller.id,
            await this.service.coding.title(owner, controller.id),
          );
        } catch {
          titles.set(controller.id, "Codex browser task");
        }
      }
    const task = (id: string) => titles.get(id) ?? "Browser task";
    page.revision = state.revision;
    page.generation = state.generation;
    page.lifecycle = state.lifecycle;
    page.controller =
      state.lease && state.lease.expiresAt > Date.now()
        ? {
            kind: state.lease.controller.kind,
            expiresAt: state.lease.expiresAt,
          }
        : undefined;
    page.origins = this.policy(
      w.plugins?.browser?.previewOrigins ?? [],
      state,
      browserGeneration(w),
      browserEpoch(w, owner.actor),
    ).origins;
    page.requests = (state.access?.requests ?? [])
      .filter(
        (r) =>
          r.configuration === browserGeneration(w) &&
          r.epoch === browserEpoch(w, owner.actor),
      )
      .slice(-20)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        consumer: r.controller.kind,
        task: task(r.controller.id),
        origin: r.origin ?? r.page?.origin,
        description:
          r.kind === "site"
            ? "Allow this task to use this site for 30 minutes."
            : r.kind === "control"
              ? "Allow this task to take control of your browser."
              : r.action?.action === "fill"
                ? `Fill ${r.action.selector} with ${r.action.text}`
                : r.action?.action === "click"
                  ? `Click ${r.action.selector}`
                  : r.action?.action === "press"
                    ? `Press ${r.action.key}`
                    : "Click the requested position on the page.",
        state:
          r.state === "waiting" && r.expiresAt <= Date.now()
            ? "expired"
            : r.state,
        expiresAt: r.expiresAt,
      }));
    const input = state.input;
    if (input)
      page.input = {
        id: input.id,
        task:
          input.controller.kind === "human"
            ? "Manual browser input"
            : task(input.controller.id),
        consumer: input.controller.kind,
        label: input.label,
        kind: input.kind,
        origin: input.origin,
        state:
          input.state === "waiting" && input.expiresAt <= Date.now()
            ? "expired"
            : input.state,
        expiresAt: input.expiresAt,
      };
    return page;
  }
  private policy(
    previews: string[],
    state: BrowserState,
    configuration: number,
    epoch: number,
  ): BrowserHostPolicy {
    const grants = (state.access?.grants ?? []).filter(
      (g) =>
        g.configuration === configuration &&
        g.epoch === epoch &&
        g.expiresAt > Date.now(),
    );
    return {
      origins: [...new Set(grants.flatMap((g) => g.origins))].slice(0, 32),
      previewOrigins: [...new Set(grants.flatMap((g) => g.previewOrigins))]
        .filter((o) => previews.includes(o))
        .slice(0, 8),
      interact: false,
    };
  }
  async operate(
    owner: BrowserOwner,
    botId: string,
    value: unknown,
  ): Promise<HostResult | { status: "completed" }> {
    const operation = personalBrowserOperation.parse(value),
      cleanup = operation.command === "delete" || operation.command === "close";
    const { repository, host, control, guard } =
      await this.service.personalRuntime(owner, botId, cleanup);
    let w = await this.store.read(owner.workspaceId),
      state = await repository.read(owner);
    requireThat(!state.cleanup, "browser_cleanup_pending", 409);
    requireThat(
      state.epoch === undefined ||
        state.epoch === browserEpoch(w, owner.actor) ||
        cleanup,
      "browser_authorization_expired",
      403,
    );
    const policy = () =>
      this.policy(
        w.plugins?.browser?.previewOrigins ?? [],
        state,
        browserGeneration(w),
        browserEpoch(w, owner.actor),
      );
    const human =
      state.lease?.controller.kind === "human"
        ? state.lease.controller
        : BrowserControl.humanController();
    const authority: BrowserAuthority = {
      owner,
      controller: human,
      guard,
      policy: async () => {
        await guard();
        w = await this.store.read(owner.workspaceId);
        state = await repository.read(owner);
        if (operation.command === "takeover") return policy();
        const current = browserGrantPolicy(
          state.access ?? emptyBrowserAccess(),
          human,
          browserGeneration(w),
          browserEpoch(w, owner.actor),
        );
        current.previewOrigins = current.previewOrigins.filter((o) =>
          w.plugins?.browser?.previewOrigins?.includes(o),
        );
        return { ...current, interact: true };
      },
    };
    if (cleanup) {
      if (operation.command === "delete")
        await this.store.change(owner.workspaceId, (current) => {
          authorizeBrowserOwner(current, owner.actor, true);
          current.browserEpochs ??= {};
          current.browserEpochs[owner.actor] =
            browserEpoch(current, owner.actor) + 1;
          revokeWork(current);
        });
      await this.service.scheduleCleanup(owner, operation.command);
      return { status: "completed" };
    }
    if (operation.command === "cancel_input") {
      await repository.change(owner, (current) => {
        requireThat(
          current.input?.id === operation.id,
          "browser_input_unavailable",
          404,
        );
        if (current.input.state === "waiting")
          current.input.state = "cancelled";
      });
      if (
        state.input?.controller.kind === "human" &&
        state.lease?.controller.kind === "human"
      ) {
        await control.release(authority);
        await control.acquire(authority);
      }
      return { status: "completed" };
    }
    if (operation.command === "takeover") {
      const origins = policy();
      await repository.change(owner, (current) => {
        requireThat(
          current.revision === operation.revision,
          "browser_state_changed",
          409,
        );
        current.epoch = browserEpoch(w, owner.actor);
        current.access ??= emptyBrowserAccess();
        current.access.grants = current.access.grants.filter(
          (g) => g.controller.kind !== "human",
        );
        current.access.grants.push({
          controller: human,
          configuration: browserGeneration(w),
          epoch: browserEpoch(w, owner.actor),
          origins: origins.origins,
          previewOrigins: origins.previewOrigins,
          expiresAt: Date.now() + 30 * 60_000,
        });
      });
      await control.acquire(authority, true);
      return { status: "completed" };
    }
    if (operation.command === "release") {
      requireThat(
        state.lease?.controller.kind === "human" &&
          state.lease.generation === operation.generation,
        "browser_control_expired",
        409,
      );
      return control.release(authority);
    }
    if (operation.command === "prepare_input") {
      requireThat(
        state.lease?.controller.kind === "human" &&
          state.lease.generation === operation.generation,
        "browser_control_expired",
        409,
      );
      await control.acquire(authority);
      return control.perform(
        authority,
        operation.generation,
        `human:${operation.operationId}`,
        {
          action: "request_input",
          selector: ":focus",
          label: "Focused browser field",
          kind: operation.kind,
        },
        operation.page,
      );
    }
    if (operation.command === "action") {
      requireThat(
        !["pointer", "press", "scroll", "click"].includes(
          operation.input.action,
        ) || operation.page,
        "browser_page_changed",
        409,
      );
      requireThat(
        state.lease?.controller.kind === "human" &&
          state.lease.generation === operation.generation,
        "browser_control_expired",
        409,
      );
      requireThat(
        !["fill", "request_input", "request_site"].includes(
          operation.input.action,
        ),
        "browser_secure_input_required",
        403,
      );
      if (operation.input.action === "navigate") {
        const origin = new URL(operation.input.url).origin;
        const preview = ["127.0.0.1", "[::1]", "localhost"].includes(
          new URL(origin).hostname,
        );
        requireThat(
          !preview || w.plugins?.browser?.previewOrigins?.includes(origin),
          "browser_destination_denied",
          403,
        );
        await repository.change(owner, (current) => {
          const grant = current.access?.grants.find(
            (g) =>
              g.controller.kind === "human" &&
              g.controller.id === human.id &&
              g.configuration === browserGeneration(w) &&
              g.epoch === browserEpoch(w, owner.actor) &&
              g.expiresAt > Date.now(),
          );
          requireThat(
            grant && grant.origins.length < 32,
            "browser_authorization_expired",
            403,
          );
          if (!grant.origins.includes(origin)) grant.origins.push(origin);
          if (preview && !grant.previewOrigins.includes(origin))
            grant.previewOrigins.push(origin);
        });
      }
      // Every click/key is a deliberate owner gesture. Credentials use task-bound input only.
      await control.acquire(authority);
      return control.perform(
        authority,
        operation.generation,
        `human:${operation.operationId}`,
        operation.input,
        operation.page,
      );
    }
    const result = await host.invoke({
      owner,
      controller: human,
      generation: state.generation,
      operation,
      policy: policy(),
    });
    await guard();
    return result;
  }
  async submitInput(
    owner: BrowserOwner,
    botId: string,
    id: string,
    submissionId: string,
    value: string,
  ) {
    const { repository, control, guard } = await this.service.personalRuntime(
      owner,
      botId,
    );
    const state = await repository.read(owner),
      input = state.input;
    if (input?.controller.kind !== "human")
      return this.service.submitInput(owner, id, submissionId, value);
    requireThat(
      input.id === id && state.lease?.controller.kind === "human",
      "browser_input_unavailable",
      404,
    );
    const w = await this.store.read(owner.workspaceId);
    const authority: BrowserAuthority = {
      owner,
      controller: input.controller,
      guard,
      policy: async () => {
        await guard();
        const current = await repository.read(owner);
        return browserGrantPolicy(
          current.access ?? emptyBrowserAccess(),
          input.controller,
          browserGeneration(w),
          browserEpoch(w, owner.actor),
        );
      },
    };
    return control.submitInput(authority, id, submissionId, value);
  }
}
