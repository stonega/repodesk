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
});
