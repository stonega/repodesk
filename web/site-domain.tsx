import { useEffect, useState } from "react";
import type { SiteView } from "../src/admin/site.ts";
import { Modal, ModalActions } from "./modal.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const endpoint = "/api/admin/operator/site";

export function SiteDomain({ request }: { request: Request }) {
  const [site, setSite] = useState<SiteView>();
  const [domain, setDomain] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    void reload;
    let live = true;
    setError("");
    request<SiteView>(endpoint)
      .then((value) => {
        if (live) setSite(value);
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [request, reload]);

  const save = async (value: string | null) => {
    if (!site || busy) return;
    setBusy(true);
    setFormError("");
    setMessage("");
    try {
      const saved = await request<SiteView>(endpoint, "PUT", {
        revision: site.revision,
        domain: value,
      });
      setSite(saved);
      setEditing(false);
      setMessage(
        "Site address saved. Sign in at the new address after DNS and HTTPS are ready.",
      );
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const preview = /^[a-z0-9.-]+\.[a-z]+$/i.test(domain.trim())
    ? domain.trim().toLowerCase()
    : "admin.example.com";

  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </p>
      )}
      {!site && !error && <p role="status">Loading site settings…</p>}
      {message && <p role="status">{message}</p>}
      {site && (
        <>
          <section className="card">
            <div className="row">
              <h2>Admin panel address</h2>
              <button
                type="button"
                onClick={() => {
                  setDomain(site.domain ?? "");
                  setFormError("");
                  setEditing(true);
                }}
              >
                {site.domain ? "Edit domain" : "Add custom domain"}
              </button>
            </div>
            <p>
              <a href={`${site.origin}/admin`} target="_blank" rel="noreferrer">
                {site.origin}
              </a>
            </p>
            <p className="muted">
              {site.domain
                ? "Custom domain configured. DNS and HTTPS availability are not verified by RepoDesk."
                : "Using the deployment’s default address."}
            </p>
            <p>
              Recovery address:{" "}
              <a
                href={`${site.fallbackOrigin}/admin`}
                target="_blank"
                rel="noreferrer"
              >
                {site.fallbackOrigin}
              </a>
              . Keep its existing routing available while changing domains.
            </p>
          </section>
          <section className="card site-domain-details">
            <h2>Connect your domain</h2>
            <ol>
              <li>
                In your DNS provider, point an A record to your server’s public
                IPv4 address. Add an AAAA record only if the server also accepts
                IPv6 traffic.
              </li>
              <li>
                Configure your server’s HTTPS reverse proxy to serve the domain
                and forward requests to RepoDesk. With host-installed Caddy and
                the default app port, use the configuration below. Adjust the
                port if you changed APP_PORT.
              </li>
              <li>
                Allow ports 80 and 443 to reach the proxy, then open the HTTPS
                address and sign in. Each domain needs its own sign-in.
              </li>
            </ol>
            <pre>
              <code>{`${site.domain ?? "admin.example.com"} {\n    reverse_proxy 127.0.0.1:3000\n}`}</code>
            </pre>
            <p>
              <a
                href="https://caddyserver.com/docs/quick-starts/reverse-proxy"
                target="_blank"
                rel="noreferrer"
              >
                Caddy HTTPS proxy guide
              </a>
            </p>
            <p className="muted">
              Saving a domain updates RepoDesk’s address immediately. DNS
              records, certificates and proxy configuration must be set up with
              your hosting provider or on your server.
            </p>
          </section>
          <section className="card site-domain-details">
            <h2>Update connected services</h2>
            <p>
              For an existing GitHub App, update its Homepage URL, Callback URL
              and Setup URL in GitHub before starting another connection.
              Changing domains cancels pending GitHub connections.
            </p>
            <dl>
              <dt>Homepage URL</dt>
              <dd>{site.origin}</dd>
              <dt>Callback URL</dt>
              <dd>{site.githubCallbackUrl}</dd>
              <dt>Setup URL</dt>
              <dd>{site.githubSetupUrl}</dd>
            </dl>
            {site.telegramTransport === "polling" ? (
              <p>Telegram uses polling. No webhook update is needed.</p>
            ) : (
              <>
                <p>
                  After the HTTPS address is reachable, register Telegram’s
                  webhook at the new address.
                </p>
                <dl>
                  <dt>Telegram webhook</dt>
                  <dd>{site.telegramWebhookUrl}</dd>
                  <dt>Status</dt>
                  <dd>
                    {site.webhookReady ? "Registered" : "Registration required"}
                  </dd>
                </dl>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await request("/api/setup/webhook", "POST", {});
                      setSite(await request<SiteView>(endpoint));
                      setMessage("Telegram webhook registered.");
                    } catch (error) {
                      setError((error as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "Working…" : "Register Telegram webhook"}
                </button>
              </>
            )}
          </section>
          {editing && (
            <Modal
              title={site.domain ? "Edit custom domain" : "Add custom domain"}
              busy={busy}
              onClose={() => setEditing(false)}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(domain);
                }}
              >
                <label className="field">
                  <span>Domain</span>
                  <input
                    required
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="admin.example.com"
                    value={domain}
                    disabled={busy}
                    onChange={(event) => setDomain(event.target.value)}
                  />
                </label>
                <p className="muted">
                  Enter a hostname without https://, a port or a path. This
                  address applies to every workspace in this deployment.
                </p>
                <p>
                  Point DNS to your server and configure HTTPS routing before
                  switching. For host-installed Caddy with the default app port:
                </p>
                <pre className="site-domain-preview">
                  <code>{`${preview} {\n    reverse_proxy 127.0.0.1:3000\n}`}</code>
                </pre>
                {formError && (
                  <p className="error" role="alert">
                    {formError}
                  </p>
                )}
                {formError.includes("version_conflict") && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        setSite(await request<SiteView>(endpoint));
                        setFormError("");
                      } catch (error) {
                        setFormError((error as Error).message);
                      }
                    }}
                  >
                    Reload current settings
                  </button>
                )}
                <ModalActions>
                  <button type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save domain"}
                  </button>
                </ModalActions>
                {site.domain && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void save(null)}
                  >
                    Use default address
                  </button>
                )}
              </form>
            </Modal>
          )}
        </>
      )}
    </>
  );
}
