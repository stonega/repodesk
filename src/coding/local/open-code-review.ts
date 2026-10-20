import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
  );
const count = z.number().int().nonnegative();
const file = z.object({
  path,
  status: z.string().min(1),
  insertions: count,
  deletions: count,
});
const previewSchema = z.object({
  schema_version: z.literal("1"),
  mode: z.literal("range"),
  from: sha,
  to: sha,
  merge_base: sha,
  total_files: count,
  reviewable_count: count,
  excluded_count: count,
  reviewable_files: z.array(file),
  excluded_files: z.array(file.extend({ exclude_reason: z.string().min(1) })),
});
const rulesSchema = z.object({
  schema_version: z.literal("1"),
  groups: z.array(
    z.object({
      source: z.string().min(1),
      pattern: z.string(),
      files: z.array(path),
      rule: z.string().min(1),
    }),
  ),
});

export function parseOpenCodeReview(
  value: unknown,
  review: { baseSha: string; headSha: string },
) {
  const plan = z
    .object({
      engine: z.literal("open-code-review"),
      mode: z.literal("delegate"),
      preview: previewSchema,
      ruleGroups: rulesSchema.shape.groups,
    })
    .parse(value);
  const { preview, ruleGroups } = plan;
  const paths = preview.reviewable_files.map((file) => file.path);
  const reviewable = new Set(paths);
  const covered = ruleGroups.flatMap((group) => group.files);
  if (
    preview.from !== review.baseSha ||
    preview.to !== review.headSha ||
    preview.reviewable_count !== paths.length ||
    preview.excluded_count !== preview.excluded_files.length ||
    preview.total_files !== paths.length + preview.excluded_files.length ||
    new Set([...paths, ...preview.excluded_files.map((file) => file.path)])
      .size !== preview.total_files ||
    covered.length !== paths.length ||
    new Set(covered).size !== paths.length ||
    covered.some((path) => !reviewable.has(path))
  )
    throw Error("coding_review_preparation_failed");
  return plan;
}

/** OCR's deterministic, LLM-free preparation runs before credentials are mounted. */
export async function prepareOpenCodeReview(
  review: { baseSha: string; headSha: string },
  execute: (args: string[]) => Promise<string>,
) {
  const base = sha.parse(review.baseSha),
    head = sha.parse(review.headSha);
  const preview = previewSchema.parse(
    JSON.parse(
      await execute([
        "delegate",
        "preview",
        "--format",
        "json",
        "--from",
        base,
        "--to",
        head,
      ]),
    ),
  );
  if (
    preview.from !== base ||
    preview.to !== head ||
    preview.reviewable_count !== preview.reviewable_files.length ||
    preview.excluded_count !== preview.excluded_files.length ||
    preview.total_files !== preview.reviewable_count + preview.excluded_count
  )
    throw new Error("coding_review_preparation_failed");
  const paths = preview.reviewable_files.map((entry) => entry.path);
  if (
    new Set([...paths, ...preview.excluded_files.map((entry) => entry.path)])
      .size !== preview.total_files
  )
    throw new Error("coding_review_preparation_failed");

  const ruleGroups: z.infer<typeof rulesSchema>["groups"] = [];
  // Bound argv size without silently omitting files or cutting rule text.
  for (let offset = 0; offset < paths.length; offset += 16) {
    const batch = paths.slice(offset, offset + 16);
    const rules = rulesSchema.parse(
      JSON.parse(
        await execute(["delegate", "rule", "--format", "json", "--", ...batch]),
      ),
    );
    const covered = rules.groups.flatMap((group) => group.files);
    if (
      covered.length !== batch.length ||
      new Set(covered).size !== batch.length ||
      covered.some((entry) => !batch.includes(entry))
    )
      throw new Error("coding_review_preparation_failed");
    ruleGroups.push(...rules.groups);
  }
  const plan = parseOpenCodeReview(
    {
      engine: "open-code-review",
      mode: "delegate",
      preview,
      ruleGroups,
    },
    review,
  );
  if (Buffer.byteLength(JSON.stringify(plan)) > 6 * 1024 * 1024)
    throw new Error("coding_review_preparation_failed");
  return plan;
}
