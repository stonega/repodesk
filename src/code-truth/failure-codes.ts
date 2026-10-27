// Fixed codes shared by model-visible tool failures and sanitized runtime logs.
export const codeTruthFailureCodes = [
  "code_truth_unavailable",
  "code_truth_tools_changed",
  "github_user_access_denied",
  "github_user_access_unavailable",
  "github_app_not_configured",
  "github_repository_not_connected",
  "github_app_permissions_missing",
  "github_access_denied",
  "github_rate_limited",
  "github_unavailable",
] as const;
