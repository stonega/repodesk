import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptionPage } from "../src/transcription/config.ts";
import { PluginDetailHeading, PluginToggle } from "./plugin-detail.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const statusLabels = {
  not_downloaded: "Not downloaded",
  downloading: "Downloading model…",
  ready: "Ready",
  error: "Download failed",
  unavailable: "Runtime unavailable",
};
export function Transcription({
  request,
  workspaceId,
  backTo,
}: {
  request: Request;
  workspaceId: string;
  backTo: string;
}) {
  const endpoint = `/api/admin/workspaces/${workspaceId}/plugins/transcription`;
  const [data, setData] = useState<TranscriptionPage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  const notify = useToast();
  const load = useCallback(async () => {
    const own = ++sequence.current;
    try {
      const value = await request<TranscriptionPage>(endpoint);
      if (own !== sequence.current) return;
      setData(value);
      setError("");
    } catch {
      if (own === sequence.current)
        setError(
          "Could not load voice transcription settings. Check your connection and retry.",
        );
    }
  }, [endpoint, request]);
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (
      busy ||
      !data ||
      error ||
      !(
        data.status.state === "downloading" ||
        (data.settings.enabled && data.status.state === "not_downloaded")
      )
    )
      return;
    const timer = setTimeout(() => void load(), 3000);
    return () => clearTimeout(timer);
  }, [busy, data, error, load]);
  async function save(enabled: boolean, downloading = false) {
    if (!data || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    sequence.current++;
    try {
      const value = await request<TranscriptionPage>(
        downloading ? `${endpoint}/retry` : endpoint,
        downloading ? "POST" : "PUT",
        { revision: data.revision, enabled },
      );
      setData(value);
      if (value.status.state === "not_downloaded") void load();
      notify(
        downloading
          ? "Model download requested."
          : enabled
            ? "Voice transcription enabled. The model will download automatically."
            : "Voice transcription disabled.",
      );
    } catch (cause) {
      setError(
        (cause as Error).message.includes("version_conflict")
          ? "These settings changed in another session. Reload and try again."
          : "Could not save voice transcription settings. Retry when the connection is available.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const state = data?.status.state;
  return (
    <section className="transcription-page">
      <PluginDetailHeading title="Qwen3-ASR" backTo={backTo}>
        <PluginToggle
          name="Qwen3-ASR"
          enabled={data?.settings.enabled}
          disabled={busy || !data}
          loading={!data && !error}
          onChange={(enabled) => void save(enabled)}
        />
      </PluginDetailHeading>
      {error && (
        <ErrorToast message={error}>
          <button
            type="button"
            disabled={busy}
            aria-label="Reload voice transcription settings"
            onClick={() => void load()}
          >
            Retry
          </button>
        </ErrorToast>
      )}
      <section
        className="card transcription-card"
        aria-label="Voice transcription"
        aria-busy={!data || busy}
      >
        <h2>Voice transcription</h2>
        <p>
          Send a Telegram voice note or audio recording. RepoDesk transcribes it
          locally and uses the text in your conversation.
        </p>
        <dl className="transcription-summary">
          <div>
            <dt>Model</dt>
            <dd>Qwen3-ASR-0.6B</dd>
          </div>
          <div>
            <dt>Processing</dt>
            <dd>Local CPU · automatic language detection</dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>Two minutes · 5 MiB per recording</dd>
          </div>
          <div>
            <dt>Plugin</dt>
            <dd>
              {data ? (
                data.settings.enabled ? (
                  "Enabled"
                ) : (
                  "Disabled"
                )
              ) : (
                <Skeleton width="5rem" />
              )}
            </dd>
          </div>
        </dl>
        <p className="muted">
          In groups, reply to the bot or address it with a caption. Existing
          permissions and action approvals still apply.
        </p>
      </section>
      <section
        className="card transcription-card"
        aria-label="Transcription model"
      >
        <div className="plugin-card-heading">
          <h2>Model download</h2>
          {data?.settings.enabled &&
            ["error", "unavailable", "not_downloaded"].includes(
              state ?? "",
            ) && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void save(true, true)}
              >
                Retry download
              </button>
            )}
        </div>
        <p role="status">
          {state ? statusLabels[state] : <Skeleton width="9rem" />}
        </p>
        <p className="muted">
          Enabling the plugin downloads the model from Hugging Face. The first
          download may take several minutes. Cached model files are reused after
          restarts and kept when disabled.
        </p>
        {state === "downloading" && (
          <p>
            Voice transcription will be available when the download finishes.
          </p>
        )}
        {state === "error" && (
          <p>
            The download did not finish. Check server connectivity and available
            disk space, then retry.
          </p>
        )}
        {state === "unavailable" && (
          <p>
            The local runtime could not start. Use the updated RepoDesk image or
            follow the local runtime setup guide.
          </p>
        )}
      </section>
    </section>
  );
}
