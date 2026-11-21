import { definePlugin } from "@telo/plugin-sdk";
import type {
  Contract,
  NotificationEvent,
  Settings,
} from "./generated/contract.ts";

export default definePlugin<Contract, Settings, NotificationEvent>({
  tools: {
    async check_stars({ repositoryId, threshold }, context) {
      const data = await context.github.getRepository({ repositoryId });
      const matched = data.stars >= threshold;
      return {
        content: [
          {
            type: "text",
            text: `${data.stars} stars; threshold ${threshold}.`,
          },
        ],
        structuredContent: { stars: data.stars, matched },
        notifications: matched
          ? [
              {
                event: "star_threshold",
                id: `repository:${repositoryId}:stars:${threshold}`,
                occurredAt: data.fetchedAt,
                title: "Star threshold observed",
                body: `${data.url} currently has ${data.stars} stars (threshold ${threshold}).`,
                url: data.url,
              },
            ]
          : [],
      };
    },
  },
});
