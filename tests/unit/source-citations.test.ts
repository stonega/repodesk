import { expect, test } from "bun:test";
import {
  buildContext,
  sanitizeRunOutput,
  validateSources,
} from "../../src/agent/context.ts";
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

test.each(["search_tool", "read_web"])(
  "completed %s supports URL citations for web summaries",
  (name) => {
    const { run } = fixture();
    run.task = "Summarize the latest release notes";
    const answer = "Release notes: https://example.com/releases";
    expect(() => validateSources(answer, run)).toThrow(
      "recap_requires_sources",
    );
    run.tools.search = { name, state: "started" };
    expect(() => validateSources(answer, run)).toThrow(
      "recap_requires_sources",
    );
    run.tools.search.state = "done";
    expect(validateSources(answer, run)).toBe(answer);
    expect(() =>
      validateSources(`${answer} [source:https://example.com/releases]`, run),
    ).toThrow("invalid_source_citation");
  },
);

test.each([
  "query_github_pull_request",
  "get_file_excerpt",
  "search_code",
  "obsidian_read",
  "query_google_docs",
  "delegate_research",
  "rdp_7001_release_stats",
])("completed external evidence tool %s satisfies summary checks", (name) => {
  const { run } = fixture();
  run.task = "Summarize PR #42 and architecture changes";
  const answer = "PR #42 updates auth middleware in `src/auth.ts:10-40`.";
  expect(() => validateSources(answer, run)).toThrow("recap_requires_sources");
  run.tools.evidence = { name, state: "done" };
  expect(validateSources(answer, run)).toBe(answer);
});

test.each(["query_chat_history", "read_chat_context", "record_discussion"])(
  "chat and bookkeeping tool %s still requires chat source citations on recaps",
  (name) => {
    const { run } = fixture();
    run.task = "Recap today's discussion";
    run.tools.chat = { name, state: "done" };
    expect(() =>
      validateSources("The team decided to ship tomorrow.", run),
    ).toThrow("recap_requires_sources");
  },
);

test("verified Telegram links from authorized sources or tool results are permitted", () => {
  const { run } = fixture();
  const firstSource = run.sources[0];
  if (!firstSource) throw new Error("missing source fixture");
  run.sources[0] = {
    ...firstSource,
    text: "Please check https://t.me/telo_news/42 and tell me what it says.",
  };
  run.tools.web = {
    name: "read_web",
    state: "done",
    result: {
      content: [
        {
          type: "text",
          text: "Community chat: https://telegram.me/example_dev",
        },
      ],
    },
  };
  const valid =
    "Summary of https://t.me/telo_news/42. Community link: https://telegram.me/example_dev.";
  expect(validateSources(valid, run)).toBe(valid);
  // Prefix/modified paths remain unverified.
  expect(() =>
    validateSources("See https://t.me/telo_news/42/extra", run),
  ).toThrow("use_source_ids_not_unverified_links");
  expect(() => validateSources("See https://t.me/fabricated/999", run)).toThrow(
    "use_source_ids_not_unverified_links",
  );
});

test("allowMissingRecapCitations keeps forged citations and unverified links blocked", () => {
  const { run } = fixture();
  run.task = "Summarize our chat";
  expect(
    validateSources("Starting summary...", run, {
      allowMissingRecapCitations: true,
    }),
  ).toBe("Starting summary...");
  expect(() =>
    validateSources("Bad [source:forged]", run, {
      allowMissingRecapCitations: true,
    }),
  ).toThrow("invalid_source_citation");
  expect(() =>
    validateSources("https://t.me/forged/1", run, {
      allowMissingRecapCitations: true,
    }),
  ).toThrow("use_source_ids_not_unverified_links");
});

test("sanitizeRunOutput repairs invalid citations and unverified Telegram links without discarding answers", () => {
  const { run } = fixture();
  const firstSource = run.sources[0];
  if (!firstSource) throw new Error("missing source fixture");
  run.sources[0] = {
    ...firstSource,
    text: "Look at https://t.me/authorized_group/7",
  };
  const clean = sanitizeRunOutput(
    "Confirmed [source:bot:101:113] from https://t.me/authorized_group/7.",
    run,
  );
  expect(clean).toEqual({
    text: "Confirmed [source:bot:101:113] from https://t.me/authorized_group/7.",
    issues: [],
  });

  const repaired = sanitizeRunOutput(
    "You asked [source:bot:101:113]. Details in [source:package.json] and ([source:other-tenant]). Check [channel](https://t.me/forged/1) or https://t.me/forged/2 and https://t.me/authorized_group/7.",
    run,
  );
  expect(repaired.issues).toEqual([
    "invalid_source_citation",
    "use_source_ids_not_unverified_links",
  ]);
  expect(repaired.text).toContain("[source:bot:101:113]");
  expect(repaired.text).not.toContain("package.json");
  expect(repaired.text).not.toContain("other-tenant");
  expect(repaired.text).not.toContain("https://t.me/forged");
  expect(repaired.text).toContain(
    "Check channel or [unverified Telegram link removed]",
  );
  expect(repaired.text).toContain("https://t.me/authorized_group/7");

  // Recap missing citations is flagged as an issue without throwing away the answer.
  run.task = "Summarize our chat";
  const missingCitation = sanitizeRunOutput("We agreed on option A.", run);
  expect(missingCitation).toEqual({
    text: "We agreed on option A.",
    issues: ["recap_requires_sources"],
  });

  // Never fall back to forged content when the entire reply is an unauthorized citation.
  const onlyForged = sanitizeRunOutput("[source:other-tenant]", run);
  expect(onlyForged.text).toBe("");
  expect(onlyForged.issues).toContain("invalid_source_citation");
});
