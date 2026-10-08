export function GitHubAppBadge({ settingsUrl }: { settingsUrl?: string }) {
  return (
    <div className="github-app-badge">
      <img
        src="/assets/repodesk-github-app.png"
        width="64"
        height="64"
        alt="RepoDesk GitHub App icon"
      />
      <div>
        <h3>RepoDesk app icon</h3>
        <p className="muted">
          After creating the App, upload this icon under Display information in
          GitHub App settings, then choose Set new avatar.
        </p>
        <div className="row">
          <a
            href="/assets/repodesk-github-app.png"
            download="repodesk-github-app.png"
          >
            Download icon
          </a>
          {settingsUrl && (
            <a href={settingsUrl} target="_blank" rel="noopener noreferrer">
              Open GitHub App settings
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
