import type { Run, Workspace } from "../domain.ts";
import { requireThat } from "../domain.ts";
import { eligible, runAllowed } from "../workspaces/policy.ts";
import { browserEnabled, browserGeneration } from "./config.ts";

export function authorizeBrowserOwner(
  w: Workspace,
  actor: string,
  cleanup = false,
) {
  requireThat(eligible(w, actor), "access_denied", 403);
  if (!cleanup) {
    requireThat(browserEnabled(w), "browser_disabled", 409);
    requireThat(!w.settings.paused, "access_denied", 403);
  }
}
export function authorizeBrowserRun(
  w: Workspace,
  runId: string,
  actor: string,
  fence: number,
  generation: number,
): Run {
  authorizeBrowserOwner(w, actor);
  const run = w.runs.find((r) => r.id === runId);
  requireThat(
    run &&
      run.actor === actor &&
      run.fence === fence &&
      run.status === "running" &&
      runAllowed(w, run),
    "access_denied",
    403,
  );
  requireThat(
    run.chatId === actor && !run.workflowId,
    "browser_private_task_required",
    403,
  );
  requireThat(
    browserGeneration(w) === generation,
    "browser_configuration_changed",
    409,
  );
  return run;
}
