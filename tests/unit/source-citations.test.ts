import { expect, test } from "bun:test";
import { buildContext, validateSources } from "../../src/agent/context.ts";
import { createRun } from "../../src/workspaces/service.ts";
import { workspace } from "../fixtures.ts";

function fixture() {
  const w = workspace();
  const run = createRun(
    w,
    "101",
    "Explain the repository architecture",
    "101",
    0,
    "gpt-4.1-mini",
  );
  run.sources = [
    {
      id: "bot:101:113",
      chatId: "101",
      topicId: 0,
      author: "101",
      text: run.task,
      at: run.at,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      directed: true,
    },
  ];
  return { w, run };
}

test("chat and code citations can coexist without authorizing filenames as chat sources", () => {
  const { run } = fixture();
  const answer =
    "You asked about architecture [source:bot:101:113].\n" +
    "Nuxt application. Source: deepx-web / devnet, branch `devnet-develop`, " +
    "commit `f3766872def586163d60294e78e77cf4b63aa564`, `package.json:1–111`.";
  expect(validateSources(answer, run)).toBe(answer);
  // Reproduce the rejected citation from the reported run. Merely mentioning a
  // file as evidence must never add it to the authorized chat-source namespace.
  expect(() => validateSources(`${answer} [source:package.json]`, run)).toThrow(
    "invalid_source_citation",
  );
  expect(() => validateSources(`${answer} [source:other-tenant]`, run)).toThrow(
    "invalid_source_citation",
  );
});

test("code references do not satisfy or bypass chat recap citation checks", () => {
  const { run } = fixture();
  run.task = "Summarize our chat";
  expect(() =>
    validateSources("Source: deepx-web / devnet, `package.json:1–111`.", run),
  ).toThrow("recap_requires_sources");
  expect(() =>
    validateSources("[source:bot:101:113] https://t.me/example/123", run),
  ).toThrow("use_source_ids_not_unverified_links");
});

test("base policy distinguishes chat IDs from code provenance", () => {
  const { w, run } = fixture();
  const { system } = buildContext(w, run);
  expect(system).toContain("syntax is reserved for chat messages");
  expect(system).toContain("Cite code/tool evidence separately in plain text");
});
