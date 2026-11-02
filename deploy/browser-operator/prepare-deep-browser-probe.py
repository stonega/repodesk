"""Copy the worker only for an isolated diagnostic process; retain no raw errors."""
from pathlib import Path
import sys
source=Path('src/browser/browser-host-worker.ts').read_text()
source=source.replace('error instanceof Fault ? error.code : "browser_execution_failed"', '''error instanceof Fault ? error.code : error instanceof Error && error.name === "TimeoutError" ? "browser_probe_timeout" : error instanceof Error && error.name === "ZodError" ? "browser_probe_checkpoint_schema" : error instanceof Error && /net::ERR_HTTP2_PROTOCOL_ERROR/.test(error.message) ? "browser_probe_http_two_protocol" : error instanceof Error && /net::ERR_CERT_/.test(error.message) ? "browser_probe_certificate" : error instanceof Error && /net::ERR_TUNNEL_CONNECTION_FAILED/.test(error.message) ? "browser_probe_tunnel" : error instanceof Error && /net::ERR_CONNECTION_RESET/.test(error.message) ? "browser_probe_connection_reset" : error instanceof Error && /net::ERR_ABORTED/.test(error.message) ? "browser_probe_aborted" : "browser_probe_unclassified"''')
# Keep relative imports rooted next to the original, without modifying it.
Path('src/browser/incident-diagnostic-worker.ts').write_text(source)
