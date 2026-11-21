import { useCallback, useEffect, useState } from "react";
import type { DevelopmentTask } from "../src/coding/development.ts";
import type { CodingEnvironment } from "../src/coding/local/protocol.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { SkeletonRows } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";
import { useRepositoryRefresh } from "./use-repository-refresh.ts";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;

const messages: Record<string, string> = {
  coding_environment_in_use:
    "A task is currently using this cached environment. Wait for it to finish or stop it before resetting.",
  coding_runner_not_configured:
    "The Codex runner is not configured for this deployment.",
  coding_runner_unavailable:
    "The Codex runner is unavailable. Cached environments could not be reached.",
  coding_outcome_unknown:
    "The reset response could not be confirmed. Check the cached environment list before trying again.",
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError")
    return "The request timed out. Try again once the Codex runner responds.";
  const code = (error as Error).message;
  return (
    messages[code] ??
    "The cached environment request failed. Check the runner connection and try again."
  );
}

export function CodingEnvironments({
  request,
  workspaceId,
  repositories,
  tasks,
}: {
  request: Request;
  workspaceId: string;
  repositories: { id: number; full_name: string }[];
  tasks: DevelopmentTask[];
}) {
  const notify = useToast();
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/coding/environments`;
  const [environments, setEnvironments] = useState<CodingEnvironment[]>();
  const [unconfigured, setUnconfigured] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<{
    repositoryId: number;
    name: string;
    volume: string;
  }>();
  const [resetError, setResetError] = useState("");

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await request<{ environments?: CodingEnvironment[] }>(
          endpoint,
          "GET",
          undefined,
          AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        );
        if (!signal.aborted) {
          setEnvironments(
            Array.isArray(result?.environments) ? result.environments : [],
          );
          setUnconfigured(false);
          setError("");
        }
      } catch (cause) {
        if (signal.aborted) return;
        const code = (cause as Error).message;
        if (code === "coding_runner_not_configured") {
          setUnconfigured(true);
          setEnvironments(undefined);
          setError("");
        } else {
          setUnconfigured(false);
          setError(errorMessage(cause));
        }
      }
    },
    [endpoint, request],
  );

  useRepositoryRefresh(refresh, !resetting && !busy && !loading, 10000);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset cached environment state when switching workspaces.
  useEffect(() => {
    setEnvironments(undefined);
    setUnconfigured(false);
    setError("");
    setResetting(undefined);
    setResetError("");
  }, [endpoint]);

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await request<{ environments?: CodingEnvironment[] }>(
        endpoint,
        "GET",
        undefined,
        AbortSignal.timeout(15000),
      );
      setEnvironments(
        Array.isArray(result?.environments) ? result.environments : [],
      );
      setUnconfigured(false);
    } catch (cause) {
      const code = (cause as Error).message;
      if (code === "coding_runner_not_configured") {
        setUnconfigured(true);
        setEnvironments(undefined);
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setLoading(false);
    }
  };

  const repoNames = new Map<number, string>();
  for (const task of tasks)
    repoNames.set(task.payload.repositoryId, task.payload.repository);
  for (const repo of repositories) repoNames.set(repo.id, repo.full_name);

  const activeRepositories = new Set(
    tasks
      .filter((task) => ["working", "publishing"].includes(task.state))
      .map((task) => task.payload.repositoryId),
  );

  const confirmReset = async () => {
    if (!resetting || busy) return;
    setBusy(true);
    setResetError("");
    try {
      const target = resetting;
      const result = await request<{ removed: boolean }>(
        `${endpoint}/${target.repositoryId}/reset`,
        "POST",
        {},
        AbortSignal.timeout(30000),
      );
      setEnvironments((current) =>
        current?.filter((item) => item.repositoryId !== target.repositoryId),
      );
      setResetting(undefined);
      notify(
        result.removed
          ? `Cached environment reset for ${target.name}.`
          : `Cached environment for ${target.name} was already empty.`,
      );
    } catch (cause) {
      setResetError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section
        className="card coding-environments-card"
        aria-label="Cached environments"
        aria-busy={environments === undefined && !error && !unconfigured}
      >
        <div className="plugin-card-heading coding-card-heading">
          <div>
            <h2>Cached environments</h2>
            <p className="muted">
              Persistent <code>/env</code> volumes keep installed runtimes and
              package caches across work tasks.
            </p>
          </div>
        </div>
        {unconfigured ? (
          <p className="muted">
            Connect the Codex runner to inspect or reset cached environments.
          </p>
        ) : environments === undefined ? (
          error ? (
            <p className="muted">Cached environments could not be loaded.</p>
          ) : (
            <SkeletonRows label="Cached environments" />
          )
        ) : !environments.length ? (
          <p className="muted">
            No cached environments yet. Work tasks automatically create a
            persistent <code>/env</code> volume for each repository.
          </p>
        ) : (
          <ul className="coding-env-list">
            {environments.map((item) => {
              const name =
                repoNames.get(item.repositoryId) ??
                `Repository #${item.repositoryId}`;
              const inUse = activeRepositories.has(item.repositoryId);
              return (
                <li key={item.repositoryId} className="coding-env-row">
                  <div className="coding-env-meta">
                    <div className="coding-env-title">
                      <strong>{name}</strong>
                      {inUse && <span className="pill">In use</span>}
                    </div>
                    <code className="coding-env-volume">{item.volume}</code>
                  </div>
                  <IconButton
                    icon="delete"
                    label={`Reset cached environment for ${name}`}
                    disabled={busy || loading || inUse}
                    onClick={() => {
                      setResetError("");
                      setResetting({
                        repositoryId: item.repositoryId,
                        name,
                        volume: item.volume,
                      });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {resetting && (
        <Modal
          title="Reset cached environment?"
          busy={busy}
          onClose={() => {
            setResetting(undefined);
            setResetError("");
          }}
        >
          <p>
            <strong>{resetting.name}</strong>
            <br />
            <code className="muted">{resetting.volume}</code>
          </p>
          <p>
            Resetting removes the persistent <code>/env</code> volume for this
            repository. The next work task will reinstall runtimes and package
            caches automatically. Published branches and PRs on GitHub remain
            unaffected.
          </p>
          {resetError && (
            <p className="notice" role="alert">
              {resetError}
            </p>
          )}
          <ModalActions>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void confirmReset()}
            >
              {busy ? "Resetting…" : "Reset"}
            </button>
          </ModalActions>
        </Modal>
      )}
      {!resetting && error && (
        <ErrorToast message={error}>
          <button
            type="button"
            aria-label="Retry loading cached environments"
            disabled={busy || loading}
            onClick={() => void reload()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
    </>
  );
}
