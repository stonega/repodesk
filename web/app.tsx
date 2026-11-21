import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import { Check } from "reicon-react";
import type { Session } from "../src/domain.ts";
import {
  Action,
  ApiError,
  api,
  Notice,
  Page,
  type Progress,
  sessionEvents,
  setCsrf,
} from "./admin-shared.tsx";
import { ApplicationUpdate } from "./application-update.tsx";
import { AuthNetwork } from "./auth-network.tsx";
import { RuntimeLogs } from "./logs.tsx";
import { Auth, ModelSettings, Setup } from "./pages/auth-setup.tsx";
import { Operations } from "./pages/operations.tsx";
import { WorkspacePage } from "./pages/overview-settings.tsx";
import { RunDetailRoute, ThreadDetailRoute } from "./pages/runs-privacy.tsx";
import { WorkflowDetailRoute } from "./pages/workflows-skills.tsx";
import { PackageDetail } from "./plugin-packages.tsx";
import { Plugins } from "./plugins.tsx";
import { SelfCheck } from "./self-check.tsx";
import { Sidebar } from "./sidebar.tsx";
import { SiteDomain } from "./site-domain.tsx";
import { ThemeSwitch } from "./theme-switch.tsx";
import { ToastProvider } from "./toast.tsx";
import "./style.css";

function WorkspacePicker({
  workspaces,
  chosen,
  operator,
  onSelect,
  onCreate,
}: {
  workspaces: { id: string; name: string }[];
  chosen: string;
  operator: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusOnOpen = useRef<"first" | "last" | null>(null);
  const selected = workspaces.find((workspace) => workspace.id === chosen);
  const currentLabel =
    selected?.name ??
    (operator ? "No workspaces yet" : "Verify Telegram to continue");
  const items = useCallback(
    () =>
      Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>(
          ".workspace-menu-item",
        ) ?? [],
      ),
    [],
  );
  useEffect(() => {
    if (!open) return;
    if (focusOnOpen.current) {
      const options = items();
      (focusOnOpen.current === "first" ? options[0] : options.at(-1))?.focus();
      focusOnOpen.current = null;
    }
    const closeOutside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open, items]);
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        focusOnOpen.current = event.key === "ArrowDown" ? "first" : "last";
        setOpen(true);
        return;
      }
      const options = items();
      const index = options.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
            options.length;
      options[next]?.focus();
    } else if (open && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      const options = items();
      (event.key === "Home" ? options[0] : options.at(-1))?.focus();
    }
  };
  return (
    <div className="workspace-picker">
      <span className="workspace-picker-label">Workspace</span>
      <div className="workspace-picker-control" ref={root}>
        <button
          ref={trigger}
          type="button"
          className="workspace-picker-trigger dropdown-trigger"
          aria-label="Workspace"
          aria-describedby="workspace-picker-current"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? "workspace-picker-menu" : undefined}
          disabled={!workspaces.length && !operator}
          onClick={() => {
            if (open) setOpen(false);
            else {
              focusOnOpen.current = "first";
              setOpen(true);
            }
          }}
          onKeyDown={handleMenuKeyDown}
        >
          <span id="workspace-picker-current">{currentLabel}</span>
        </button>
        {open && (
          <div
            id="workspace-picker-menu"
            className="workspace-picker-menu dropdown-menu"
            role="menu"
            aria-label="Workspaces"
            onKeyDown={handleMenuKeyDown}
          >
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                className="workspace-menu-item dropdown-item"
                role="menuitemradio"
                aria-checked={workspace.id === chosen}
                data-workspace-id={workspace.id}
                onClick={() => {
                  setOpen(false);
                  onSelect(workspace.id);
                  trigger.current?.focus();
                }}
              >
                <span>{workspace.name}</span>
                {workspace.id === chosen && (
                  <span className="workspace-menu-check" aria-hidden="true">
                    <Check size={20} weight="Outline" color="currentColor" />
                  </span>
                )}
              </button>
            ))}
            {operator && (
              <button
                type="button"
                className="workspace-menu-item dropdown-item workspace-menu-create"
                role="menuitem"
                aria-label="New workspace"
                onClick={() => {
                  trigger.current?.focus();
                  setOpen(false);
                  onCreate();
                }}
              >
                New
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function Shell() {
  const [current, setCurrent] = useState<Session>();
  const [initialized, setInitialized] = useState<boolean>();
  const [setupActive, setSetupActive] = useState<boolean>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>(
    [],
  );
  const location = useLocation();
  const navigate = useNavigate();
  const [locationParams] = useSearchParams();
  const requestedWorkspace = locationParams.get("workspace");
  useEffect(() => {
    if (!current) return;
    const expire = () => {
      setCurrent(undefined);
      setWorkspace("");
      setWorkspaces([]);
      navigate("/admin", { replace: true });
    };
    sessionEvents.addEventListener("expired", expire);
    return () => sessionEvents.removeEventListener("expired", expire);
  }, [current, navigate]);
  useEffect(() => {
    if (
      requestedWorkspace &&
      workspaces.some((w) => w.id === requestedWorkspace)
    )
      setWorkspace(requestedWorkspace);
  }, [requestedWorkspace, workspaces]);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const status = await api<{ initialized: boolean }>("/api/setup/status");
      setInitialized(status.initialized);
      try {
        const s = await api<Session>("/api/admin/auth/session");
        const available = await api<{ id: string; name: string }[]>(
          "/api/admin/workspaces",
        );
        setCsrf(s.csrf);
        setWorkspaces(available);
        setCurrent(s);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401) throw e;
        setCurrent(undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void location.key;
    if (!current) return;
    void api<{ id: string; name: string }[]>("/api/admin/workspaces")
      .then(setWorkspaces)
      .catch(() => {});
  }, [current, location.key]);
  useEffect(() => {
    void location.key;
    if (!current?.admin.operator) {
      setSetupActive(undefined);
      return;
    }
    let live = true;
    void api<Pick<Progress, "active">>("/api/setup/progress")
      .then((progress) => {
        if (live) setSetupActive(progress.active);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [current, location.key]);
  const chosen = workspace || workspaces[0]?.id || "";
  const selectWorkspace = (id: string) => {
    setWorkspace(id);
    const params = new URLSearchParams(location.search);
    params.set("workspace", id);
    navigate(
      { pathname: location.pathname, search: params.toString() },
      { replace: true },
    );
  };
  const setupLayout = !!current && location.pathname === "/setup";
  const navigation: [string, string][] = [
    ["overview", "Overview"],
    ["members", "Groups & Members"],
    ["workflows", "Workflows"],
    ["skills", "Skills"],
    ["instructions", "Instructions"],
    ["threads", "Threads"],
    ["usage", "Usage"],
    ["audit", "Audit"],
    ["deletion", "Privacy"],
    ["settings", "Settings"],
  ];
  const operatorOnly = !!current?.admin.operator && !current.admin.telegramId;
  const visibleNavigation = operatorOnly
    ? navigation.filter(([path]) =>
        [
          "overview",
          "members",
          "workflows",
          "skills",
          "threads",
          "settings",
        ].includes(path),
      )
    : navigation;
  if (loading || error)
    return (
      <main className="app-loading">
        <div
          className="brand"
          role="status"
          aria-label={loading ? "Opening RepoDesk" : "RepoDesk"}
          aria-busy={loading}
        >
          <img
            className="brand-mark"
            src="/assets/repodesk-mark.svg"
            width="42"
            height="42"
            alt=""
          />
          <div>
            RepoDesk<span>GITHUB ASSISTANT</span>
          </div>
        </div>
        {error && (
          <section className="card">
            <Notice error>{error}</Notice>
            <button type="button" onClick={() => void load()}>
              Try again
            </button>
          </section>
        )}
      </main>
    );
  return (
    <div
      className={
        current && !setupLayout
          ? "layout"
          : `layout layout-auth${setupLayout ? " layout-setup" : ""}`
      }
    >
      <ApplicationUpdate session={current} request={api} />
      <Sidebar enabled={!!current && !setupLayout}>
        <div className="brand">
          <img
            className="brand-mark"
            src="/assets/repodesk-mark.svg"
            width="42"
            height="42"
            alt=""
          />
          <div>
            RepoDesk<span>GITHUB ASSISTANT</span>
          </div>
        </div>
        {current && !setupLayout ? (
          <>
            <WorkspacePicker
              workspaces={workspaces}
              chosen={chosen}
              operator={current.admin.operator}
              onSelect={selectWorkspace}
              onCreate={() => navigate("/setup?new=1&step=workspace")}
            />
            <nav>
              {chosen &&
                visibleNavigation
                  .filter(([path]) => path !== "settings")
                  .map(([path, label]) =>
                    path === "threads" &&
                    location.pathname.startsWith("/admin/runs/") ? (
                      <Link
                        key={path}
                        to="/admin/threads"
                        className="active"
                        aria-current="page"
                      >
                        {label}
                      </Link>
                    ) : (
                      <NavLink key={path} to={`/admin/${path}`}>
                        {label}
                      </NavLink>
                    ),
                  )}
              {chosen && current.admin.operator && (
                <NavLink to="/admin/plugins">Plugins</NavLink>
              )}
              {chosen && <NavLink to="/admin/settings">Settings</NavLink>}
              {current.admin.operator && (
                <>
                  <p className="nav-label">DEPLOYMENT</p>
                  <NavLink to="/admin/model">Model settings</NavLink>
                  <NavLink to="/admin/site">Site domain</NavLink>
                  {setupActive === false && (
                    <NavLink to="/setup">Setup</NavLink>
                  )}
                  <NavLink to="/admin/operations">Operations</NavLink>
                  <NavLink to="/admin/logs">Runtime logs</NavLink>
                </>
              )}
            </nav>
            <div className="account">
              <div className="account-identity">
                <small>
                  {current.admin.username}
                  {current.admin.telegramId && ` · ${current.admin.telegramId}`}
                </small>
                <Action
                  icon="logout"
                  onClick={async () => {
                    await api("/api/admin/auth/logout", "POST", {});
                    setCsrf("");
                    setCurrent(undefined);
                  }}
                >
                  Sign out
                </Action>
              </div>
              <ThemeSwitch />
            </div>
          </>
        ) : (
          <>
            <div className="auth-hero">
              <p className="auth-hero-kicker">A WORKSPACE FOR YOUR TEAM</p>
              <h2>Make room for better work.</h2>
              <p className="auth-hero-copy">
                Set up your assistant, connect Telegram, and choose how your
                team works with it.
              </p>
              <AuthNetwork />
            </div>
            <p className="auth-hero-footer">RepoDesk / Your deployment</p>
            {current && (
              <div className="account setup-account">
                <div className="account-identity">
                  <small>
                    {current.admin.username}
                    {current.admin.telegramId && " · Telegram linked"}
                  </small>
                  <Action
                    icon="logout"
                    onClick={async () => {
                      await api("/api/admin/auth/logout", "POST", {});
                      setCsrf("");
                      setCurrent(undefined);
                    }}
                  >
                    Sign out
                  </Action>
                </div>
                <ThemeSwitch />
              </div>
            )}
          </>
        )}
      </Sidebar>
      <main
        className={
          setupLayout ? "setup-main" : !current ? "auth-main" : undefined
        }
      >
        {!current ? (
          <Auth
            claim={!initialized}
            onDone={async () => {
              const session = await api<Session>("/api/admin/auth/session");
              const available = await api<{ id: string; name: string }[]>(
                "/api/admin/workspaces",
              );
              setCsrf(session.csrf);
              setInitialized(true);
              setWorkspaces(available);
              setCurrent(session);
              navigate(initialized ? "/admin" : "/setup", { replace: true });
            }}
          />
        ) : (
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route
              path="/admin/model"
              element={
                current.admin.operator ? (
                  <ModelSettings workspaceId={chosen} />
                ) : (
                  <Page title="Operator access required">
                    <p>Model settings are available to deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route path="/admin/operations" element={<Operations />} />
            <Route
              path="/admin/site"
              element={
                current.admin.operator ? (
                  <Page
                    title="Site domain"
                    description="Set the public address for this admin panel and its connected services."
                  >
                    <SiteDomain request={api} />
                  </Page>
                ) : (
                  <Page title="Operator access required">
                    <p>Site domains can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/plugins"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins key={chosen} request={api} workspaceId={chosen} />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/plugins/packages/:repositoryId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <PackageDetail
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      actor={current.admin.telegramId}
                    />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/plugins/file/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="installed"
                    />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/plugins/market/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="market"
                    />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/plugins/:pluginId"
              element={
                current.admin.operator ? (
                  chosen ? (
                    <Plugins
                      key={chosen}
                      request={api}
                      workspaceId={chosen}
                      view="installed"
                    />
                  ) : (
                    <Setup />
                  )
                ) : (
                  <Page title="Operator access required">
                    <p>Plugins can be managed by deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/logs"
              element={
                current.admin.operator ? (
                  <RuntimeLogs request={api} />
                ) : (
                  <Page title="Operator access required">
                    <p>Runtime logs are available to deployment operators.</p>
                  </Page>
                )
              }
            />
            <Route
              path="/admin/chats"
              element={
                <Navigate
                  to={`/admin/members?${locationParams.toString()}`}
                  replace
                />
              }
            />
            <Route
              path="/admin/access-policy"
              element={
                <Navigate
                  to={`/admin/members?${locationParams.toString()}`}
                  replace
                />
              }
            />
            <Route
              path="/admin/workflows/:workflowId"
              element={chosen ? <WorkflowDetailRoute id={chosen} /> : <Setup />}
            />
            <Route
              path="/admin/runs"
              element={
                <Navigate
                  to={`/admin/threads?${locationParams.toString()}`}
                  replace
                />
              }
            />
            <Route
              path="/admin/threads/:threadId"
              element={chosen ? <ThreadDetailRoute id={chosen} /> : <Setup />}
            />
            <Route
              path="/admin/runs/:runId"
              element={chosen ? <RunDetailRoute id={chosen} /> : <Setup />}
            />
            {visibleNavigation.map(([path]) => (
              <Route
                key={path}
                path={`/admin/${path}`}
                element={
                  chosen ? (
                    <WorkspacePage
                      key={`${chosen}:${path}`}
                      id={chosen}
                      resource={path ?? "overview"}
                      admin={current.admin}
                    />
                  ) : (
                    <Setup />
                  )
                }
              />
            ))}
            <Route
              path="*"
              element={
                chosen ? (
                  <WorkspacePage
                    id={chosen}
                    resource="overview"
                    admin={current.admin}
                  />
                ) : current.admin.operator ? (
                  <Setup />
                ) : (
                  <Page title="Link your Telegram identity">
                    <p>
                      Ask your deployment operator to enroll your Telegram ID
                      and issue an identity verification link for this account.
                    </p>
                  </Page>
                )
              }
            />
          </Routes>
        )}
      </main>
      {current && chosen && !setupLayout && (
        <SelfCheck
          key={`${current.admin.id}:${chosen}`}
          workspaceId={chosen}
          workspaceName={
            workspaces.find((w) => w.id === chosen)?.name ?? "Workspace"
          }
          request={api}
        />
      )}
    </div>
  );
}
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <BrowserRouter>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </BrowserRouter>,
  );
