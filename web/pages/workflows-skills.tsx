import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ChevronLeft, Search, SquareTopDown } from "reicon-react";
import type {
  WorkflowCollection,
  WorkflowDetail,
} from "../../src/admin/workflow-view.ts";
import type {
  Instruction,
  Skill,
  SkillSpec,
  Workflow,
} from "../../src/domain.ts";
import { workflowSchema } from "../../src/domain.ts";
import { Action, api, Notice, Page, Pager, useData } from "../admin-shared.tsx";
import {
  instructionFields,
  skillFields,
  workflowFields,
} from "../form-fields.ts";
import { IconButton } from "../icon-button.tsx";
import { Modal } from "../modal.tsx";
import { prefixFields, RecordForm } from "../record-form.tsx";
import { Select } from "../select.tsx";
import { Skeleton, SkeletonRows } from "../skeleton.tsx";
import { SkillGitHubUpdate, SkillImport } from "../skill-github.tsx";
import { SkillPreview } from "../skill-preview.tsx";
import { ErrorToast, useToast } from "../toast.tsx";
import { WorkflowSummary } from "../workflow-summary.tsx";
import { ApprovalList } from "./members-groups.tsx";

export function WorkflowDetailRoute({ id }: { id: string }) {
  const { workflowId = "" } = useParams();
  return (
    <WorkflowsPage key={id + workflowId} id={id} workflowId={workflowId} />
  );
}
export function WorkflowsPage({
  id,
  workflowId,
}: {
  id: string;
  workflowId?: string;
}) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const backParams = new URLSearchParams(params);
  backParams.set("workspace", id);
  const listUrl = `/admin/workflows?${backParams.toString()}`;
  const detailUrl = (workflow: string) =>
    `/admin/workflows/${encodeURIComponent(workflow)}?${backParams.toString()}`;
  const {
    data: response,
    error,
    reload,
    loading,
  } = useData<WorkflowCollection | WorkflowDetail>(
    `/api/admin/workspaces/${id}/workflows${workflowId ? `/${encodeURIComponent(workflowId)}` : ""}`,
  );
  const data: WorkflowCollection | undefined =
    !error && response
      ? "workflow" in response
        ? { ...response, items: [response.workflow], total: 1 }
        : response
      : undefined;
  const repositorySources = data?.repositorySources ?? {
    revision: 0,
    repositories: [],
  };
  const skills = useData<{ items: Skill[] }>(
    `/api/admin/workspaces/${id}/skills`,
  );
  const [editing, setEditing] = useState<Workflow>();
  const closeEditor = () => {
    setEditing(undefined);
  };
  const toast = useToast();
  return (
    <Page
      title={workflowId ? "Workflow details" : "Scheduled workflows"}
      description="Daily and weekly schedules use the displayed timezone. Late runs over five minutes are skipped; daylight-saving gaps are skipped and repeated times run once."
      actions={
        error && (
          <Action loading={loading} onClick={async () => reload()}>
            Try again
          </Action>
        )
      }
    >
      {error && (
        <Notice error>
          {workflowId && error === "not_found"
            ? "Workflow not found or no longer available."
            : error}
        </Notice>
      )}
      {workflowId ? (
        <p>
          <Link className="page-back-link" to={listUrl}>
            <ChevronLeft
              size={18}
              weight="Outline"
              color="currentColor"
              aria-hidden="true"
            />
            Back to Workflows
          </Link>
        </p>
      ) : (
        <Pager data={data} />
      )}
      {loading && !data && <SkeletonRows label="Workflows" />}
      {data?.total === 0 && (
        <section className="card">No scheduled workflows yet.</section>
      )}
      {data?.items.map((f) => (
        <section className="card workflow-card" key={f.id}>
          <div className="card-heading">
            <div className="row">
              <h2>
                {workflowId ? (
                  f.spec.name
                ) : (
                  <Link className="workflow-title-link" to={detailUrl(f.id)}>
                    {f.spec.name}
                  </Link>
                )}
              </h2>
              <span className="pill">{f.status}</span>
            </div>
            {f.canEdit && (
              <IconButton
                icon="edit"
                label="Edit"
                type="button"
                onClick={() => setEditing(f)}
              />
            )}
          </div>
          <WorkflowSummary
            workflow={{
              ...f,
              name: f.spec.name,
              recurrence: f.spec.recurrence,
            }}
            detail={!!workflowId}
          />
          {workflowId && (
            <>
              {!f.canEdit && (
                <p>Only the linked workflow owner can edit this schedule.</p>
              )}
              <h3>Task</h3>
              <p className="workflow-text">{f.spec.task}</p>
              <h3>Output format</h3>
              <p className="workflow-text">
                {f.spec.format || "No format specified."}
              </p>
              <dl className="workflow-summary">
                <div>
                  <dt>Source / destination (Telegram)</dt>
                  <dd>
                    {f.spec.chatId}
                    <small>Topic {f.spec.topicId}</small>
                  </dd>
                </div>
                <div>
                  <dt>Context window</dt>
                  <dd>{f.spec.windowDays} days</dd>
                </div>
                <div>
                  <dt>Skill</dt>
                  <dd>
                    {f.spec.skillId ? (
                      <>
                        {skills.data?.items.find(
                          (skill) => skill.id === f.spec.skillId,
                        )?.draft.name ?? f.spec.skillId}
                        <small>Pinned version {f.skillVersion}</small>
                      </>
                    ) : (
                      "No skill"
                    )}
                  </dd>
                </div>
              </dl>
            </>
          )}
          {f.spec.github && (
            <p>
              Repositories:{" "}
              {f.spec.github.repositoryIds
                .map(
                  (repoId) =>
                    repositorySources.repositories.find(
                      (repo) => repo.id === repoId,
                    )?.full_name ?? `Unavailable repository ${repoId}`,
                )
                .join(", ")}
            </p>
          )}
          <div className="row">
            {(
              [
                ...(f.status === "active" ? (["run", "pause"] as const) : []),
                ...(f.status === "paused" ? (["resume"] as const) : []),
                "delete",
              ] as const
            ).map((action) => (
              <Action
                icon={
                  (
                    {
                      run: undefined,
                      pause: "pause",
                      resume: "play",
                      delete: "delete",
                    } as const
                  )[action]
                }
                key={action}
                danger={action === "delete"}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/workflows/${f.id}/action`,
                    "POST",
                    { version: f.version, action },
                  );
                  if (workflowId && action === "delete") navigate(listUrl);
                  else reload();
                }}
              >
                {action}
              </Action>
            ))}
          </div>
        </section>
      ))}
      {data && editing && (
        <Modal title={`Edit ${editing.spec.name}`} onClose={closeEditor}>
          <p>
            Use a linked group ID or an active member’s Telegram ID for private
            delivery. Existing workflows keep their execution owner. Saving
            applies the updated schedule immediately.
          </p>
          <RecordForm
            fields={prefixFields(
              "spec.",
              workflowFields(skills.data?.items ?? [], [
                ...repositorySources.repositories,
                ...(editing.spec.github?.repositoryIds
                  .filter(
                    (repoId) =>
                      !repositorySources.repositories.some(
                        (repo) => repo.id === repoId,
                      ),
                  )
                  .map((repoId) => ({
                    id: repoId,
                    full_name: `Unavailable repository ${repoId}`,
                  })) ?? []),
              ]),
            )}
            value={{
              version: editing.version,
              spec: {
                ...workflowSchema.parse(editing.spec),
                repositoryIds: editing.spec.github?.repositoryIds ?? [],
              },
            }}
            label="Save"
            save={async (value) => {
              const record = value as Record<string, unknown>;
              const spec = record.spec as Record<string, unknown>;
              const repositoryIds = spec.repositoryIds as number[];
              delete spec.repositoryIds;
              if (repositoryIds?.length)
                spec.github = {
                  revision: repositorySources.revision,
                  repositoryIds,
                };
              else delete spec.github;
              await api(
                `/api/admin/workspaces/${id}/workflows/${editing.id}`,
                "PUT",
                value,
              );
              toast("Workflow saved.");
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
    </Page>
  );
}
function SkillCardHeader({
  skill: s,
  onEdit,
  onAction,
}: {
  skill: Skill;
  onEdit: () => void;
  onAction: (action: "enable" | "disable" | "archive") => Promise<void>;
}) {
  const [error, setError] = useState("");
  const notify = useToast();
  return (
    <>
      <div className="skill-card-header">
        <div className="skill-card-title">
          <h2>{s.draft.name}</h2>
          {s.preset && <span className="pill">Preset</span>}
          <span className="pill">
            {s.archived ? "Archived" : s.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="skill-card-controls">
          {!s.preset && (
            <IconButton
              icon="edit"
              label="Edit"
              type="button"
              onClick={onEdit}
            />
          )}
          {(s.preset
            ? ([s.enabled ? "disable" : "enable"] as const)
            : ([s.enabled ? "disable" : "enable", "archive"] as const)
          ).map((action) => (
            <Action
              icon={
                action === "archive"
                  ? "archive"
                  : action === "disable"
                    ? "pause"
                    : "play"
              }
              key={action}
              danger={action === "archive"}
              disabled={s.archived}
              onError={(message) =>
                setError(
                  message === "publish_first"
                    ? "Archived skills cannot be enabled. Reload the page to check this skill’s current status."
                    : s.preset && message.includes("version_conflict")
                      ? "This preset changed in another session. Reload the page before trying again."
                      : message,
                )
              }
              onClick={async () => {
                await onAction(action);
                notify(
                  `Skill ${action === "enable" ? "enabled" : action === "disable" ? "disabled" : "archived"}.`,
                );
              }}
            >
              {action}
            </Action>
          ))}
        </div>
      </div>

      {s.archived ? (
        <p className="muted">
          Archived skills cannot be enabled. Create or import a new skill to
          reuse these instructions.
        </p>
      ) : null}
      <ErrorToast message={error} />
    </>
  );
}

export function SkillsPage({ id }: { id: string }) {
  const notify = useToast();
  const { data, error, reload, loading } = useData<{
    items: (Skill & { dependents: unknown[] })[];
    total: number;
  }>(`/api/admin/workspaces/${id}/skills`);
  const [editing, setEditing] = useState<Skill>();
  const [creating, setCreating] = useState(false);
  const closeEditor = () => {
    setCreating(false);
    setEditing(undefined);
  };
  const [importing, setImporting] = useState(false);
  const [updating, setUpdating] = useState<Skill>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTerms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleSkills = data?.items.filter((skill) => {
    const text =
      `${skill.draft.name} ${skill.draft.slug} ${skill.draft.description}`.toLowerCase();
    return (
      searchTerms.every((term) => text.includes(term)) &&
      (filter === "all" || (filter === "enabled") === skill.enabled)
    );
  });
  const resetFilters = () => {
    setSearch("");
    setFilter("all");
    searchInput.current?.focus();
  };
  const spec: SkillSpec = {
    slug: "my-recap",
    name: "My recap",
    description: "A team-specific recap",
    body: "Summarize supplied sources and cite [source:ID]. Distinguish facts and suggestions.",
    tools: ["read_chat_context", "read_instructions", "load_skill"],
    settings: { sections: "Decisions, blockers, next steps", maxWords: 400 },
  };
  return (
    <Page
      title="Agent skills"
      description="Manage skill instructions and version history on GitHub, then import and review updates here. Skills request existing tools; they cannot grant access."
      actions={
        <>
          <IconButton
            icon="import"
            label="Import skill"
            onClick={() => {
              setImporting(true);
            }}
          />
          <IconButton
            icon="add"
            label="Add skill"
            showLabel
            onClick={() => setCreating(true)}
          />
        </>
      }
    >
      <ErrorToast message={error}>
        <button type="button" onClick={reload}>
          Retry skills
        </button>
      </ErrorToast>
      <Pager data={data} />
      <div className="skill-catalog-toolbar">
        <span className="muted skill-catalog-count" role="status">
          {data &&
            `${visibleSkills?.length} of ${data.items.length} skills${data.total > 100 ? " on this page" : ""}`}
        </span>
        <div className="skill-catalog-controls">
          <div className="skill-catalog-search">
            <Search size={20} aria-hidden="true" focusable="false" />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search skills"
              placeholder="Search skills…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <IconButton
                icon="close"
                label="Clear search"
                onClick={() => {
                  setSearch("");
                  searchInput.current?.focus();
                }}
              />
            )}
          </div>
          <Select
            aria-label="Skill state"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All states</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
        </div>
      </div>
      {data && !error && visibleSkills?.length === 0 && (
        <section className="card skill-catalog-empty">
          <h2>{data.items.length ? "No skills match" : "No skills yet"}</h2>
          <p className="muted">
            {data.items.length
              ? "Try another search or change the skill state."
              : "Import skills from GitHub to get started, or create a custom skill."}
          </p>
          {(search || filter !== "all") && (
            <button type="button" className="secondary" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </section>
      )}
      {loading && !data && (
        <section
          className="card skill-card"
          aria-label="Loading skills"
          aria-busy="true"
        >
          <Skeleton width="45%" />
          <Skeleton width="75%" />
        </section>
      )}
      {visibleSkills?.map((s) => (
        <section className="card skill-card" key={s.id}>
          <SkillCardHeader
            key={`${s.id}:${s.version}`}
            skill={s}
            onEdit={() => setEditing(s)}
            onAction={async (action) => {
              await api(
                `/api/admin/workspaces/${id}/skills/${s.id}/action`,
                "POST",
                {
                  version: s.version,
                  action,
                },
              );
              reload();
            }}
          />
          <p className="skill-card-description">{s.draft.description}</p>
          {s.origin && (
            <p className="muted">
              Saved from a conversation by {s.origin.actor} on{" "}
              {new Date(s.origin.sharedAt).toLocaleDateString()}.{" "}
              {s.published.length
                ? "Saved reusable instruction skill."
                : "Review the instructions before enabling this skill for team use."}
            </p>
          )}
          {!s.preset && s.githubSource && (
            <div className="skill-source-summary">
              <p className="muted">
                Source:{" "}
                <a
                  href={`https://github.com/${s.githubSource.repository}/blob/${encodeURIComponent(s.githubSource.ref)}/${s.githubSource.path.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {s.githubSource.repository} · {s.githubSource.path}
                </a>
                {" · "}
                {s.githubSource.ref}
              </p>
              <div className="skill-source-actions">
                <a
                  className="button-link secondary"
                  href={`https://github.com/${s.githubSource.repository}/blob/${encodeURIComponent(s.githubSource.ref)}/${s.githubSource.path.split("/").map(encodeURIComponent).join("/")}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Source
                  <SquareTopDown
                    size={18}
                    weight="Outline"
                    color="currentColor"
                    aria-hidden="true"
                    focusable="false"
                  />
                </a>
                <button
                  type="button"
                  className="secondary"
                  disabled={s.archived}
                  onClick={() => setUpdating(s)}
                >
                  Check for updates
                </button>
              </div>
            </div>
          )}
          <SkillPreview spec={s.draft} dependents={s.dependents} />
        </section>
      ))}
      {(creating || editing) && (
        <Modal
          title={editing ? `Edit ${editing.draft.name}` : "Create skill"}
          onClose={closeEditor}
        >
          <RecordForm
            fields={prefixFields(editing ? "spec." : "", skillFields)}
            value={
              editing ? { version: editing.version, spec: editing.draft } : spec
            }
            label="Save skill"
            save={async (value) => {
              await api(
                `/api/admin/workspaces/${id}/skills${editing ? `/${editing.id}` : ""}`,
                editing ? "PUT" : "POST",
                value,
              );
              notify("Skill saved.");
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
      {importing && (
        <Modal title="Import SKILL.md" onClose={() => setImporting(false)}>
          <SkillImport
            id={id}
            request={api}
            saved={() => {
              setImporting(false);
              reload();
            }}
          />
        </Modal>
      )}
      {updating && (
        <Modal
          title={`Update ${updating.draft.name}`}
          onClose={() => setUpdating(undefined)}
        >
          <SkillGitHubUpdate
            id={id}
            skill={updating}
            request={api}
            saved={() => {
              setUpdating(undefined);
              reload();
            }}
          />
        </Modal>
      )}
    </Page>
  );
}
export function InstructionsPage({ id }: { id: string }) {
  const { data, error, reload } = useData<{ items: Instruction[] }>(
    `/api/admin/workspaces/${id}/instructions`,
  );
  const [editing, setEditing] = useState<Instruction>();
  const [creating, setCreating] = useState(false);
  const closeEditor = () => {
    setCreating(false);
    setEditing(undefined);
  };
  return (
    <Page
      title="Shared instructions"
      description="Approved corrections apply to future runs. In-flight runs retain their starting version. Personal instructions never enter group context."
      actions={
        <IconButton
          icon="add"
          label="Add instruction"
          onClick={() => setCreating(true)}
        />
      }
    >
      {error && <Notice error>{error}</Notice>}
      <Pager data={data} />
      {data?.items.map((i) => (
        <section className="card" key={i.id}>
          <p className="pill">
            {i.scope} · v{i.version}
          </p>
          <p className="prose">{i.body}</p>
          <p className="muted">
            Author {i.author} · Source {i.provenance}
          </p>
          <div className="row">
            <IconButton
              icon="edit"
              label="Propose edit"
              type="button"
              onClick={() => setEditing(i)}
            />
            <Action
              icon="delete"
              danger
              onClick={async () => {
                await api(
                  `/api/admin/workspaces/${id}/instructions/${i.id}`,
                  "DELETE",
                  { version: i.version },
                );
                reload();
              }}
            >
              Forget
            </Action>
          </div>
        </section>
      ))}
      {(creating || editing) && (
        <Modal
          title={editing ? "Review correction" : "Propose an instruction"}
          onClose={closeEditor}
        >
          <RecordForm
            fields={instructionFields}
            value={
              editing
                ? {
                    body: editing.body,
                    scope: editing.scope,
                    workflowId: editing.workflowId,
                    replaceId: editing.id,
                  }
                : { body: "", scope: "workspace" }
            }
            label="Create approval proposal"
            save={async (value) => {
              await api(
                `/api/admin/workspaces/${id}/instructions`,
                "POST",
                value,
              );
              closeEditor();
              reload();
            }}
          />
        </Modal>
      )}
      <ApprovalList id={id} reloadParent={reload} refreshKey={data} />
    </Page>
  );
}
