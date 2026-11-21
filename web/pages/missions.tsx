import { useState } from "react";
import type {
  AutonomyMode,
  AutonomyView,
  RepositoryAutonomyOverride,
} from "../../src/autonomy/policy.ts";
import type { RepoQueueView } from "../../src/coding/queue.ts";
import type {
  MissionDetail,
  MissionStatus,
} from "../../src/orchestration/types.ts";
import { Action, api, Notice, Page, useData } from "../admin-shared.tsx";
import { IconButton } from "../icon-button.tsx";
import { Modal, ModalActions } from "../modal.tsx";
import { Select } from "../select.tsx";
import { Skeleton, SkeletonRows } from "../skeleton.tsx";
import { ErrorToast, useToast } from "../toast.tsx";

interface MissionListItem {
  id: string;
  actor: string;
  chatId: string;
  topicId: number;
  status: MissionStatus;
  goal: string;
  autonomyMode: AutonomyMode;
  wakeupCount: number;
  maxWakeups: number;
  autoTimerCount: number;
  maxAutoTimers: number;
  spentUsd: number;
  artifactCount: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

function autonomyLabel(mode: AutonomyMode | RepositoryAutonomyOverride) {
  if (mode === "check_in") return "Check-in";
  if (mode === "supervised") return "Supervised";
  return "Inherit workspace default";
}

function missionTerminal(status: MissionStatus) {
  return ["completed", "failed", "cancelled", "halted"].includes(status);
}

export function MissionsPage({ id }: { id: string }) {
  const notify = useToast();
  const autonomy = useData<AutonomyView>(
    `/api/admin/workspaces/${id}/autonomy`,
  );
  const missions = useData<{ items: MissionListItem[]; total: number }>(
    `/api/admin/workspaces/${id}/missions`,
  );
  const queues = useData<{ items: RepoQueueView[] }>(
    `/api/admin/workspaces/${id}/queues`,
  );

  // Autonomy edit modals
  const [editingDefault, setEditingDefault] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState<AutonomyMode>("supervised");
  const [defaultError, setDefaultError] = useState("");
  const [savingDefault, setSavingDefault] = useState(false);

  const [editingRepo, setEditingRepo] = useState<{
    id: number;
    full_name: string;
    override: RepositoryAutonomyOverride;
  }>();
  const [repoDraft, setRepoDraft] =
    useState<RepositoryAutonomyOverride>("inherit");
  const [repoError, setRepoError] = useState("");
  const [savingRepo, setSavingRepo] = useState(false);

  // Mission inspection & cancellation modals
  const [inspecting, setInspecting] = useState<MissionDetail>();
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [cancellingMission, setCancellingMission] = useState<MissionListItem>();
  const [cancelError, setCancelError] = useState("");

  const combinedError = autonomy.error || missions.error || queues.error;
  const refreshAll = () => {
    autonomy.reload();
    missions.reload();
    queues.reload();
  };

  return (
    <Page
      title="Missions & Orchestration"
      description="Configure server-enforced autonomy presets, inspect active background missions, and manage per-repository task queues."
    >
      <ErrorToast message={combinedError}>
        <button
          type="button"
          className="toast-retry"
          aria-label="Retry orchestration loading"
          disabled={autonomy.loading || missions.loading || queues.loading}
          onClick={refreshAll}
        >
          Retry
        </button>
      </ErrorToast>

      {/* Autonomy Policy Summary Card (Saved Display Separate From Modal Editor) */}
      <section
        className="card"
        aria-label="Autonomy policy"
        aria-busy={autonomy.loading}
      >
        <div className="card-heading">
          <div className="row">
            <h2>Autonomy policy</h2>
            {autonomy.data ? (
              <span
                className={`pill${autonomy.data.defaultMode === "check_in" ? " good" : ""}`}
              >
                {autonomyLabel(autonomy.data.defaultMode)}
              </span>
            ) : autonomy.loading ? (
              <Skeleton width="6em" />
            ) : (
              <span className="muted">Unavailable</span>
            )}
          </div>
          {autonomy.data && (
            <IconButton
              icon="edit"
              label="Edit autonomy policy"
              type="button"
              onClick={() => {
                setDefaultDraft(autonomy.data?.defaultMode ?? "supervised");
                setDefaultError("");
                setEditingDefault(true);
              }}
            />
          )}
        </div>
        <dl className="plugin-summary">
          <div>
            <dt>Workspace default</dt>
            <dd>
              {autonomy.data ? (
                autonomyLabel(autonomy.data.defaultMode)
              ) : autonomy.loading ? (
                <Skeleton width="8em" />
              ) : (
                "Unavailable"
              )}
            </dd>
          </div>
          <div>
            <dt>Routine non-destructive writes</dt>
            <dd>
              {autonomy.data ? (
                autonomy.data.defaultMode === "check_in" ? (
                  "Automatic with audit trail"
                ) : (
                  "Human approval required"
                )
              ) : autonomy.loading ? (
                <Skeleton width="12em" />
              ) : (
                "Unavailable"
              )}
            </dd>
          </div>
          <div>
            <dt>High-impact actions (L3)</dt>
            <dd>Mandatory human approval (immutable)</dd>
          </div>
        </dl>
        {autonomy.data && autonomy.data.repositories.length > 0 && (
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Override</th>
                  <th>Effective mode</th>
                  <th className="actions-cell">Actions</th>
                </tr>
              </thead>
              <tbody>
                {autonomy.data.repositories.map((repo) => (
                  <tr key={repo.id}>
                    <td>{repo.full_name}</td>
                    <td>{autonomyLabel(repo.override)}</td>
                    <td>
                      <span
                        className={`pill${repo.effectiveMode === "check_in" ? " good" : ""}`}
                      >
                        {autonomyLabel(repo.effectiveMode)}
                      </span>
                    </td>
                    <td className="actions-cell">
                      <IconButton
                        icon="edit"
                        label={`Edit autonomy for ${repo.full_name}`}
                        type="button"
                        onClick={() => {
                          setEditingRepo({
                            id: repo.id,
                            full_name: repo.full_name,
                            override: repo.override,
                          });
                          setRepoDraft(repo.override);
                          setRepoError("");
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Background Missions Card */}
      <section
        className="card"
        aria-label="Background missions"
        aria-busy={missions.loading}
      >
        <div className="card-heading">
          <h2>Background missions</h2>
          <Action
            loading={missions.loading}
            onClick={async () => missions.reload()}
          >
            Refresh
          </Action>
        </div>
        {missions.loading && !missions.data ? (
          <SkeletonRows label="Background missions" />
        ) : !missions.data?.items.length ? (
          <p className="muted">No background missions recorded yet.</p>
        ) : (
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Goal</th>
                  <th>Status</th>
                  <th>Wakeups</th>
                  <th>Auto-checks</th>
                  <th className="actions-cell">Actions</th>
                </tr>
              </thead>
              <tbody>
                {missions.data.items.map((mission) => (
                  <tr key={mission.id}>
                    <td>{mission.goal}</td>
                    <td>
                      <span
                        className={`pill${mission.status === "completed" ? " good" : ""}`}
                      >
                        {mission.status}
                      </span>
                    </td>
                    <td>
                      {mission.wakeupCount}/{mission.maxWakeups}
                    </td>
                    <td>
                      {mission.autoTimerCount}/{mission.maxAutoTimers}
                    </td>
                    <td className="actions-cell">
                      <div className="row">
                        <button
                          type="button"
                          className="secondary"
                          disabled={loadingDetail}
                          onClick={async () => {
                            setLoadingDetail(true);
                            try {
                              const detail = await api<MissionDetail>(
                                `/api/admin/workspaces/${id}/missions/${encodeURIComponent(mission.id)}`,
                              );
                              setInspecting(detail);
                            } catch (error) {
                              notify(
                                error instanceof Error
                                  ? error.message
                                  : "Unable to load mission details.",
                              );
                            } finally {
                              setLoadingDetail(false);
                            }
                          }}
                        >
                          View
                        </button>
                        {!missionTerminal(mission.status) && (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => {
                              setCancelError("");
                              setCancellingMission(mission);
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Per-Repository Task Queues Card */}
      <section
        className="card"
        aria-label="Repository task queues"
        aria-busy={queues.loading}
      >
        <div className="card-heading">
          <h2>Repository task queues</h2>
          <Action
            loading={queues.loading}
            onClick={async () => queues.reload()}
          >
            Refresh
          </Action>
        </div>
        {queues.loading && !queues.data ? (
          <SkeletonRows label="Repository task queues" />
        ) : !queues.data?.items.length ? (
          <p className="muted">No connected repository queues yet.</p>
        ) : (
          queues.data.items.map((entry) => {
            const { queue, running, queued } = entry;
            const toggleAction = queue.paused ? "Resume queue" : "Pause queue";
            return (
              <div
                key={queue.repositoryId}
                className="repo-queue-section"
                style={{
                  paddingTop: "0.75rem",
                  borderTop: "1px solid var(--border)",
                }}
              >
                <div className="card-heading">
                  <div className="row">
                    <h3>{queue.repository}</h3>
                    <span className={`pill${queue.paused ? "" : " good"}`}>
                      {queue.paused ? "Paused" : "Active"}
                    </span>
                  </div>
                  <Action
                    onClick={async () => {
                      await api(
                        `/api/admin/workspaces/${id}/queues/${queue.repositoryId}/${queue.paused ? "resume" : "pause"}`,
                        "POST",
                        {},
                      );
                      notify(
                        queue.paused
                          ? `Resumed queue for ${queue.repository}.`
                          : `Paused queue for ${queue.repository}.`,
                      );
                      queues.reload();
                    }}
                  >
                    {toggleAction}
                  </Action>
                </div>
                {running.length === 0 && queued.length === 0 ? (
                  <p className="muted">Queue is idle.</p>
                ) : (
                  <div className="data-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Status</th>
                          <th>Priority</th>
                          <th className="actions-cell">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...running, ...queued].map((item) => (
                          <tr key={item.id}>
                            <td>
                              {item.title}
                              {item.carryover?.prUrl && (
                                <small>
                                  {" "}
                                  · Carries over previous PR context
                                </small>
                              )}
                            </td>
                            <td>
                              <span
                                className={`pill${item.status === "running" ? " good" : ""}`}
                              >
                                {item.status}
                              </span>
                            </td>
                            <td>{item.priority}</td>
                            <td className="actions-cell">
                              <div className="row">
                                {item.status === "queued" && (
                                  <Action
                                    onClick={async () => {
                                      await api(
                                        `/api/admin/workspaces/${id}/queues/${queue.repositoryId}/items/${encodeURIComponent(item.id)}/pin`,
                                        "POST",
                                        {},
                                      );
                                      notify("Pinned task to front of queue.");
                                      queues.reload();
                                    }}
                                  >
                                    Pin
                                  </Action>
                                )}
                                <Action
                                  danger
                                  onClick={async () => {
                                    await api(
                                      `/api/admin/workspaces/${id}/queues/${queue.repositoryId}/items/${encodeURIComponent(item.id)}/cancel`,
                                      "POST",
                                      {},
                                    );
                                    notify("Cancelled queued task.");
                                    queues.reload();
                                  }}
                                >
                                  Cancel
                                </Action>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>

      {/* Edit Workspace Default Autonomy Modal */}
      {editingDefault && autonomy.data && (
        <Modal
          title="Edit workspace autonomy policy"
          busy={savingDefault}
          onClose={() => setEditingDefault(false)}
        >
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="autonomy-default-mode">
                Workspace default mode
              </label>
              <Select
                id="autonomy-default-mode"
                value={defaultDraft}
                disabled={savingDefault}
                onChange={(event) => {
                  setDefaultDraft(event.target.value as AutonomyMode);
                  setDefaultError("");
                }}
              >
                <option value="supervised">
                  Supervised — require approval for external writes
                </option>
                <option value="check_in">
                  Check-in — automate routine non-destructive writes; gate L3
                </option>
              </Select>
              <small>
                High-impact actions (merging/closing PRs, publishing releases or
                tags, deleting resources, and changing permissions) always
                require human approval.
              </small>
            </div>
            {defaultError && <Notice error>{defaultError}</Notice>}
            <ModalActions>
              <Action
                type="submit"
                loading={savingDefault}
                onError={setDefaultError}
                onClick={async () => {
                  setSavingDefault(true);
                  setDefaultError("");
                  try {
                    await api(`/api/admin/workspaces/${id}/autonomy`, "PATCH", {
                      revision: autonomy.data?.revision ?? 0,
                      defaultMode: defaultDraft,
                    });
                    setEditingDefault(false);
                    notify("Autonomy policy saved.");
                    autonomy.reload();
                  } catch (error) {
                    setDefaultError(
                      error instanceof Error
                        ? error.message
                        : "Unable to save autonomy policy.",
                    );
                  } finally {
                    setSavingDefault(false);
                  }
                }}
              >
                Save policy
              </Action>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* Edit Repository Autonomy Override Modal */}
      {editingRepo && autonomy.data && (
        <Modal
          title={`Autonomy for ${editingRepo.full_name}`}
          busy={savingRepo}
          onClose={() => setEditingRepo(undefined)}
        >
          <form onSubmit={(event) => event.preventDefault()}>
            <div className="field">
              <label htmlFor="autonomy-repo-mode">
                Repository autonomy mode
              </label>
              <Select
                id="autonomy-repo-mode"
                value={repoDraft}
                disabled={savingRepo}
                onChange={(event) => {
                  setRepoDraft(
                    event.target.value as RepositoryAutonomyOverride,
                  );
                  setRepoError("");
                }}
              >
                <option value="inherit">Inherit workspace default</option>
                <option value="supervised">Supervised</option>
                <option value="check_in">Check-in</option>
              </Select>
              <small>
                L3 actions (merge, release, delete, permissions) remain approval
                gated in all modes.
              </small>
            </div>
            {repoError && <Notice error>{repoError}</Notice>}
            <ModalActions>
              <Action
                type="submit"
                loading={savingRepo}
                onError={setRepoError}
                onClick={async () => {
                  setSavingRepo(true);
                  setRepoError("");
                  try {
                    await api(
                      `/api/admin/workspaces/${id}/github/repositories/${editingRepo.id}/autonomy`,
                      "PATCH",
                      {
                        revision: autonomy.data?.revision ?? 0,
                        mode: repoDraft,
                      },
                    );
                    setEditingRepo(undefined);
                    notify(`Updated autonomy for ${editingRepo.full_name}.`);
                    autonomy.reload();
                  } catch (error) {
                    setRepoError(
                      error instanceof Error
                        ? error.message
                        : "Unable to update repository autonomy.",
                    );
                  } finally {
                    setSavingRepo(false);
                  }
                }}
              >
                Save override
              </Action>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* Mission Detail Inspection Modal */}
      {inspecting && (
        <Modal
          title="Mission details"
          cancelLabel="Close"
          onClose={() => setInspecting(undefined)}
        >
          <dl className="plugin-summary">
            <div>
              <dt>Goal</dt>
              <dd>{inspecting.mission.goal}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className="pill">{inspecting.mission.status}</span>
              </dd>
            </div>
            <div>
              <dt>Autonomy</dt>
              <dd>{autonomyLabel(inspecting.mission.autonomyMode)}</dd>
            </div>
            <div>
              <dt>Wakeups</dt>
              <dd>
                {inspecting.mission.wakeupCount}/{inspecting.mission.maxWakeups}
              </dd>
            </div>
          </dl>
          {inspecting.waits.length > 0 && (
            <>
              <h3>Waits</h3>
              <ul>
                {inspecting.waits.map((wait) => (
                  <li key={wait.id}>
                    <strong>{wait.kind}</strong> ({wait.status})
                    {wait.reason ? ` — ${wait.reason}` : ""}
                    {wait.dueAt ? ` · due ${wait.dueAt}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          {inspecting.mission.artifacts.length > 0 && (
            <>
              <h3>Verified artifacts</h3>
              <ul>
                {inspecting.mission.artifacts.map((art) => (
                  <li key={art.id}>
                    <strong>{art.label}:</strong> {art.value}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ModalActions>
            {!missionTerminal(inspecting.mission.status) && (
              <Action
                danger
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/missions/${encodeURIComponent(inspecting.mission.id)}/cancel`,
                    "POST",
                    {},
                  );
                  setInspecting(undefined);
                  notify("Mission cancelled.");
                  missions.reload();
                }}
              >
                Cancel mission
              </Action>
            )}
          </ModalActions>
        </Modal>
      )}

      {/* Confirm Cancel Mission Modal */}
      {cancellingMission && (
        <Modal
          title="Cancel mission?"
          onClose={() => setCancellingMission(undefined)}
        >
          <p>
            Stop background follow-up and cancel pending waits for{" "}
            <strong>{cancellingMission.goal}</strong>?
          </p>
          {cancelError && <Notice error>{cancelError}</Notice>}
          <ModalActions>
            <Action
              danger
              onError={setCancelError}
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/missions/${encodeURIComponent(cancellingMission.id)}/cancel`,
                  "POST",
                  {},
                );
                setCancellingMission(undefined);
                notify("Mission cancelled.");
                missions.reload();
              }}
            >
              Cancel mission
            </Action>
          </ModalActions>
        </Modal>
      )}
    </Page>
  );
}
