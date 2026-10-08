import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  developmentOutputSchema,
  developmentPrompt,
  developmentRun,
  developmentSchema,
} from "../../src/coding/development.ts";
import { diffLines } from "../../src/review-bot/github.ts";
import { reviewMention } from "../../src/review-bot/mentions.ts";
import { verifyReviewSignature } from "../../src/review-bot/service.ts";

const handle = "repodesk[bot]";
test("only directly addressed human instructions can request fixes", () => {
  expect(
    reviewMention(`@${handle} fix this\nKeep the API compatible.`, handle),
  ).toEqual({ mode: "fix", text: "fix this\nKeep the API compatible." });
  expect(
    reviewMention(`@${handle} please fix the regression`, handle)?.mode,
  ).toBe("fix");
  expect(reviewMention(`@${handle} explain this`, handle)?.mode).toBe("answer");
  expect(reviewMention(`@${handle} status`, handle)?.mode).toBe("status");
  expect(reviewMention(`@${handle} stop`, handle)?.mode).toBe("cancel");
  for (const body of [
    `> @${handle} fix this`,
    `    @${handle} fix this`,
    `\`@${handle} fix this\``,
    `Someone said @${handle} fix this`,
    `@${handle}-fake fix this`,
    `\`\`\`\n~~~\n@${handle} fix this\n\`\`\``,
    `~~~\n\`\`\`\n@${handle} fix this\n~~~`,
  ])
    expect(reviewMention(body, handle)).toBeUndefined();
});
test("GitHub App short mentions are accepted without accepting lookalikes", () => {
  expect(reviewMention("@repodesk fix this", handle)?.mode).toBe("fix");
  expect(reviewMention("@repodesk-fake fix this", handle)).toBeUndefined();
});
test("webhook HMAC covers the original bytes and rejects malformed or changed signatures", () => {
  const body = Buffer.from('{"message":"你好"}');
  const secret = "fixture-only-webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  expect(() => verifyReviewSignature(secret, body, signature)).not.toThrow();
  for (const candidate of ["", "sha256=invalid", `sha256=${"0".repeat(64)}`])
    expect(() => verifyReviewSignature(secret, body, candidate)).toThrow(
      "unauthorized_webhook",
    );
  expect(() =>
    verifyReviewSignature(
      secret,
      Buffer.from('{ "message":"你好"}'),
      signature,
    ),
  ).toThrow("unauthorized_webhook");
});
test("inline findings use actual diff lines on the correct side", () => {
  const lines = diffLines(
    "@@ -10,3 +20,4 @@ function\n-old\n+new\n context\n+added\n last\n\\ No newline at end of file",
  );
  expect([...lines]).toEqual([
    "LEFT:10",
    "RIGHT:20",
    "LEFT:11",
    "RIGHT:21",
    "RIGHT:22",
    "LEFT:12",
    "RIGHT:23",
  ]);
  expect(lines.has("RIGHT:10")).toBe(false);
  expect(diffLines("binary patch omitted").size).toBe(0);
});
test("review turns are read-only, pinned to exact commits, with strict structured findings", () => {
  const run = developmentRun.parse({
    taskId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    mode: "analysis",
    inputs: [
      {
        revision: 1,
        actor: "101",
        sourceId: "fixture",
        text: "review",
        kind: "request",
      },
    ],
    review: {
      number: 23,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      action: "review",
    },
  });
  const prompt = developmentPrompt(run);
  expect(prompt).toContain(`git diff ${"b".repeat(40)}...${"a".repeat(40)}`);
  expect(prompt).toContain("Do not run repository scripts");
  expect(prompt).toContain("Never claim tests ran");
  const schema = developmentSchema(run);
  expect(schema.required).toContain("reviewFindings");
  expect(Object.keys(schema.properties).sort()).toEqual(
    [...schema.required].sort(),
  );
  expect(Object.keys(developmentOutputSchema.properties).sort()).toEqual(
    [...developmentOutputSchema.required].sort(),
  );
  expect(developmentOutputSchema.properties).not.toHaveProperty(
    "reviewFindings",
  );
});
