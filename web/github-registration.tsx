import { useState } from "react";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { Select } from "./select.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function submitGitHubManifest(result: {
  url: string;
  manifest: object;
}) {
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
}
export function GitHubRegistration({
  request,
  endpoint,
  onError,
  source,
}: {
  request: Request;
  endpoint: string;
  onError: (error: unknown) => void;
  source?: "setup";
}) {
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState("personal");
  const [organization, setOrganization] = useState("");
  const [name, setName] = useState("RepoDesk");
  const [isPublic, setPublic] = useState(false);
  const openCreation = () => {
    setOwner("personal");
    setOrganization("");
    setName("RepoDesk");
    setPublic(false);
    setError("");
    setOpen(true);
  };
  return (
    <>
      {source === "setup" ? (
        <button
          type="button"
          aria-label="Create GitHub App"
          onClick={openCreation}
        >
          New
        </button>
      ) : (
        <IconButton
          icon="add"
          label="Create GitHub App"
          onClick={openCreation}
        />
      )}
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
                    ...(source ? { source } : {}),
                    ...(owner === "organization" ? { organization } : {}),
                  },
                );
                submitGitHubManifest(result);
              } catch (error) {
                setError((error as Error).message);
                onError(error);
                setBusy(false);
              }
            }}
          >
            <p>
              Confirm creation on GitHub with read and write access to
              repository code, issues and pull requests for coding tasks. The
              App also reads organization members for member account selection.
              It will be available to your workspaces; each workspace chooses
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
              <label className="field" htmlFor="github-app-owner">
                <span>App owner</span>
                <Select
                  id="github-app-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="organization">Organization</option>
                  <option value="personal">Personal account</option>
                </Select>
              </label>
              {owner === "organization" && (
                <label className="field">
                  <span>GitHub organization</span>
                  <input
                    required
                    maxLength={39}
                    pattern="[a-zA-Z0-9][a-zA-Z0-9-]*"
                    placeholder="your-org"
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
              <ModalActions>
                <button type="submit">
                  {busy ? "Opening GitHub…" : "Continue to GitHub"}
                </button>
              </ModalActions>
            </fieldset>
          </form>
        </Modal>
      )}
    </>
  );
}
