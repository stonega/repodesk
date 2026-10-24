import { useEffect, useState } from "react";
import { Modal, ModalActions } from "./modal.tsx";
import { ServiceUrl } from "./service-url.tsx";

type Request = <T>(
  path: string,
  method?: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<T>;
type LinkCommand = { command: string; expiresAt: string };

function explanation(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    bot_not_configured: "Connect your Telegram bot before linking a group.",
    one_group_per_workspace: "Unlink the current group before linking another.",
    access_denied:
      "You no longer have permission to link this workspace's group.",
  };
  return messages[code] ?? "Could not create a group-link command. Try again.";
}

export function GroupLinkDialog({
  id,
  request,
  linked,
  onClose,
}: {
  id: string;
  request: Request;
  linked: boolean;
  onClose: () => void;
}) {
  const [generation, setGeneration] = useState(0);
  const [data, setData] = useState<LinkCommand>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    void generation;
    const abort = new AbortController();
    setBusy(true);
    setError("");
    setData(undefined);
    request<LinkCommand>(
      `/api/admin/workspaces/${id}/chats/link-token`,
      "POST",
      {},
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) {
          setNow(Date.now());
          setData(value);
        }
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setError(explanation(error));
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [id, request, generation]);
  useEffect(() => {
    if (!data || linked) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data, linked]);
  const expired = !!data && Date.parse(data.expiresAt) <= now;
  return (
    <Modal
      title="Link a group"
      onClose={onClose}
      busy={busy}
      cancelLabel={linked ? "Close" : "Cancel"}
    >
      <div className="group-link-details">
        {linked ? (
          <p role="status">
            Group linked. You can now ask the bot in that group.
          </p>
        ) : (
          <>
            <p>
              Add your bot to the group, then copy and send this command there.
              Use an active workspace member account that is a Telegram group
              administrator. Personal Telegram identity verification is not
              required.
            </p>
            <p>
              Linking enables message collection by default. Received group
              messages, including those from people outside the workspace, can
              be used for group context and recaps. You can disable collection
              in the group’s Edit dialog. Telegram privacy settings still
              control which messages reach the bot; old history is unavailable.
            </p>
            <dl className="service-urls">
              <ServiceUrl
                key={data?.command ?? "pending"}
                label="Group-link command"
                value={expired ? undefined : data?.command}
                loading={busy}
                copyFailureText="Could not copy. Select the command to copy it manually."
              />
            </dl>
            {busy ? (
              <p className="muted" role="status">
                Generating command…
              </p>
            ) : expired ? (
              <p role="status">
                This command expired. Generate a new one below.
              </p>
            ) : data ? (
              <p className="muted">
                One use · Expires at{" "}
                {new Date(data.expiresAt).toLocaleTimeString()}. Generating
                another command invalidates the previous one. Wait for the bot's
                “Group linked” confirmation.
              </p>
            ) : null}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <ModalActions>
          {!linked && (
            <button
              type="button"
              className={data && !expired ? "secondary" : undefined}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setGeneration((current) => current + 1);
              }}
            >
              {error ? "Retry" : "Generate new command"}
            </button>
          )}
        </ModalActions>
      </div>
    </Modal>
  );
}
