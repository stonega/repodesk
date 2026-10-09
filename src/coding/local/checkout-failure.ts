export const checkoutFailureCodes = [
  "coding_base_branch_missing",
  "coding_checkout_failed",
] as const;

/** Only classify a known Git diagnostic; never persist repository output. */
export function checkoutFailureCode(
  error: unknown,
  branch: string,
  baseBranch: string,
): (typeof checkoutFailureCodes)[number] {
  const diagnostics =
    error && typeof error === "object" && "diagnostics" in error
      ? error.diagnostics
      : undefined;
  if (
    branch === baseBranch &&
    typeof diagnostics === "string" &&
    diagnostics
      .split(/\r?\n/)
      .includes(`fatal: Remote branch ${branch} not found in upstream origin`)
  )
    return "coding_base_branch_missing";
  return "coding_checkout_failed";
}
