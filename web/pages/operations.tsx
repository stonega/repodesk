import { useState } from "react";
import { NavLink } from "react-router";
import {
  Action,
  api,
  Notice,
  Page,
  type Progress,
  useData,
} from "../admin-shared.tsx";
import { DataDetails, DataTable } from "../data-details.tsx";
import { accountFields, workspaceOptions } from "../form-fields.ts";
import { IconButton } from "../icon-button.tsx";
import { Modal, ModalActions } from "../modal.tsx";
import { RecordForm } from "../record-form.tsx";
import { Skeleton } from "../skeleton.tsx";
import { ErrorToast, useToast } from "../toast.tsx";

export function Operations() {
  const { data, error, reload, loading } = useData<{
    workers: number;
    failed_runs: number;
    unknown_deliveries: number;
    pending: number;
    oldest_seconds: number;
    paused: boolean;
    audit: Record<string, unknown>[];
  }>("/api/admin/operator/health");
  const progress = useData<Progress>("/api/setup/progress");
  const [accountResult, setAccountResult] = useState<unknown>();
  const [verificationResult, setVerificationResult] = useState<unknown>();
  const [diagnostic, setDiagnostic] = useState<unknown>();
  const [editor, setEditor] = useState<
    "account" | "verification" | "recovery" | "diagnostic"
  >();
  const [confirming, setConfirming] = useState<{
    paused: boolean;
    version: number;
  }>();
  const [pauseError, setPauseError] = useState("");
  const notify = useToast();
  const workspaces = progress.data?.workspaces.filter((w) => !w.deleted) ?? [];
  const workspaceReady =
    !!progress.data && !progress.error && !!workspaces.length;
  const paused = progress.data?.paused;
  const pauseAction = paused ? "Resume deployment" : "Pause deployment";
  const refresh = () => {
    reload();
    progress.reload();
  };
  const closeEditor = () => setEditor(undefined);
  return (
    <Page
      title="Operations"
      description="Service health and deployment controls. Operator privileges do not grant access to private conversations."
    >
      <ErrorToast message={error || progress.error}>
        <button
          type="button"
          className="toast-retry"
          aria-label="Retry operations loading"
          disabled={loading || progress.loading}
          onClick={refresh}
        >
          Retry
        </button>
      </ErrorToast>
      <section className="card" aria-label="Service health" aria-busy={loading}>
        <div className="card-heading">
          <h2>Service health</h2>
          <NavLink to="/admin/logs">View runtime logs</NavLink>
        </div>
        <dl className="plugin-summary">
          {[
            ["Live workers", data?.workers],
            ["Pending dispatch", data?.pending],
            [
              "Oldest pending",
              data
                ? `${Math.round(data.oldest_seconds ?? 0)} seconds`
                : undefined,
            ],
            ["Failed runs", data?.failed_runs],
            ["Unknown deliveries", data?.unknown_deliveries],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value ?? (loading ? <Skeleton width="5em" /> : "Unavailable")}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section
        className="card"
        aria-label="Deployment activity"
        aria-busy={progress.loading}
      >
        <div className="card-heading">
          <div className="row">
            <h2>Deployment activity</h2>
            {progress.data ? (
              <span className="pill">{paused ? "Paused" : "Active"}</span>
            ) : progress.loading ? (
              <Skeleton width="5em" />
            ) : (
              <span className="muted">Unavailable</span>
            )}
          </div>
          <button
            type="button"
            className={paused ? undefined : "danger"}
            disabled={!progress.data || !!progress.error}
            onClick={() => {
              setPauseError("");
              if (progress.data)
                setConfirming({
                  paused: progress.data.paused,
                  version: progress.data.version,
                });
            }}
          >
            {pauseAction}
          </button>
        </div>
        <p className="muted">
          Pause assistant execution and run delivery across all workspaces, or
          resume when the deployment is ready.
        </p>
      </section>
      <section className="card" aria-label="Run diagnostics">
        <div className="card-heading">
          <h2>Run diagnostics</h2>
          <button type="button" onClick={() => setEditor("diagnostic")}>
            Inspect run
          </button>
        </div>
        <p className="muted">
          Look up a run by ID to inspect its redacted status, attempts and
          delivery records.
        </p>
        {diagnostic !== undefined && <DataDetails value={diagnostic} />}
      </section>
      <section
        className="card"
        aria-label="Recent operator actions"
        aria-busy={loading}
      >
        <h2>Recent operator actions</h2>
        {!data && error ? (
          <p className="muted">Operator actions are unavailable.</p>
        ) : (
          <DataTable
            rows={data?.audit}
            label="Operator actions"
            columns={[
              { key: "at", label: "Time" },
              { key: "action", label: "Action" },
              { key: "actor", label: "Actor" },
              { key: "target", label: "Target" },
            ]}
          />
        )}
      </section>
      <section className="card" aria-label="Panel accounts">
        <div className="card-heading">
          <h2>Panel accounts</h2>
          <IconButton
            icon="add"
            label="Create panel account"
            showLabel
            onClick={() => setEditor("account")}
          />
        </div>
        <p className="muted">
          New accounts have no operator privileges. Link their Telegram identity
          and enroll them separately.
        </p>
        {accountResult !== undefined && (
          <>
            <h3>Created account</h3>
            <DataDetails value={accountResult} />
          </>
        )}
        <div className="card-heading">
          <h3>Identity verification</h3>
          <button
            type="button"
            disabled={!workspaceReady}
            onClick={() => setEditor("verification")}
          >
            Issue link
          </button>
        </div>
        <p className="muted">
          Enroll the intended Telegram ID in Members first. A one-use link
          verifies an eligible workspace member's panel account.
        </p>
        {progress.data && !workspaces.length && (
          <p className="muted">
            Create a workspace before issuing a link or recovering access.
          </p>
        )}
        {verificationResult !== undefined && (
          <>
            <h3>Issued verification link</h3>
            <DataDetails value={verificationResult} />
          </>
        )}
      </section>
      <section className="card" aria-label="Recover workspace access">
        <div className="card-heading">
          <h2>Recover workspace access</h2>
          <button
            type="button"
            disabled={!workspaceReady}
            onClick={() => setEditor("recovery")}
          >
            Recover access
          </button>
        </div>
        <p className="muted">
          Restore management access for an existing workspace owner or admin.
          Recovery is audited and does not grant access to private
          conversations.
        </p>
      </section>
      <section
        className="card"
        aria-label="Workspace setup & purge status"
        aria-busy={progress.loading}
      >
        <h2>Workspace setup & purge status</h2>
        {!progress.data && progress.error ? (
          <p className="muted">Workspace status is unavailable.</p>
        ) : (
          <DataTable
            label="Workspaces"
            rows={progress.data?.workspaces.map((workspace) => ({
              name: workspace.settings.name,
              status: workspace.deleted ? "Removed" : "Active",
              ownerVerified: workspace.ownerVerified,
              skills: `${workspace.skills.filter((skill) => skill.enabled).length} of ${workspace.skills.length} enabled`,
              timezone: workspace.settings.timezone,
            }))}
            columns={[
              { key: "name", label: "Workspace" },
              { key: "status", label: "Status" },
              { key: "ownerVerified", label: "Telegram owner linked" },
              { key: "skills", label: "Skills" },
              { key: "timezone", label: "Timezone" },
            ]}
          />
        )}
      </section>
      {confirming && (
        <Modal
          title={`${confirming.paused ? "Resume" : "Pause"} deployment?`}
          onClose={() => setConfirming(undefined)}
        >
          <p>
            {confirming.paused
              ? "Resume assistant execution and run delivery across all workspaces? Workspace-level pauses and permissions still apply."
              : "Pause assistant execution and run delivery across all workspaces? You can resume the deployment here when you are ready."}
          </p>
          {pauseError && <Notice error>{pauseError}</Notice>}
          {pauseError.includes("version_conflict") && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirming(undefined);
                refresh();
              }}
            >
              Reload current version
            </button>
          )}
          <ModalActions>
            <Action
              danger={!confirming.paused}
              disabled={pauseError.includes("version_conflict")}
              onError={setPauseError}
              onClick={async () => {
                await api("/api/admin/operator/pause", "POST", {
                  paused: !confirming.paused,
                  version: confirming.version,
                });
                setConfirming(undefined);
                notify(
                  confirming.paused
                    ? "Deployment resumed."
                    : "Deployment paused.",
                );
                refresh();
              }}
            >
              {confirming.paused ? "Resume deployment" : "Pause deployment"}
            </Action>
          </ModalActions>
        </Modal>
      )}
      {editor === "account" && (
        <Modal title="Create panel account" onClose={closeEditor}>
          <p>
            New accounts have no operator privileges. Enroll and verify their
            Telegram identity separately.
          </p>
          <RecordForm
            fields={accountFields}
            value={{ username: "", password: "" }}
            label="Create account"
            pendingLabel="Creating account…"
            save={async (value) => {
              setAccountResult(
                await api("/api/admin/operator/accounts", "POST", value),
              );
              closeEditor();
              notify("Panel account created.");
              reload();
            }}
          />
        </Modal>
      )}
      {editor === "verification" && (
        <Modal title="Issue identity verification" onClose={closeEditor}>
          <p>
            Enroll the intended Telegram ID in Members first. Verification
            succeeds only for an eligible workspace member.
          </p>
          <RecordForm
            fields={[
              { path: "accountId", label: "Panel account ID", required: true },
              workspaceOptions(workspaces),
            ]}
            value={{ accountId: "", workspaceId: workspaces[0]?.id ?? "" }}
            label="Issue one-use link"
            pendingLabel="Issuing link…"
            save={async (value) => {
              const input = value as { accountId: string; workspaceId: string };
              setVerificationResult(
                await api(
                  `/api/admin/operator/accounts/${encodeURIComponent(input.accountId)}/link`,
                  "POST",
                  { workspaceId: input.workspaceId },
                ),
              );
              closeEditor();
              notify("Identity verification link issued.");
              reload();
            }}
          />
        </Modal>
      )}
      {editor === "recovery" && (
        <Modal title="Recover workspace access" onClose={closeEditor}>
          <p>
            This audited action restores an existing owner or admin. It does not
            grant access to private conversations.
          </p>
          <RecordForm
            fields={[
              workspaceOptions(workspaces),
              { path: "telegramId", label: "Telegram user ID", required: true },
            ]}
            value={{ workspaceId: workspaces[0]?.id ?? "", telegramId: "" }}
            label="Restore management access"
            pendingLabel="Restoring access…"
            save={async (value) => {
              const input = value as {
                workspaceId: string;
                telegramId: string;
              };
              await api(
                `/api/admin/operator/recover/${encodeURIComponent(input.workspaceId)}`,
                "POST",
                { telegramId: input.telegramId },
              );
              closeEditor();
              notify("Workspace management access restored.");
              refresh();
            }}
          />
        </Modal>
      )}
      {editor === "diagnostic" && (
        <Modal title="Inspect run" onClose={closeEditor}>
          <p>Only redacted operational details are shown.</p>
          <RecordForm
            fields={[{ path: "runId", label: "Run ID", required: true }]}
            value={{ runId: "" }}
            label="Inspect redacted status"
            pendingLabel="Inspecting…"
            save={async (value) => {
              const input = value as { runId: string };
              setDiagnostic(
                await api(
                  `/api/admin/operator/runs/${encodeURIComponent(input.runId)}`,
                ),
              );
              closeEditor();
            }}
          />
        </Modal>
      )}
    </Page>
  );
}
