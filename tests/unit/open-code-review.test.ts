import { expect, test } from "bun:test";
import { prepareOpenCodeReview } from "../../src/coding/local/open-code-review.ts";

const review = { baseSha: "b".repeat(40), headSha: "a".repeat(40) };
const entry = (path: string) => ({
  path,
  status: "modified",
  insertions: 1,
  deletions: 1,
});
function preview(paths = ["src/example.ts"]) {
  return {
    schema_version: "1",
    mode: "range",
    from: review.baseSha,
    to: review.headSha,
    merge_base: "c".repeat(40),
    total_files: paths.length + 1,
    reviewable_count: paths.length,
    excluded_count: 1,
    reviewable_files: paths.map(entry),
    excluded_files: [
      { ...entry("README.md"), exclude_reason: "unsupported_ext" },
    ],
  };
}
const rules = (files: string[]) => ({
  schema_version: "1",
  groups: [
    { source: "system", pattern: "**/*.ts", files, rule: "Check null safety." },
  ],
});

test("OCR pins both commits, preserves exclusions and resolves rules for every file in bounded batches", async () => {
  const paths = [
    "--rule=untrusted.ts",
    "src/$(touch untrusted).ts",
    ...Array.from({ length: 33 }, (_, i) => `src/file-${i}.ts`),
  ];
  const calls: string[][] = [];
  const plan = await prepareOpenCodeReview(review, async (args) => {
    calls.push(args);
    return JSON.stringify(
      args[1] === "preview" ? preview(paths) : rules(args.slice(5)),
    );
  });
  expect(calls[0]).toEqual([
    "delegate",
    "preview",
    "--format",
    "json",
    "--from",
    review.baseSha,
    "--to",
    review.headSha,
  ]);
  expect(calls.slice(1).map((args) => args.slice(0, 5))).toEqual(
    Array(3).fill(["delegate", "rule", "--format", "json", "--"]),
  );
  expect(calls.slice(1).flatMap((args) => args.slice(5))).toEqual(paths);
  expect(plan.engine).toBe("open-code-review");
  expect(plan.ruleGroups.flatMap((group) => group.files)).toEqual(paths);
  expect(plan.preview.merge_base).toBe("c".repeat(40));
  expect(plan.preview.excluded_files[0]?.exclude_reason).toBe(
    "unsupported_ext",
  );
});

test("an excluded-only change retains its coverage without invoking empty rule resolution", async () => {
  let calls = 0;
  const plan = await prepareOpenCodeReview(review, async () => {
    calls++;
    return JSON.stringify(preview([]));
  });
  expect(calls).toBe(1);
  expect(plan.ruleGroups).toEqual([]);
  expect(plan.preview.total_files).toBe(1);
});

test("failed or incompatible OCR preparation has no alternate review path", async () => {
  await expect(
    prepareOpenCodeReview(review, async () => {
      throw new Error("missing binary");
    }),
  ).rejects.toThrow("missing binary");
  for (const value of [
    "not JSON",
    { ...preview(), schema_version: "2" },
    { ...preview(), from: "d".repeat(40) },
    { ...preview(), to: "d".repeat(40) },
    { ...preview(), mode: "workspace" },
    { ...preview(), merge_base: "main" },
    { ...preview(), total_files: 10 },
    { ...preview(), reviewable_count: 0 },
    { ...preview(), excluded_count: 0 },
    { ...preview(), reviewable_files: [entry("README.md")] },
  ]) {
    let calls = 0;
    await expect(
      prepareOpenCodeReview(review, async () => {
        calls++;
        return typeof value === "string" ? value : JSON.stringify(value);
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});

test("OCR paths must stay inside the repository and use single-line relative names", async () => {
  for (const path of [
    "/auth/auth.json",
    "../secret.ts",
    "src/../secret.ts",
    "src//file.ts",
    "./file.ts",
    "src/file\n.ts",
    "src/file\u0000.ts",
  ]) {
    await expect(
      prepareOpenCodeReview(review, async () =>
        JSON.stringify(preview([path])),
      ),
    ).rejects.toThrow();
  }
});

test("incomplete, duplicate or foreign rule coverage cannot start a review", async () => {
  for (const response of [
    { schema_version: "2", groups: [] },
    rules([]),
    rules(["elsewhere.ts"]),
    rules(["src/example.ts", "src/example.ts"]),
    {
      ...rules(["src/example.ts"]),
      groups: [{ ...rules(["src/example.ts"]).groups[0], rule: "" }],
    },
  ]) {
    await expect(
      prepareOpenCodeReview(review, async (args) =>
        JSON.stringify(args[1] === "preview" ? preview() : response),
      ),
    ).rejects.toThrow();
  }
});
