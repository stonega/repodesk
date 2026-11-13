import { expect, test } from "bun:test";
import plugin from "../src/index.ts";

test("count words without contacting any service", async () => {
  const deny = async (): Promise<never> => {
    throw new Error("unavailable in fixture");
  };
  const result = await plugin.tools.count_words(
    { text: "one two three" },
    {
      signal: new AbortController().signal,
      settings: {},
      invocation: {
        id: "offline",
        deadline: new Date(Date.now() + 1000).toISOString(),
      },
      github: { getRepository: deny },
      http: { request: deny },
      diagnostics: { emit() {} },
    },
  );
  expect(result.structuredContent).toEqual({ count: 3 });
});
