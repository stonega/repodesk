import { useCallback, useState } from "react";
import {
  type RuntimeEngine,
  type RuntimeView,
  runtimeEngine,
  runtimeNames,
  runtimeView,
} from "../src/coding/runtime-config.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { Select } from "./select.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
const endpoint = "/api/admin/operator/coding-runtime";
const messages: Record<string, string> = {
  coding_runtime_in_use:
    "Tasks or retained checkpoints still use this runtime. Finish them and wait for cleanup before switching.",
  coding_runtime_not_configured:
    "The selected runtime needs host configuration. Ask the deployment operator to prepare it using the runner guide.",
  coding_runtime_unavailable:
    "The selected runtime did not pass its connection, host or image checks. The current runtime is unchanged.",
  coding_runtime_version_conflict:
    "The runtime changed in another session. Close and reopen this editor to review the current selection.",
  coding_runtime_control_unavailable:
    "Runtime selection requires an updated, connected Codex runner.",
  coding_runner_unavailable:
    "The Codex runner is unavailable. Its current runtime could not be read.",
  coding_outcome_unknown:
    "The save response could not be confirmed. Close the editor and check the current runtime before trying again.",
};
function errorMessage(error: unknown) {
  return (
    messages[(error as Error).message] ??
    "The runtime request failed. Check the runner connection and try again."
  );
}

export function CodingRuntime({ request }: { request: Request }) {
  const notify = useToast();
  const [data, setData] = useState<RuntimeView>();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RuntimeEngine | "environment">(
    "environment",
  );
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const value = await request<RuntimeView>(
          endpoint,
          "GET",
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        );
        if (!signal.aborted) {
          setData(runtimeView.parse(value));
          setError("");
        }
      } catch (error) {
        if (!signal.aborted) setError(errorMessage(error));
      }
    },
    [request],
  );
  useRepositoryRefresh(refresh, !editing && !busy, 10000);
  const save = async () => {
    if (busy || !data) return;
    setBusy(true);
    setError("");
    try {
      const value = await request<RuntimeView>(
        endpoint,
        "PUT",
        { revision, selection: draft === "environment" ? null : draft },
        AbortSignal.timeout(90000),
      );
      setData(runtimeView.parse(value));
      setEditing(false);
      notify("Codex runtime saved.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const value = (label: string | undefined) =>
    label ?? (error ? "Unavailable" : <Skeleton width="8rem" />);
  return (
    <>
      <section
        className="card"
        aria-label="Codex runtime"
        aria-busy={!data && !error}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Runtime</h2>
            <p className="muted">
              Shared by every workspace in this deployment.
            </p>
          </div>
          <IconButton
            icon="edit"
            label="Edit Codex runtime"
            showLabel
            disabled={!data || busy}
            onClick={() => {
              if (!data) return;
              setDraft(data.selection ?? "environment");
              setRevision(data.revision);
              setError("");
              setEditing(true);
            }}
          />
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Execution environment</dt>
            <dd>{value(data && runtimeNames[data.engine])}</dd>
          </div>
          <div>
            <dt>Configuration source</dt>
            <dd>
              {value(
                data &&
                  (data.selection ? "Admin panel" : "Environment variable"),
              )}
            </dd>
          </div>
          <div>
            <dt>Environment default</dt>
            <dd>{value(data && runtimeNames[data.environmentDefault])}</dd>
          </div>
          <div>
            <dt>Switching</dt>
            <dd>
              {value(
                data &&
                  (data.retainedTasks
                    ? `${data.retainedTasks} task${data.retainedTasks === 1 ? "" : "s"} or retained checkpoints`
                    : "Ready to switch"),
              )}
            </dd>
          </div>
        </dl>
        <p className="muted">
          The panel selection survives runner restarts. Choose Follow
          environment variable to use the deployment default.
        </p>
      </section>
      {editing && data && (
        <Modal
          title="Edit Codex runtime"
          busy={busy}
          onClose={() => {
            setEditing(false);
            setError("");
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="muted">
              This changes the runtime for all workspaces. The host must already
              support the selected runtime; its connection is checked before
              switching.
            </p>
            <label className="field" htmlFor="codex-runtime-selection">
              <span>Execution environment</span>
              <Select
                id="codex-runtime-selection"
                value={draft}
                disabled={busy}
                onChange={(event) =>
                  setDraft(event.target.value as typeof draft)
                }
              >
                <option value="environment">
                  Follow environment variable (
                  {runtimeNames[data.environmentDefault]})
                </option>
                {runtimeEngine.options.map((engine) => (
                  <option key={engine} value={engine}>
                    {runtimeNames[engine]}
                  </option>
                ))}
              </Select>
            </label>
            <p className="muted">
              Switching waits until tasks and retained checkpoints are cleaned
              up. Account sign-in and workspace permissions stay in their
              existing settings.
            </p>
            <p className="muted">
              <a
                href="https://github.com/stonega/repodesk/blob/main/docs/implementation/codex-sandboxes.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                Runtime setup instructions
              </a>
            </p>
            {error && (
              <p role="alert" className="notice">
                {error}
              </p>
            )}
            <ModalActions>
              <button type="submit" disabled={busy}>
                {busy ? "Checking and saving…" : "Save"}
              </button>
            </ModalActions>
          </form>
        </Modal>
      )}
      {!editing && <ErrorToast message={error} />}
    </>
  );
}
