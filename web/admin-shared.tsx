import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import type {
  ModelCapabilities,
  ModelLimits,
  ModelOptions,
  ThinkingLevel,
} from "../src/agent/model-settings.ts";
import type { Settings } from "../src/domain.ts";
import { type ActionIcon, IconButton } from "./icon-button.tsx";
import { ModalPending } from "./modal.tsx";
import { Pagination } from "./pagination.tsx";

export function setCsrf(value: string) {
  csrf = value;
}

let csrf = "";
export const sessionEvents = new EventTarget();
export class ApiError extends Error {
  constructor(
    message: string,
    public issues: { path: string; message: string }[] = [],
    public status = 0,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && path !== "/api/admin/auth/login") {
    csrf = "";
    sessionEvents.dispatchEvent(new Event("expired"));
  }
  const data = await response.json().catch((error: unknown) => {
    if (signal?.aborted) throw error;
    throw new ApiError(
      response.status === 401
        ? path === "/api/admin/auth/login"
          ? "Invalid username or password."
          : "Your session expired. Sign in again."
        : [502, 503, 504].includes(response.status)
          ? path === "/api/admin/operator/model-providers" && method === "PUT"
            ? `Could not fetch models from this provider (HTTP ${response.status}). Check the API base URL and network access from the RepoDesk server, then try again.`
            : `The RepoDesk server is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`
          : `The RepoDesk server returned an unexpected response (HTTP ${response.status}). Reload the page and try again.`,
      [],
      response.status,
    );
  });
  const githubAccountError: Record<string, string> = {
    github_member_not_found:
      "GitHub could not find this account. Check the username and try again.",
    github_personal_account_required:
      "Enter a person's GitHub username, rather than an organization name.",
    github_identity_already_linked:
      "This GitHub account is already associated with another workspace member.",
    github_verified_account_requires_member_reconnect:
      "The member must change their verified account with /github connect in Telegram.",
  };
  if (!response.ok)
    throw new ApiError(
      (method === "PUT" &&
      path.includes("/workflows/") &&
      data.error === "owner_required"
        ? "Only the workflow owner can edit this schedule. Link the panel account to the owner's Telegram identity."
        : githubAccountError[data.error]) ??
        (data.error === "preset_skill_read_only"
          ? "Preset skills are read-only. Only enable and disable are available."
          : response.status === 409 && data.error === "version_conflict"
            ? `${data.error}. Reload the current version and review your changes before saving again.`
            : response.status === 401
              ? path === "/api/admin/auth/login"
                ? "Invalid username or password."
                : "Your session expired. Sign in again."
              : data.error === "setup_incomplete"
                ? "Finish bot credentials, model configuration and Telegram reception before activating."
                : data.error === "workspace_and_skill_required"
                  ? "Create a workspace with an enabled published skill before activating."
                  : data.error === "https_origin_required"
                    ? "Webhook mode requires a public HTTPS address. For local use, set TELEGRAM_TRANSPORT=polling and restart the app and worker."
                    : data.issues?.length
                      ? data.issues
                          .map((issue: { path: string; message: string }) =>
                            issue.path === "botToken"
                              ? issue.message
                              : `${issue.path}: ${issue.message}`,
                          )
                          .join(" ")
                      : (data.error ?? "Request failed")),
      data.issues ?? [],
      response.status,
    );
  return data;
}
export function useData<T>(
  path: string,
  load: (path: string) => Promise<T> = api,
) {
  const [params] = useSearchParams();
  const offset = params.get("offset") ?? "0";
  const resourcePath =
    /\/(runs|audit|workflows|skills|instructions|members|chats|usage)$/.test(
      path,
    )
      ? `${path}?offset=${Math.max(0, Number(offset) || 0)}`
      : path;
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    void revision; // Reload explicitly invalidates the fetched resource.
    let live = true;
    setLoading(true);
    setError("");
    load(resourcePath)
      .then((value) => {
        if (live) setData(value);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [resourcePath, revision, load]);
  return { data, error, reload, loading };
}
export function Pager({
  data,
  pageSize = 100,
  loading = false,
  alwaysShow = false,
}: {
  data: unknown;
  pageSize?: number;
  loading?: boolean;
  alwaysShow?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const total = (data as { total?: number } | undefined)?.total ?? 0;
  const rawOffset = Number(params.get("offset"));
  const offset =
    Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const goTo = (offset: number) => {
    const next = new URLSearchParams(params);
    next.set("offset", String(offset));
    setParams(next);
  };
  if (!alwaysShow && total <= pageSize && offset === 0) return null;
  return (
    <Pagination
      loading={loading}
      previousDisabled={offset === 0}
      nextDisabled={offset + pageSize >= total}
      onPrevious={() => goTo(Math.max(0, offset - pageSize))}
      onNext={() => goTo(offset + pageSize)}
    >
      {data
        ? `${total > offset ? offset + 1 : 0}–${total > offset ? Math.min(offset + pageSize, total) : 0} of ${total}`
        : "Page unavailable"}
    </Pagination>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p className="notice" role={error ? "alert" : "status"}>
      {children}
    </p>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Every Field receives a labelable input, textarea, or dropdown trigger as its child.
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Action({
  resetKey,
  children,
  icon,
  type = "button",
  onClick,
  danger = false,
  disabled = false,
  loading = false,
  onConflict,
  onError,
}: {
  resetKey?: unknown;
  children: string;
  icon?: ActionIcon;
  type?: "button" | "submit";
  onClick: () => Promise<unknown>;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onConflict?: () => void;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setModalPending = useContext(ModalPending);
  useEffect(() => {
    if (resetKey !== undefined) setError("");
  }, [resetKey]);
  const perform = async () => {
    if (busy || loading) return;
    setBusy(true);
    setModalPending?.(true);
    setError("");
    onError?.("");
    try {
      await onClick();
    } catch (e) {
      if (onError) onError((e as Error).message);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
      setModalPending?.(false);
    }
  };
  return (
    <span className="action">
      {icon ? (
        <IconButton
          icon={icon}
          label={children}
          className={danger ? "danger" : ""}
          disabled={disabled}
          busy={busy || loading}
          onClick={perform}
        />
      ) : (
        <button
          type={type}
          className={danger ? "danger" : ""}
          disabled={busy || loading || disabled}
          aria-busy={busy || loading}
          onClick={perform}
        >
          {busy || loading ? "Working…" : children}
        </button>
      )}
      {icon && (
        <span className="sr-only" aria-live="polite">
          {busy || loading ? `${children}: Working…` : ""}
        </span>
      )}
      {error && <Notice error>{error}</Notice>}
      {error.includes("version_conflict") && onConflict && (
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            onConflict();
            setError("");
          }}
        >
          Reload current version
        </button>
      )}
    </span>
  );
}
export function Page({
  title,
  titleBadge,
  description,
  actions,
  children,
}: {
  title: string;
  titleBadge?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">REPODESK / TEAM OPERATIONS</p>
        <div className="page-title-row">
          <div className="page-title">
            <h1>{title}</h1>
            {titleBadge && <span className="pill">{titleBadge}</span>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </>
  );
}

export interface Progress {
  version: number;
  active: boolean;
  bot?: { id: string; username: string; visibleAll: boolean };
  model: string;
  modelBaseUrl: string;
  thinkingLevel: ThinkingLevel;
  modelPricing?: ModelOptions["modelPricing"];
  modelLimits?: ModelLimits | null;
  modelCapabilities?: ModelCapabilities;
  webhookReady: boolean;
  telegramTransport: "webhook" | "polling";
  receiver: { ready: boolean; error?: string };
  paused: boolean;
  credentials: { bot: boolean; model: boolean };
  workspaces: {
    id: string;
    version: number;
    settings: Settings;
    ownerVerified: boolean;
    chatModelConfigured?: boolean;
    skills: {
      id: string;
      name: string;
      enabled: boolean;
      published: boolean;
    }[];
    deleted: boolean;
  }[];
}
