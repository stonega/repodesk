import { z } from "zod";
import { type DevelopmentResult, developmentResult } from "./development.ts";

export const resultIssues = z
  .array(
    z
      .object({
        path: z
          .array(
            z.union([
              developmentResult.keyof(),
              z.number().int().min(0).max(7),
            ]),
          )
          .max(2),
        code: z.enum([
          "invalid_type",
          "too_big",
          "too_small",
          "invalid_format",
          "not_multiple_of",
          "unrecognized_keys",
          "invalid_union",
          "invalid_key",
          "invalid_element",
          "invalid_value",
          "custom",
          "missing_result",
          "invalid_json",
        ]),
      })
      .strict(),
  )
  .max(8);
export type ResultIssues = z.infer<typeof resultIssues>;

export function parseDevelopmentResult(text: string):
  | { success: true; result: DevelopmentResult }
  | {
      success: false;
      code:
        | "coding_result_missing"
        | "coding_result_json_invalid"
        | "coding_result_invalid";
      issues: ResultIssues;
    } {
  if (!text.trim())
    return {
      success: false,
      code: "coding_result_missing",
      issues: [{ path: [], code: "missing_result" }],
    };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      success: false,
      code: "coding_result_json_invalid",
      issues: [{ path: [], code: "invalid_json" }],
    };
  }
  const parsed = developmentResult.safeParse(value);
  return parsed.success
    ? { success: true, result: parsed.data }
    : {
        success: false,
        code: "coding_result_invalid",
        issues: safeResultIssues(parsed.error.issues),
      };
}

/** Retain known field paths and issue codes, never rejected values or messages. */
export function safeResultIssues(
  issues: readonly Pick<z.core.$ZodIssue, "path" | "code">[],
): ResultIssues {
  return issues.slice(0, 8).map((issue) => {
    const path = resultIssues.element.shape.path.safeParse(issue.path);
    return {
      path: path.success ? path.data : [],
      code: resultIssues.element.shape.code.parse(issue.code),
    };
  });
}
