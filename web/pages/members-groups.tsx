import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { Approval, Chat, Member } from "../../src/domain.ts";
import { AccessRequests } from "../access-requests.tsx";
import {
  Action,
  api,
  Field,
  Notice,
  Page,
  Pager,
  useData,
} from "../admin-shared.tsx";
import { DataDetails } from "../data-details.tsx";
import { GitHubMemberField } from "../github-member-field.tsx";
import { GroupLinkDialog } from "../group-link.tsx";
import { GroupMentionGuide } from "../group-mention-guide.tsx";
import { GroupRepositoryEditor } from "../group-repository.tsx";
import { IconButton } from "../icon-button.tsx";
import { MemberGitHub } from "../member-github.tsx";
import { Modal, ModalActions } from "../modal.tsx";
import { Select } from "../select.tsx";
import { SkeletonRows } from "../skeleton.tsx";
import { ErrorToast, ErrorToastGroup, useToast } from "../toast.tsx";

interface MembersData {
  version: number;
  items: Member[];
  total: number;
}
interface MemberDraft {
  id: string;
  role: string;
  active: boolean;
  githubId: string;
  githubUsername?: string;
  githubAccount?: Member["githubAccount"];
  github?: Member["github"];
  githubChanged: boolean;
  githubRevision?: number;
}
export function GroupsAndMembersPage({ id }: { id: string }) {
  return (
    <Page
      title="Groups & Members"
      description="Connect your Telegram groups and manage workspace members, roles and access requests."
    >
      <ErrorToastGroup>
        <GroupsSection id={id} />
        <MembersSection id={id} />
        <GroupMentionGuide />
      </ErrorToastGroup>
    </Page>
  );
}
function MembersSection({ id }: { id: string }) {
  const [search, setSearch] = useState("");
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const { data, error, reload, loading } = useData<MembersData>(
    `/api/admin/workspaces/${id}/members?offset=${offset}&search=${encodeURIComponent(search)}`,
  );
  const rows = data?.items ?? [];
  const [member, setMember] = useState<MemberDraft>({
    id: "",
    role: "member",
    active: true,
    githubId: "",
    githubChanged: false,
  });
  const [open, setOpen] = useState(false);
  const [inviteWorkspace, setInviteWorkspace] = useState<string>();
  const [memberError, setMemberError] = useState("");
  return (
    <>
      <ErrorToast message={error}>
        <button
          type="button"
          className="toast-retry"
          aria-label="Retry loading members"
          disabled={loading}
          onClick={reload}
        >
          Retry
        </button>
      </ErrorToast>
      <section
        className="card members-card"
        aria-label="Workspace members"
        aria-busy={loading}
      >
        <div className="card-heading">
          <h2>Members</h2>
          <IconButton
            icon="add"
            label="Add member"
            showLabel
            disabled={!data || loading}
            onClick={() => setInviteWorkspace(id)}
          />
        </div>
        <p className="muted">All active workspace members can use the bot.</p>
        <Field label="Search members by name, username or ID">
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              const next = new URLSearchParams(params);
              next.set("offset", "0");
              setParams(next);
            }}
          />
        </Field>
        <p className="muted">
          Telegram names update when people interact with the bot. Users without
          a username or known profile are identified by their Telegram ID.
        </p>
        <Pager data={data} />
        <section
          className="data-table-scroll"
          aria-label="Member access table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the wide member table.
          tabIndex={0}
        >
          <table className="member-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Membership</th>
                <th>GitHub</th>
                <th>Access</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={6}>
                    {loading ? (
                      <SkeletonRows label="Member details" rows={2} />
                    ) : (
                      "Member details are unavailable."
                    )}
                  </td>
                </tr>
              )}
              {rows.map((m) => {
                const access = m.active ? "Allowed" : "Inactive";
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>
                        {m.name ||
                          (m.username ? `@${m.username}` : "Telegram user")}
                      </strong>
                      {m.username && m.name && <div>@{m.username}</div>}
                      <div className="muted">ID: {m.id}</div>
                    </td>
                    <td>{m.role}</td>
                    <td>{m.active ? "Active" : "Removed"}</td>
                    <td>
                      <MemberGitHub member={m} disabled={loading} />
                    </td>
                    <td>
                      <span
                        className={`pill ${access === "Allowed" ? "good" : ""}`}
                      >
                        {access}
                      </span>
                    </td>
                    <td>
                      {m.role !== "owner" && (
                        <IconButton
                          icon="edit"
                          label={`Edit member ${m.id}`}
                          disabled={loading}
                          onClick={() => {
                            setMember({
                              id: m.id,
                              role: m.role,
                              active: m.active,
                              githubId: String(
                                m.github?.id ?? m.githubAccount?.id ?? "",
                              ),
                              githubAccount: m.githubAccount,
                              github: m.github,
                              githubChanged: false,
                            });
                            setMemberError("");
                            setOpen(true);
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        {data && rows.length === 0 && <p>No members match your search.</p>}
      </section>
      <AccessRequests
        key={id}
        id={id}
        request={api}
        onChange={reload}
        refreshKey={data}
        inviteOpen={inviteWorkspace === id}
        onCloseInvite={() => setInviteWorkspace(undefined)}
      />
      {open && (
        <Modal title="Edit member" onClose={() => setOpen(false)}>
          <Field label="Telegram user ID">
            <input value={member.id} readOnly />
          </Field>
          <p className="muted member-id-help">
            Usernames are received from Telegram; a numeric user ID is required
            for membership.
          </p>
          <GitHubMemberField
            workspaceId={id}
            request={api}
            account={member.github ?? member.githubAccount}
            verified={!!member.github}
            value={member.githubId}
            username={member.githubUsername}
            onChange={(githubId, githubRevision, githubUsername) => {
              setMemberError("");
              setMember((current) => ({
                ...current,
                githubId,
                githubRevision,
                githubUsername,
                githubChanged: true,
              }));
            }}
          />
          <Field label="Role">
            <Select
              aria-label="Role"
              value={member.role}
              onChange={(e) => setMember({ ...member, role: e.target.value })}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </Field>
          <label className="member-toggle-row">
            <span>Active membership</span>
            <input
              className="member-toggle-input"
              type="checkbox"
              role="switch"
              aria-checked={member.active}
              checked={member.active}
              onChange={(e) =>
                setMember({ ...member, active: e.target.checked })
              }
            />
          </label>
          {memberError && (
            <p className="notice" role="alert">
              {memberError}
            </p>
          )}
          <ModalActions>
            <Action
              onError={setMemberError}
              onClick={async () => {
                const username = member.githubUsername
                  ?.trim()
                  .replace(/^@/, "");
                if (
                  member.githubChanged &&
                  member.githubUsername !== undefined &&
                  !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(
                    username ?? "",
                  )
                )
                  throw Error(
                    "Enter a valid GitHub username (up to 39 letters, numbers or hyphens).",
                  );
                await api(`/api/admin/workspaces/${id}/members`, "POST", {
                  id: member.id,
                  role: member.role,
                  active: member.active,
                  ...(member.githubChanged
                    ? {
                        ...(member.githubUsername !== undefined
                          ? { githubUsername: username }
                          : {
                              githubId: member.githubId
                                ? Number(member.githubId)
                                : null,
                            }),
                        githubRevision: member.githubRevision,
                      }
                    : {}),
                  version: data?.version,
                });
                reload();
                setOpen(false);
              }}
            >
              Save membership
            </Action>
          </ModalActions>
        </Modal>
      )}
    </>
  );
}
async function loadGroups(path: string) {
  const groups = await api<{ items: Chat[]; total?: number }>(path);
  while (groups.items.length < (groups.total ?? 0)) {
    const page = await api<{ items: Chat[] }>(
      path.replace("offset=0", `offset=${groups.items.length}`),
    );
    if (!page.items.length) break;
    groups.items.push(...page.items);
  }
  return groups;
}
function GroupsSection({ id }: { id: string }) {
  const { data, error, reload, loading } = useData<{ items: Chat[] }>(
    `/api/admin/workspaces/${id}/chats?offset=0`,
    loadGroups,
  );
  const [linking, setLinking] = useState<{
    workspaceId: string;
    groups: Chat[];
  }>();
  const groupSection = useRef<HTMLElement>(null);
  const focusAfterLinkDialog = useRef(false);
  const linkOpen = linking?.workspaceId === id;
  const linked = linkOpen
    ? (data?.items.some(
        (chat) =>
          chat.active &&
          !linking.groups.some(
            (before) =>
              before.id === chat.id &&
              before.active &&
              before.linkedAt === chat.linkedAt,
          ),
      ) ?? false)
    : false;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = linkOpen && !linked ? setInterval(refresh, 3000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      clearInterval(timer);
    };
  }, [linkOpen, linked, reload]);
  useEffect(() => {
    void id;
    setLinking(undefined);
    focusAfterLinkDialog.current = false;
  }, [id]);
  useEffect(() => {
    if (loading || linkOpen || !focusAfterLinkDialog.current) return;
    // New stays available after linking; restore its focus after the list refresh.
    groupSection.current?.querySelector<HTMLButtonElement>("button")?.focus();
    focusAfterLinkDialog.current = false;
  }, [linkOpen, loading]);
  return (
    <section
      className="card groups-card"
      aria-label="Groups"
      aria-busy={loading}
      ref={groupSection}
    >
      <div className="card-heading">
        <h2>Groups</h2>
        <IconButton
          icon="add"
          label="Link a group"
          showLabel
          disabled={!data || loading || !!error}
          onClick={() =>
            setLinking({ workspaceId: id, groups: data?.items ?? [] })
          }
        />
      </div>
      <p className="muted">
        Connect Telegram groups to this workspace. Create a command for each
        group, then send it there.
      </p>
      <ErrorToast message={error}>
        <button
          type="button"
          className="toast-retry"
          disabled={loading}
          aria-label="Retry loading groups"
          onClick={reload}
        >
          Retry
        </button>
      </ErrorToast>
      <section
        className="data-table-scroll"
        aria-label="Group access table"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the wide group table.
        tabIndex={0}
      >
        <table className="group-table">
          <thead>
            <tr>
              <th scope="col">Group</th>
              <th scope="col">Status</th>
              <th scope="col">Visibility</th>
              <th scope="col">Collection</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!data && (
              <tr>
                <td colSpan={5}>
                  {loading ? (
                    <SkeletonRows label="Group details" rows={2} />
                  ) : (
                    "Group details are unavailable."
                  )}
                </td>
              </tr>
            )}
            {data?.items.map((chat) => (
              <GroupAccessRow
                key={`${id}:${chat.id}`}
                id={id}
                chat={chat}
                loading={loading}
                loadError={error}
                reload={reload}
              />
            ))}
          </tbody>
        </table>
      </section>
      {data?.items.length === 0 && (
        <div className="group-table-message">
          <h3>No group linked</h3>
          <p className="muted">
            Choose New in Groups to get a one-use /link command. The person
            sending it must be an active workspace member and a Telegram group
            admin.
          </p>
        </div>
      )}
      {linkOpen && (
        <GroupLinkDialog
          key={id}
          id={id}
          request={api}
          linked={linked}
          onClose={() => {
            focusAfterLinkDialog.current = true;
            setLinking(undefined);
            reload();
          }}
        />
      )}
    </section>
  );
}
function GroupAccessRow({
  id,
  chat,
  loading,
  loadError,
  reload,
}: {
  id: string;
  chat: Chat;
  loading: boolean;
  loadError: string;
  reload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const row = useRef<HTMLTableRowElement>(null);
  const focusAfterSave = useRef(false);
  useEffect(() => {
    if (loading || editing || !focusAfterSave.current) return;
    row.current?.querySelector<HTMLButtonElement>("button")?.focus();
    focusAfterSave.current = false;
  }, [loading, editing]);
  const notify = useToast();
  const status = `${chat.active ? "Linked" : "Inactive"} · ${chat.visibleAll ? "Receives group messages" : "Directed visibility"} · Collection: ${chat.collection ? "enabled" : "directed only"}`;
  return (
    <>
      <tr className="group-row" ref={row}>
        <td>
          <strong>{chat.title || chat.id}</strong>
          {chat.title && <div className="muted">Group ID: {chat.id}</div>}
          {chat.repository && (
            <div className="muted">Repository: {chat.repository.full_name}</div>
          )}
          {!chat.active && (
            <p className="group-relink-guidance">
              This group is inactive. Choose New in Groups and send the new
              /link command in the group to relink it. Re-adding the bot in
              Telegram does not restore the Telo link.
            </p>
          )}
        </td>
        <td>
          <span className={`pill ${chat.active ? "good" : ""}`}>
            {chat.active ? "Linked" : "Inactive"}
          </span>
        </td>
        <td>
          {chat.visibleAll ? "Receives group messages" : "Directed visibility"}
        </td>
        <td>{chat.collection ? "Enabled" : "Directed only"}</td>
        <td>
          <IconButton
            icon="edit"
            label={`Edit ${chat.title || chat.id}`}
            disabled={loading}
            onClick={() => {
              setError("");
              setEditing(true);
            }}
          />
        </td>
      </tr>
      {editing && (
        <Modal
          title="Edit group"
          busy={loading}
          onClose={() => setEditing(false)}
        >
          <div className="group-link-details">
            <h3>{chat.title || chat.id}</h3>
            {chat.title && <p className="muted">Group ID: {chat.id}</p>}
            <p>{status}</p>
            <p>
              Message collection starts enabled when you link a group. Collected
              messages may include people who are not workspace members. Group
              replies are visible to everyone in the group. Old history is
              unavailable. Changes take effect immediately.
            </p>
            {(error || loadError) && (
              <p className="error" role="alert">
                {error || loadError}
              </p>
            )}
            {loadError && (
              <button type="button" className="secondary" onClick={reload}>
                Retry loading groups
              </button>
            )}
            <div className="row">
              <Action
                loading={loading}
                onError={setError}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/chats/${chat.id}/visibility`,
                    "POST",
                    {},
                  );
                  reload();
                  notify("Bot visibility checked.");
                }}
              >
                Recheck bot visibility
              </Action>
              <Action
                danger
                loading={loading}
                onError={setError}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/chats/${chat.id}/action`,
                    "POST",
                    { action: "unlink" },
                  );
                  reload();
                  notify("Group unlinked.");
                }}
              >
                Unlink group
              </Action>
            </div>
            <section className="row" aria-label="Message collection">
              <Action
                loading={loading}
                onError={setError}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/chats/${chat.id}/action`,
                    "POST",
                    { action: chat.collection ? "directed" : "collect" },
                  );
                  reload();
                  notify(
                    chat.collection
                      ? "Only directed messages will be retained."
                      : "Group message collection enabled.",
                  );
                }}
              >
                {chat.collection
                  ? "Disable message collection"
                  : "Enable message collection"}
              </Action>
            </section>
            <GroupRepositoryEditor
              id={id}
              chat={chat}
              request={api}
              onSaved={() => {
                focusAfterSave.current = true;
                setEditing(false);
                reload();
                notify("Group repository saved.");
              }}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
export function ApprovalList({
  id,
  reloadParent,
  refreshKey,
}: {
  id: string;
  reloadParent?: () => void;
  refreshKey?: unknown;
}) {
  const { data, error, reload, loading } = useData<{ items: Approval[] }>(
    `/api/admin/workspaces/${id}/approvals`,
  );
  useEffect(() => {
    if (refreshKey !== undefined) reload();
  }, [refreshKey, reload]);
  return (
    <section className="card">
      <h2>Awaiting your approval</h2>
      {error && <Notice error>{error}</Notice>}
      {error && (
        <Action loading={loading} onClick={async () => reload()}>
          Try again
        </Action>
      )}
      {data?.items.length === 0 && <p>No pending proposals.</p>}
      {data?.items.map((a) => (
        <article key={a.id}>
          <h3>
            {a.kind} · v{a.version}
          </h3>
          <p>Expires {new Date(a.expiresAt).toLocaleString()}</p>
          <DataDetails value={a.payload} />
          <div className="row">
            {[true, false].map((approve) => (
              <Action
                key={String(approve)}
                danger={!approve}
                onClick={async () => {
                  await api(
                    `/api/admin/workspaces/${id}/approvals/${a.id}`,
                    "POST",
                    { approve },
                  );
                  reload();
                  reloadParent?.();
                }}
              >
                {approve ? "Approve exact proposal" : "Reject"}
              </Action>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}
