import { useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { Modal } from "./modal.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function GitHubRegistration({
  request,
  endpoint,
  onError,
}: {
  request: Request;
  endpoint: string;
  onError: (error: unknown) => void;
}) {
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState("organization");
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState("DeepX Workspace Agent");
  const [isPublic, setPublic] = useState(false);
  return (
    <>
      <IconButton
        icon="add"
        label="Create GitHub App"
        onClick={() => {
          setOwner("organization");
          setOrganization("");
          setName("DeepX Workspace Agent");
          setPublic(false);
          setError("");
          setOpen(true);
        }}
      />
      {open && (
        <Modal
          title="Create GitHub App"
          busy={busy}
          onClose={() => setOpen(false)}
        >
          {error && (
            <p className="notice" role="alert">
              {error}
            </p>
          )}
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                const result = await request<{ url: string; manifest: object }>(
                  `${endpoint}/register`,
                  "POST",
                  {
                    owner,
                    name,
                    public: isPublic,
                    ...(owner === "organization" ? { organization } : {}),
                  },
                );
                const form = document.createElement("form");
                form.method = "post";
                form.action = result.url;
                const manifest = document.createElement("input");
                manifest.type = "hidden";
                manifest.name = "manifest";
                manifest.value = JSON.stringify(result.manifest);
                form.append(manifest);
                document.body.append(form);
                form.submit();
                form.remove();
              } catch (error) {
                setError((error as Error).message);
                onError(error);
                setBusy(false);
              }
            }}
          >
            <p>
              Confirm creation on GitHub with read-only repository access. Your
              App will be available to your workspaces; each workspace chooses
              its own repositories.
            </p>
            <fieldset disabled={busy} className="plugin-fields">
              <label className="field">
                <span>App name</span>
                <input
                  required
                  maxLength={34}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                <span>App owner</span>
                <select
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="organization">Organization</option>
                  <option value="personal">Personal account</option>
                </select>
              </label>
              {owner === "organization" && (
                <label className="field">
                  <span>GitHub organization</span>
                  <input
                    required
                    maxLength={39}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9-]*"
                    placeholder="deepxfinance"
                    value={organization}
                    onChange={(e) => setOrganization(e.target.value.trim())}
                  />
                </label>
              )}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={(e) => setPublic(e.target.checked)}
                />
                Allow installation on other GitHub accounts
              </label>
              <p className="muted">
                Leave unchecked for use only on the selected owner account.
                Enable it if a personally owned App needs access to an
                organization’s repositories.
              </p>
              <div className="row">
                <button type="submit">
                  {busy ? "Opening GitHub…" : "Continue to GitHub"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </>
  );
}
