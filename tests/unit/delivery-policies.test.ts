import { describe, expect, test } from "bun:test";
import { database } from "../../src/db/pool.ts";
import { Store } from "../../src/db/repositories.ts";
import {
  type Delivery,
  type Deployment,
  settingsSchema,
} from "../../src/domain.ts";
import {
  type DeliveryLifecycleHooks,
  DeliveryPolicyRegistry,
  defaultDeliveryPolicies,
  deliveryKind,
  nextResultPartId,
  previousResultPartId,
} from "../../src/jobs/delivery-policies.ts";
import { RuntimeLogger } from "../../src/observability/logs.ts";
import { newWorkspace } from "../../src/workspaces/service.ts";

function baseDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: "del-1",
    actor: "101",
    chatId: "101",
    topicId: 0,
    text: "hello",
    state: "pending",
    at: "2026-11-20T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

const noopHooks: DeliveryLifecycleHooks = {
  refreshBeforeClaim() {},
  shouldDeferClaim: () => false,
  async validateTaskAudience() {},
  prepareButtons: (_workspaceId, _w, d) => ({
    cancelled: false,
    buttons: d.buttons,
  }),
  onComplete() {},
  markTaskUneditable() {},
};

describe("deliveryKind and DeliveryPolicyRegistry", () => {
  test("classifies delivery intents by domain marker", () => {
    expect(deliveryKind(baseDelivery())).toBe("chat_reply");
    expect(
      deliveryKind(
        baseDelivery({
          reaction: { sourceId: "s1", messageId: 1, emoji: "👍" },
        }),
      ),
    ).toBe("reaction");
    expect(
      deliveryKind(
        baseDelivery({
          widget: {
            html: "<p>hi</p>",
            caption: "c",
            width: 320,
            height: 200,
            botId: "bot-1",
          },
        }),
      ),
    ).toBe("widget");
    expect(
      deliveryKind(
        baseDelivery({
          githubNotification: { subscriptionId: "sub-1", revision: 1 },
        }),
      ),
    ).toBe("github_notification");
    expect(
      deliveryKind(
        baseDelivery({
          pluginNotification: { subscriptionId: "sub-2", revision: 1 },
        }),
      ),
    ).toBe("plugin_notification");
    expect(
      deliveryKind(
        baseDelivery({
          taskControlsCleanup: { taskId: "t1", messageId: 42 },
        }),
      ),
    ).toBe("task_controls_cleanup");
    expect(deliveryKind(baseDelivery({ editOf: "del-0" }))).toBe("task_edit");
    expect(deliveryKind(baseDelivery({ cancellationRunId: "run-1" }))).toBe(
      "cancellation",
    );
  });

  test("caches deployment lookup across multiple policies and short-circuits on denial", async () => {
    const store = new Store(
      database("postgres://unused@127.0.0.1:1/unused"),
      new RuntimeLogger(undefined, "worker", () => {}),
    );
    try {
      let deploymentReads = 0;
      const dep: Deployment = {
        version: 1,
        active: true,
        paused: false,
        model: "gpt-4.1-mini",
        credentials: {},
        webhookReady: true,
        ownerVerified: true,
        bot: { id: "999", username: "testbot", visibleAll: true },
      };
      store.deployment = async () => {
        deploymentReads++;
        return dep;
      };
      const w = newWorkspace(
        "00000000-0000-4000-8000-000000000001",
        settingsSchema.parse({ name: "Policy test", timezone: "UTC" }),
      );
      const visited: string[] = [];
      const registry = new DeliveryPolicyRegistry(
        [
          {
            name: "first",
            applies: () => true,
            async allow({ deployment }) {
              visited.push("first");
              return (await deployment()).active;
            },
          },
          {
            name: "second_denies",
            applies: () => true,
            async allow({ deployment }) {
              visited.push("second_denies");
              await deployment();
              return false;
            },
          },
          {
            name: "third_unreached",
            applies: () => true,
            allow() {
              visited.push("third_unreached");
              return true;
            },
          },
        ],
        noopHooks,
      );
      const allowed = await registry.allowed(store, w, baseDelivery());
      expect(allowed).toBe(false);
      expect(visited).toEqual(["first", "second_denies"]);
      expect(deploymentReads).toBe(1);
    } finally {
      await store.pool.end();
    }
  });

  test("defaultDeliveryPolicies rejects legacy run feedback notices", async () => {
    const store = new Store(
      database("postgres://unused@127.0.0.1:1/unused"),
      new RuntimeLogger(undefined, "worker", () => {}),
    );
    try {
      const w = newWorkspace(
        "00000000-0000-4000-8000-000000000001",
        settingsSchema.parse({ name: "Legacy feedback", timezone: "UTC" }),
      );
      const registry = defaultDeliveryPolicies();
      expect(
        await registry.allowed(
          store,
          w,
          baseDelivery({
            feedback: { owner: "run", id: "r1", key: "queued" },
          }),
        ),
      ).toBe(false);
    } finally {
      await store.pool.end();
    }
  });

  test("enforces sequential ordering for multi-part run result deliveries", async () => {
    expect(previousResultPartId("run:r1:result")).toBeUndefined();
    expect(previousResultPartId("run:r1:result:part:2")).toBe("run:r1:result");
    expect(previousResultPartId("run:r1:result:part:3")).toBe(
      "run:r1:result:part:2",
    );
    expect(nextResultPartId("run:r1:result")).toBe("run:r1:result:part:2");
    expect(nextResultPartId("run:r1:result:part:2")).toBe(
      "run:r1:result:part:3",
    );
    expect(nextResultPartId("other")).toBeUndefined();

    const store = new Store(
      database("postgres://unused@127.0.0.1:1/unused"),
      new RuntimeLogger(undefined, "worker", () => {}),
    );
    try {
      const w = newWorkspace(
        "00000000-0000-4000-8000-000000000001",
        settingsSchema.parse({ name: "Result ordering", timezone: "UTC" }),
      );
      const part1 = baseDelivery({ id: "run:r1:result", state: "pending" });
      const part2 = baseDelivery({
        id: "run:r1:result:part:2",
        state: "pending",
      });
      w.deliveries.push(part1, part2);
      const registry = defaultDeliveryPolicies();

      // Defer while part 1 is pending or sending.
      expect(registry.hooks.shouldDeferClaim(w, part2)).toBe(true);
      part1.state = "sending";
      expect(registry.hooks.shouldDeferClaim(w, part2)).toBe(true);

      // Allow once part 1 is confirmed sent.
      part1.state = "sent";
      expect(registry.hooks.shouldDeferClaim(w, part2)).toBe(false);
      expect(await registry.allowed(store, w, part2)).toBe(true);

      // Cancel continuation part if predecessor failed or was cancelled.
      part1.state = "failed";
      expect(registry.hooks.shouldDeferClaim(w, part2)).toBe(false);
      expect(await registry.allowed(store, w, part2)).toBe(false);
      part1.state = "cancelled";
      expect(await registry.allowed(store, w, part2)).toBe(false);
    } finally {
      await store.pool.end();
    }
  });
});
