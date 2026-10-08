import { useEffect, useState } from "react";
import type { SiteView } from "../src/admin/site.ts";
import { IconButton } from "./icon-button.tsx";
import { Modal, ModalActions } from "./modal.tsx";
import { Skeleton } from "./skeleton.tsx";
import { ErrorToast, useToast } from "./toast.tsx";

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const endpoint = "/api/admin/operator/site";

function ServiceUrl({
  label,
  value,
  loading,
}: {
  label: string;
  value?: string;
  loading: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (copyStatus !== "copied") return;
    const timer = setTimeout(() => setCopyStatus(null), 1000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  return (
    <div className="service-url">
      <dt>{label}</dt>
      <dd>
        <div className="service-url-value">
          {value ? (
            <code>{value}</code>
          ) : loading ? (
            <Skeleton width="20rem" />
          ) : (
            "—"
          )}
          <IconButton
            icon={copyStatus === "copied" ? "done" : "copy"}
            label={`${copyStatus === "copied" ? "Copied" : "Copy"} ${label}`}
            disabled={!value || copyStatus === "copied"}
            busy={copying}
            onClick={async () => {
              if (!value) return;
              setCopying(true);
              setCopyStatus(null);
              try {
                await navigator.clipboard.writeText(value);
                setCopyStatus("copied");
              } catch {
                setCopyStatus("failed");
              } finally {
                setCopying(false);
              }
            }}
          />
        </div>
        {copyStatus === "failed" && (
          <p className="error" role="alert">
            Could not copy. Select the URL to copy it manually.
          </p>
        )}
      </dd>
    </div>
  );
}

export function SiteDomain({ request }: { request: Request }) {
  const [site, setSite] = useState<SiteView>();
  const [domain, setDomain] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const notify = useToast();
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
    try {
      const saved = await request<SiteView>(endpoint, "PUT", {
        revision: site.revision,
        domain: value,
      });
      setSite(saved);
      setEditing(false);
      notify(
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
        <ErrorToast message={error}>
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </ErrorToast>
      )}
      <section className="card" aria-busy={!site && !error}>
        <div className="row">
          <h2>Admin panel address</h2>
          <button
            type="button"
            aria-label={site?.domain ? "Edit domain" : "Add custom domain"}
            disabled={!site}
            onClick={() => {
              if (!site) return;
              setDomain(site.domain ?? "");
              setFormError("");
              setEditing(true);
            }}
          >
            {site?.domain ? "Edit" : "New"}
          </button>
        </div>
        <p>
          {site ? (
            <a href={`${site.origin}/admin`} target="_blank" rel="noreferrer">
              {site.origin}
            </a>
          ) : error ? (
            "—"
          ) : (
            <Skeleton width="16rem" />
          )}
        </p>
        <p className="muted">
          {!site
            ? !error && <Skeleton width="24rem" />
            : site.domain
              ? "Custom domain configured. DNS and HTTPS availability are not verified by RepoDesk."
              : "Using the deployment’s default address."}
        </p>
        <p>
          Recovery address:{" "}
          {site ? (
            <a
              href={`${site.fallbackOrigin}/admin`}
              target="_blank"
              rel="noreferrer"
            >
              {site.fallbackOrigin}
            </a>
          ) : error ? (
            "—"
          ) : (
            <Skeleton width="16rem" />
          )}
          . Keep its existing routing available while changing domains.
        </p>
      </section>
      <section className="card site-domain-details">
        <h2>Connect your domain</h2>
        <ol>
          <li>
            In your DNS provider, point an A record to your server’s public IPv4
            address. Add an AAAA record only if the server also accepts IPv6
            traffic.
          </li>
          <li>
            Configure your server’s HTTPS reverse proxy to serve the domain and
            forward requests to RepoDesk. With host-installed Caddy and the
            default app port, use the configuration below. Adjust the port if
            you changed APP_PORT.
          </li>
          <li>
            Allow ports 80 and 443 to reach the proxy, then open the HTTPS
            address and sign in. Each domain needs its own sign-in.
          </li>
        </ol>
        <pre>
          <code>{`${site?.domain ?? "admin.example.com"} {\n    reverse_proxy 127.0.0.1:3000\n}`}</code>
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
          Saving a domain updates RepoDesk’s address immediately. DNS records,
          certificates and proxy configuration must be set up with your hosting
          provider or on your server.
        </p>
      </section>
      <section
        className="card connected-services"
        aria-labelledby="connected-services-title"
        aria-busy={!site && !error}
      >
        <h2 id="connected-services-title">Update connected services</h2>
        <section
          className="connected-service"
          aria-labelledby="github-service-title"
        >
          <h3 id="github-service-title">GitHub App</h3>
          <p className="muted">
            For an existing GitHub App, copy these URLs into its settings in
            GitHub before starting another connection.
          </p>
          <dl className="service-urls">
            {[
              { label: "Homepage URL", value: site?.origin },
              { label: "Callback URL", value: site?.githubCallbackUrl },
              { label: "Setup URL", value: site?.githubSetupUrl },
            ].map(({ label, value }) => (
              <ServiceUrl
                key={`${label}:${value ?? ""}`}
                label={label}
                value={value}
                loading={!site && !error}
              />
            ))}
          </dl>
          <p className="notice">
            Changing domains cancels pending GitHub connections.
          </p>
        </section>
        <section
          className="connected-service"
          aria-labelledby="telegram-service-title"
        >
          <h3 id="telegram-service-title">Telegram</h3>
          {!site ? (
            <p className="muted">
              {error ? (
                "Connection details unavailable."
              ) : (
                <Skeleton width="24rem" />
              )}
            </p>
          ) : site.telegramTransport === "polling" ? (
            <p className="muted">
              Telegram uses polling. No webhook update is needed.
            </p>
          ) : (
            <>
              <p className="muted">
                After the HTTPS address is reachable, register Telegram’s
                webhook at the new address.
              </p>
              <dl className="service-urls">
                <ServiceUrl
                  key={site.telegramWebhookUrl}
                  label="Telegram webhook"
                  value={site.telegramWebhookUrl}
                  loading={false}
                />
              </dl>
              <p className="muted">
                Status:{" "}
                {site.webhookReady ? "Registered" : "Registration required"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await request("/api/setup/webhook", "POST", {});
                    setSite(await request<SiteView>(endpoint));
                    notify("Telegram webhook registered.");
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
      </section>
      {editing && site && (
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
              Enter a hostname without https://, a port or a path. This address
              applies to every workspace in this deployment.
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
  );
}
