const apis = [
  ["Google Docs API", "docs.googleapis.com"],
  ["Google Sheets API", "sheets.googleapis.com"],
  ["Google Drive API", "drive.googleapis.com"],
  ["Gmail API", "gmail.googleapis.com"],
  ["Google Search Console API", "searchconsole.googleapis.com"],
] as const;

export function GoogleApiGuide() {
  return (
    <section className="card google-summary-card" aria-label="Google API setup">
      <h2>Enable Google APIs</h2>
      <p>
        In Google Cloud, select the project that owns the Web application OAuth
        client saved above. Enable all five APIs in that same project:
      </p>
      <ul>
        {apis.map(([name, service]) => (
          <li key={service}>
            <a
              href={`https://console.cloud.google.com/apis/library/${service}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {name} ↗
            </a>
          </li>
        ))}
      </ul>
      <p>
        Open each link, check the selected project and choose{" "}
        <strong>Enable</strong> if shown. Google sign-in and consent do not
        enable these APIs.
      </p>
      <p className="muted">
        If your account is connected but a request fails with <code>403</code>{" "}
        and <code>SERVICE_DISABLED</code> or <code>accessNotConfigured</code>,
        enable the affected API, wait a few minutes, then retry your Gmail
        request or <code>/google properties</code> in Telegram. Reconnecting
        alone will not fix a disabled API.
      </p>
    </section>
  );
}
